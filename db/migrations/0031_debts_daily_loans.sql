-- Debts of every kind, lending in the reading room, books out of reach, and a bill's two days.

-- A bill paying an old debt is printed today but its money belongs to the debt's month:
-- issued_on stays the day income counts on, billed_on the day on the paper (NULL: the same).
ALTER TABLE receipts
    ADD COLUMN billed_on DATE,
    ADD COLUMN debt_id UUID,
    -- What the person actually paid on this bill (a hotspot bill's amount is only the profit).
    ADD COLUMN debt_paid NUMERIC(14,2);

-- What someone owes that is not the rest of a membership period (those are in v_period_paid):
-- hotspot cards on credit, the unpaid part of a returned book's fee and fine, anything else.
CREATE TABLE member_debts (
    id              UUID PRIMARY KEY,
    member_id       UUID REFERENCES members(id),
    deposit_id      UUID REFERENCES loan_deposits(id),
    guest_name      TEXT,
    phone           TEXT,
    kind            TEXT NOT NULL CHECK (kind IN ('hotspot', 'books', 'other')),
    title           TEXT NOT NULL,
    owed_on         DATE NOT NULL,
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    paid            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (paid >= 0),
    income_category TEXT NOT NULL,
    -- The part of what is paid that is income: 1, or a hotspot card's profit over its price.
    income_share    NUMERIC(9,6) NOT NULL DEFAULT 1,
    book_loan_id    UUID REFERENCES book_loans(id),
    note            TEXT,
    created_by      UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id),
    CONSTRAINT member_debts_who CHECK (member_id IS NOT NULL OR deposit_id IS NOT NULL OR guest_name IS NOT NULL)
);
CREATE INDEX member_debts_member_idx ON member_debts (member_id) WHERE deleted_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON member_debts TO pz_partner;
GRANT SELECT, INSERT, UPDATE ON member_debts TO pz_manager;
CREATE TRIGGER member_debts_touch BEFORE UPDATE ON member_debts FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER member_debts_audit AFTER INSERT OR UPDATE OR DELETE ON member_debts FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER member_debts_sync AFTER INSERT OR UPDATE OR DELETE ON member_debts FOR EACH ROW EXECUTE FUNCTION sync_capture('id');
ALTER TABLE hotspot_sales ADD COLUMN debt_id UUID;

-- A loan is taken home for a weekly fee, or read in the hall the same day for free. A person
-- with no card or member record (an old loan on paper) is kept by name.
ALTER TABLE book_loans
    ADD COLUMN scope TEXT NOT NULL DEFAULT 'home' CHECK (scope IN ('home', 'hall')),
    ADD COLUMN borrower_name TEXT,
    ADD COLUMN borrower_phone TEXT,
    DROP CONSTRAINT book_loans_borrower,
    ADD CONSTRAINT book_loans_borrower CHECK (member_id IS NOT NULL OR deposit_id IS NOT NULL OR borrower_name IS NOT NULL);
CREATE INDEX book_loans_hall_idx ON book_loans (loaned_on DESC) WHERE scope = 'hall' AND deleted_at IS NULL;

CREATE OR REPLACE VIEW v_open_loans WITH (security_invoker = true) AS
SELECT l.id AS loan_id,
       COALESCE(d.code, m.member_no::text, '—') AS card_no,
       COALESCE(d.name, trim(m.first_name || ' ' || COALESCE(m.last_name, '')), l.borrower_name) AS member_name,
       COALESCE(d.phone, m.phone, l.borrower_phone) AS phone,
       COALESCE(b.title, l.book_title, '—') AS book_title,
       l.loaned_on, l.due_on,
       (l.due_on - current_date) AS days_left
FROM book_loans l
LEFT JOIN members m ON m.id = l.member_id
LEFT JOIN loan_deposits d ON d.id = l.deposit_id
LEFT JOIN books b ON b.id = l.book_id
WHERE l.deleted_at IS NULL AND l.returned_on IS NULL AND l.scope = 'home';

-- Copies of a book that are on the list but not on the shelf (lost, damaged, at the binder…).
CREATE TABLE book_unavailable (
    id          UUID PRIMARY KEY,
    book_id     UUID NOT NULL REFERENCES books(id),
    copies      INT NOT NULL DEFAULT 1 CHECK (copies > 0),
    reason      TEXT NOT NULL,
    note        TEXT,
    since       DATE NOT NULL,
    resolved_on DATE,
    created_by  UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE INDEX book_unavailable_book_idx ON book_unavailable (book_id) WHERE resolved_on IS NULL AND deleted_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON book_unavailable TO pz_partner;
GRANT SELECT, INSERT, UPDATE ON book_unavailable TO pz_manager;
CREATE TRIGGER book_unavailable_touch BEFORE UPDATE ON book_unavailable FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER book_unavailable_audit AFTER INSERT OR UPDATE OR DELETE ON book_unavailable FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER book_unavailable_sync AFTER INSERT OR UPDATE OR DELETE ON book_unavailable FOR EACH ROW EXECUTE FUNCTION sync_capture('id');

-- The fine goes by the started week now: 20 a week to read, 10 a week late (both editable).
INSERT INTO settings (key, value) VALUES ('book_fine_per_week', '10'), ('book_weekly_fee', '20')
ON CONFLICT (key) DO NOTHING;

-- Fingers taken off the device to make room. The copy stays here and goes back with a renewal.
ALTER TABLE k50_fingers ADD COLUMN removed_at TIMESTAMPTZ;
