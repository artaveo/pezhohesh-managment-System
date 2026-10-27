-- Step 5: lending books. Like the Excel book's lending list, a borrower first leaves a
-- guarantee: cash (p-101), books (k-101) or a person who vouches (z-101). The guarantee
-- is the lending card; a study-hall member may borrow on their membership instead.
-- A guarantee is money held, not income; the weekly fee and the late fine are income
-- and get a bill when the book comes back.

ALTER TYPE deposit_kind ADD VALUE IF NOT EXISTS 'person';

ALTER TABLE loan_deposits
    ALTER COLUMN member_id DROP NOT NULL,
    ADD COLUMN code        TEXT,
    ADD COLUMN name        TEXT,
    ADD COLUMN father_name TEXT,
    ADD COLUMN phone       TEXT,
    ADD COLUMN guarantor   TEXT,      -- a person's guarantee: who vouches
    ADD COLUMN note        TEXT,
    ADD COLUMN returned_by UUID REFERENCES app_users(id);

-- Rows typed before this step belonged to a member.
UPDATE loan_deposits d
SET name = trim(m.first_name || ' ' || COALESCE(m.last_name, '')), father_name = m.father_name, phone = m.phone
FROM members m WHERE m.id = d.member_id AND d.name IS NULL;
UPDATE loan_deposits d
SET code = CASE d.kind::text WHEN 'cash' THEN 'p-' WHEN 'book' THEN 'k-' ELSE 'z-' END || (100 + n.rn)
FROM (SELECT id, row_number() OVER (PARTITION BY kind ORDER BY received_on, created_at) AS rn FROM loan_deposits) n
WHERE n.id = d.id AND d.code IS NULL;
ALTER TABLE loan_deposits
    ALTER COLUMN code SET NOT NULL,
    ALTER COLUMN name SET NOT NULL;
CREATE UNIQUE INDEX loan_deposits_code_key ON loan_deposits (lower(code)) WHERE deleted_at IS NULL;

ALTER TABLE book_loans
    ALTER COLUMN member_id DROP NOT NULL,
    ADD COLUMN deposit_id  UUID REFERENCES loan_deposits(id),
    ADD COLUMN fee_paid    NUMERIC(14,2) NOT NULL DEFAULT 0,
    ADD COLUMN returned_by UUID REFERENCES app_users(id),
    ADD COLUMN note        TEXT,
    ADD CONSTRAINT book_loans_borrower CHECK (member_id IS NOT NULL OR deposit_id IS NOT NULL);
CREATE INDEX book_loans_open_idx ON book_loans (due_on) WHERE returned_on IS NULL AND deleted_at IS NULL;
CREATE INDEX book_loans_deposit_idx ON book_loans (deposit_id);

-- The lending rules, changed by partners on the prices page.
INSERT INTO settings (key, value) VALUES
    ('book_loan_days',    '14'),
    ('book_weekly_fee',   '20'),
    ('book_fine_per_day', '0')
ON CONFLICT (key) DO NOTHING;

-- Open loans with whoever borrowed: a member (by number) or a guarantee (by its code).
DROP VIEW v_open_loans;
CREATE VIEW v_open_loans WITH (security_invoker = true) AS
SELECT l.id AS loan_id,
       COALESCE(d.code, m.member_no::text) AS card_no,
       COALESCE(d.name, trim(m.first_name || ' ' || COALESCE(m.last_name, ''))) AS member_name,
       COALESCE(d.phone, m.phone) AS phone,
       COALESCE(b.title, l.book_title, '—') AS book_title,
       l.loaned_on, l.due_on,
       (l.due_on - current_date) AS days_left
FROM book_loans l
LEFT JOIN members m ON m.id = l.member_id
LEFT JOIN loan_deposits d ON d.id = l.deposit_id
LEFT JOIN books b ON b.id = l.book_id
WHERE l.deleted_at IS NULL AND l.returned_on IS NULL;
GRANT SELECT ON v_open_loans TO pz_partner, pz_manager;
