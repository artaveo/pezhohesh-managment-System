-- Pezhohesh — migration 0001: initial schema
-- PostgreSQL 16 locally + Neon in the cloud.
--
-- Rules that apply to every table:
--   * id is a UUID (v7, time-ordered) generated on the device that creates the row,
--     so the office laptop, the manager laptop and the PEC device can all work offline
--     without ever producing the same id.
--   * created_at / updated_at / deleted_at (soft delete) + device_id drive the two-way sync
--     with Neon: newest updated_at wins per row, deletes are never hard deletes.
--   * Dates are stored as Gregorian DATE; the app shows and accepts Solar Hijri
--     (Hamal..Hoot), exactly like the Excel file.
--   * Money is NUMERIC(14,2) with an explicit currency (AFN / USD). Never mixed in one column.
--   * Every insert/update/delete is written to audit_log by trigger.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE currency      AS ENUM ('AFN', 'USD');
CREATE TYPE department    AS ENUM ('hall', 'pec');           -- study hall / educational services
CREATE TYPE app_role      AS ENUM ('partner', 'manager', 'pec_staff');
CREATE TYPE plan_kind     AS ENUM ('monthly', 'daily', 'internet');
CREATE TYPE doc_kind      AS ENUM ('photo', 'tazkira_front', 'tazkira_back', 'other');
CREATE TYPE deposit_kind  AS ENUM ('cash', 'book');
CREATE TYPE sync_action   AS ENUM ('upsert_user', 'disable_user');
CREATE TYPE sync_status   AS ENUM ('pending', 'done', 'failed');

-- Shared columns, repeated in each table (kept explicit for readability):
--   id UUID PRIMARY KEY, created_at, updated_at, deleted_at, device_id

------------------------------------------------------------------------
-- 1. System: devices, users, people, settings, audit
------------------------------------------------------------------------

CREATE TABLE devices (
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,                 -- 'Office laptop', 'Manager laptop', 'PEC laptop'
    receipt_prefix TEXT NOT NULL UNIQUE,         -- 'H', 'M', 'P' -> bill numbers never collide offline
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE staff (                             -- partners, manager, Shams, PEC specialists...
    id            UUID PRIMARY KEY,
    full_name     TEXT NOT NULL,
    title         TEXT,                          -- 'Partner', 'Admin manager', 'Canteen', ...
    department    department,                    -- NULL = both
    monthly_salary NUMERIC(14,2) NOT NULL DEFAULT 0,
    salary_currency currency NOT NULL DEFAULT 'AFN',
    -- whose share the salary is deducted from (admin manager -> Rahimi); NULL = general expense
    salary_charged_to UUID REFERENCES staff(id),
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE app_users (
    id            UUID PRIMARY KEY,
    staff_id      UUID NOT NULL REFERENCES staff(id),
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,                 -- argon2id
    role          app_role NOT NULL,
    can_see_pec_finance BOOLEAN NOT NULL DEFAULT false,  -- partners may grant this to PEC staff
    theme_color   TEXT,                          -- personal accent color (#rrggbb); NULL = official green
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE partner_shares (                    -- default Naseri 1/3, Rahimi 2/3; changeable, dated
    id            UUID PRIMARY KEY,
    staff_id      UUID NOT NULL REFERENCES staff(id),
    share_numerator   INT NOT NULL,              -- 1  / 2
    share_denominator INT NOT NULL,              -- 3  / 3
    effective_from DATE NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE settings (                          -- key/value: pec_house_percent=30, contingency_percent=10, backup paths...
    key           TEXT PRIMARY KEY,
    value         JSONB NOT NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
    id            BIGSERIAL PRIMARY KEY,
    at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    user_id       UUID REFERENCES app_users(id),
    device_id     UUID REFERENCES devices(id),
    table_name    TEXT NOT NULL,
    row_id        UUID NOT NULL,
    action        TEXT NOT NULL,                 -- insert / update / delete
    before        JSONB,
    after         JSONB
);

------------------------------------------------------------------------
-- 2. Study hall: members, memberships, attendance
------------------------------------------------------------------------

CREATE TABLE members (
    id            UUID PRIMARY KEY,
    member_no     INT NOT NULL UNIQUE,           -- number printed on the card and stored in the K50
    first_name    TEXT NOT NULL,
    last_name     TEXT,
    father_name   TEXT,
    phone         TEXT,
    field_of_study TEXT,
    tazkira_no    TEXT,
    joined_on     DATE NOT NULL,
    notes         TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE INDEX members_name_idx  ON members (first_name, last_name);
CREATE INDEX members_phone_idx ON members (phone);

CREATE TABLE member_documents (                  -- photo + tazkira scans (files on disk, hash here)
    id            UUID PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id),
    kind          doc_kind NOT NULL,
    file_path     TEXT NOT NULL,                 -- relative to E:\Projects\Pezhohesh\files
    sha256        TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE plans (                             -- price list: monthly seat, daily seat, monthly internet
    id            UUID PRIMARY KEY,
    kind          plan_kind NOT NULL,
    name          TEXT NOT NULL,
    price         NUMERIC(14,2) NOT NULL,
    duration_days INT NOT NULL,                  -- 30 / 1 / 30
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE memberships (                       -- one row per paid period (replaces the 12 month columns)
    id            UUID PRIMARY KEY,
    member_id     UUID REFERENCES members(id),   -- NULL allowed for daily guests
    guest_name    TEXT,
    plan_id       UUID NOT NULL REFERENCES plans(id),
    start_date    DATE NOT NULL,
    end_date      DATE NOT NULL,
    fee           NUMERIC(14,2) NOT NULL,
    discount      NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_by    UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id),
    CHECK (member_id IS NOT NULL OR guest_name IS NOT NULL),
    CHECK (end_date >= start_date)
);
CREATE INDEX memberships_member_idx ON memberships (member_id, end_date);

CREATE TABLE attendance (                        -- read from the ZKTeco K50 over LAN
    id            UUID PRIMARY KEY,
    member_id     UUID REFERENCES members(id),
    device_user_no INT NOT NULL,                 -- = members.member_no
    punched_at    TIMESTAMPTZ NOT NULL,
    UNIQUE (device_user_no, punched_at)
);

CREATE TABLE fingerprint_sync_queue (            -- push member_no + start/end dates to the K50
    id            UUID PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id),
    action        sync_action NOT NULL,
    valid_from    DATE,
    valid_to      DATE,
    status        sync_status NOT NULL DEFAULT 'pending',
    attempts      INT NOT NULL DEFAULT 0,
    last_error    TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    done_at       TIMESTAMPTZ
);

------------------------------------------------------------------------
-- 3. Study hall: books and deposits
------------------------------------------------------------------------

CREATE TABLE books (
    id            UUID PRIMARY KEY,
    title         TEXT NOT NULL,
    author        TEXT,
    copies        INT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE book_loans (
    id            UUID PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id),
    book_id       UUID REFERENCES books(id),
    book_title    TEXT,                          -- for migrated rows with no book record
    loaned_on     DATE NOT NULL,
    due_on        DATE NOT NULL,
    returned_on   DATE,
    weekly_fee    NUMERIC(14,2) NOT NULL DEFAULT 0,
    fine          NUMERIC(14,2) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE loan_deposits (                     -- cash or a book left as guarantee; a liability, not income
    id            UUID PRIMARY KEY,
    member_id     UUID NOT NULL REFERENCES members(id),
    kind          deposit_kind NOT NULL,
    amount        NUMERIC(14,2),                 -- cash
    deposit_book  TEXT,                          -- book
    received_on   DATE NOT NULL,
    returned_on   DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

------------------------------------------------------------------------
-- 4. Study hall: internet hotspot cards
------------------------------------------------------------------------

CREATE TABLE hotspot_purchases (
    id            UUID PRIMARY KEY,
    purchased_on  DATE NOT NULL,
    supplier_bill_no TEXT,
    volume_gb     NUMERIC(8,2) NOT NULL,
    quantity      INT NOT NULL,
    unit_cost     NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE hotspot_sales (
    id            UUID PRIMARY KEY,
    sold_on       DATE NOT NULL,
    volume_gb     NUMERIC(8,2) NOT NULL,
    quantity      INT NOT NULL,
    unit_price    NUMERIC(14,2) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
-- profit = sales - cost of cards sold (average cost per volume), computed in a view.

------------------------------------------------------------------------
-- 5. PEC: clients, contracts, payments (dual currency)
------------------------------------------------------------------------

CREATE TABLE pec_clients (
    id            UUID PRIMARY KEY,
    full_name     TEXT NOT NULL,
    father_name   TEXT,
    phone         TEXT,
    email         TEXT,
    notes         TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE pec_services (                      -- admission, visa, translation, consulting...
    id            UUID PRIMARY KEY,
    name          TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE pec_contracts (
    id            UUID PRIMARY KEY,
    client_id     UUID NOT NULL REFERENCES pec_clients(id),
    service_id    UUID NOT NULL REFERENCES pec_services(id),
    destination_country TEXT,
    university    TEXT,
    total_afn     NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_usd     NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_afn  NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_usd  NUMERIC(14,2) NOT NULL DEFAULT 0,
    opened_on     DATE NOT NULL,
    closed_on     DATE,
    created_by    UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
-- remaining balance per currency = total - discount - sum(payments) : a view, never typed by hand.

------------------------------------------------------------------------
-- 6. Money in / money out (both departments)
------------------------------------------------------------------------

CREATE TABLE receipts (                          -- every printed bill/receipt; replaces handwritten bills
    id            UUID PRIMARY KEY,
    receipt_no    TEXT NOT NULL UNIQUE,          -- e.g. H-1405-000123 (device prefix + Solar year + counter)
    department    department NOT NULL,
    issued_on     DATE NOT NULL,
    amount        NUMERIC(14,2) NOT NULL,
    currency      currency NOT NULL DEFAULT 'AFN',
    -- what it pays for (exactly one of these, or none for misc income):
    membership_id UUID REFERENCES memberships(id),
    book_loan_id  UUID REFERENCES book_loans(id),
    hotspot_sale_id UUID REFERENCES hotspot_sales(id),
    pec_contract_id UUID REFERENCES pec_contracts(id),
    income_category TEXT NOT NULL,               -- monthly / daily / internet / books / hotspot / misc / pec
    description   TEXT,
    issued_by     UUID REFERENCES app_users(id),
    printed_count INT NOT NULL DEFAULT 0,
    voided        BOOLEAN NOT NULL DEFAULT false, -- a wrong bill is voided, never deleted
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE INDEX receipts_month_idx ON receipts (department, issued_on);

CREATE TABLE expense_categories (                -- rent, internet bill, electricity, water, canteen, repairs, seminars...
    id            UUID PRIMARY KEY,
    department    department NOT NULL,
    name          TEXT NOT NULL,
    is_fixed_monthly BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (department, name)
);

CREATE TABLE expenses (
    id            UUID PRIMARY KEY,
    department    department NOT NULL,
    category_id   UUID NOT NULL REFERENCES expense_categories(id),
    spent_on      DATE NOT NULL,
    description   TEXT,
    amount        NUMERIC(14,2) NOT NULL,
    currency      currency NOT NULL DEFAULT 'AFN',
    created_by    UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

CREATE TABLE salary_accruals (                   -- the FIXED monthly salary, posted once per month -> enters profit
    id            UUID PRIMARY KEY,
    staff_id      UUID NOT NULL REFERENCES staff(id),
    solar_year    INT NOT NULL,                  -- 1405
    solar_month   INT NOT NULL CHECK (solar_month BETWEEN 1 AND 12),
    amount        NUMERIC(14,2) NOT NULL,
    currency      currency NOT NULL DEFAULT 'AFN',
    UNIQUE (staff_id, solar_year, solar_month)
);

CREATE TABLE withdrawals (                       -- cash actually taken -> only the person's own account
    id            UUID PRIMARY KEY,
    staff_id      UUID NOT NULL REFERENCES staff(id),
    department    department NOT NULL,
    taken_on      DATE NOT NULL,
    amount        NUMERIC(14,2) NOT NULL,
    currency      currency NOT NULL DEFAULT 'AFN',
    note          TEXT,
    paid_by       UUID REFERENCES app_users(id), -- usually the manager
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);

------------------------------------------------------------------------
-- 7. Reports (views; sketched, full SQL comes with the build)
------------------------------------------------------------------------
-- v_member_status        : each member's current plan, end date, days left, owed months
-- v_hall_monthly         : income by category - expenses by category - salary accruals
--                          - 10% contingency = monthly balance B
-- v_partner_shares       : Naseri = (B + M)/3, Rahimi = 2(B + M)/3 - M  (M = admin manager salary),
--                          ratios read from partner_shares
-- v_pec_monthly          : PEC income - PEC expenses = net, per currency; house 30% split 2:1
-- v_person_balance       : per person: salary owed - withdrawals = running balance (year-end settlement)

------------------------------------------------------------------------
-- 8. Row-level security (outline)
------------------------------------------------------------------------
-- partner   : everything
-- manager   : everything with department = 'hall', all shares/withdrawals, PEC 30% figure;
--             no write on app_users, partner_shares, settings
-- pec_staff : department = 'pec' rows and pec_* tables only; no hall data, no partner shares;
--             PEC finance totals only if app_users.can_see_pec_finance

------------------------------------------------------------------------
-- 9. Receipt counters, updated_at and audit triggers
------------------------------------------------------------------------

CREATE TABLE receipt_counters (                  -- one running counter per device and Solar year
    device_id     UUID NOT NULL REFERENCES devices(id),
    solar_year    INT NOT NULL,
    last_no       INT NOT NULL DEFAULT 0,
    PRIMARY KEY (device_id, solar_year)
);

-- Returns the next bill number for a device, e.g. next_receipt_no(dev, 1405) -> 'H-1405-000124'
CREATE FUNCTION next_receipt_no(p_device UUID, p_year INT) RETURNS TEXT
LANGUAGE plpgsql AS $$
DECLARE v_no INT; v_prefix TEXT;
BEGIN
    SELECT receipt_prefix INTO v_prefix FROM devices WHERE id = p_device;
    IF v_prefix IS NULL THEN RAISE EXCEPTION 'unknown device %', p_device; END IF;
    INSERT INTO receipt_counters AS c (device_id, solar_year, last_no) VALUES (p_device, p_year, 1)
    ON CONFLICT (device_id, solar_year) DO UPDATE SET last_no = c.last_no + 1
    RETURNING last_no INTO v_no;
    RETURN v_prefix || '-' || p_year || '-' || lpad(v_no::TEXT, 6, '0');
END $$;

CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- The API sets these per request: SET LOCAL app.user_id = '...'; SET LOCAL app.device_id = '...';
CREATE FUNCTION write_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user UUID := nullif(current_setting('app.user_id', true), '')::UUID;
        v_dev  UUID := nullif(current_setting('app.device_id', true), '')::UUID;
BEGIN
    INSERT INTO audit_log (user_id, device_id, table_name, row_id, action, before, after)
    VALUES (v_user, v_dev, TG_TABLE_NAME,
            COALESCE(NEW.id, OLD.id), lower(TG_OP),
            CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END,
            CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END);
    RETURN COALESCE(NEW, OLD);
END $$;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'staff','app_users','partner_shares','members','member_documents','plans','memberships',
        'books','book_loans','loan_deposits','hotspot_purchases','hotspot_sales',
        'pec_clients','pec_services','pec_contracts','receipts','expenses','withdrawals']
    LOOP
        EXECUTE format('CREATE TRIGGER %I_touch BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION touch_updated_at()', t, t);
        EXECUTE format('CREATE TRIGGER %I_audit AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION write_audit()', t, t);
    END LOOP;
END $$;

------------------------------------------------------------------------
-- 10. Seed: official settings
------------------------------------------------------------------------
INSERT INTO settings (key, value) VALUES
    ('brand_color',          '"#76b82a"'),
    ('pec_house_percent',    '30'),
    ('contingency_percent',  '10');
