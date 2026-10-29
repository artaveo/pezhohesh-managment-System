-- Step 3: bringing the Excel books in, and membership end dates worked out by the database.

-- One row per import run. Rows brought in by a run point back at it, so importing the
-- same year again replaces exactly those rows and nothing typed into the app.
CREATE TABLE import_batches (
    id           UUID PRIMARY KEY,
    source       TEXT NOT NULL,                 -- 'excel-hall'
    solar_year   INT NOT NULL,
    file_name    TEXT,
    file_sha256  TEXT NOT NULL,
    summary      JSONB NOT NULL DEFAULT '{}',
    imported_by  UUID REFERENCES app_users(id),
    imported_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    replaced_at  TIMESTAMPTZ                     -- set when a later run of the same year replaced it
);

ALTER TABLE members     ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
ALTER TABLE receipts    ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
ALTER TABLE expenses    ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
ALTER TABLE withdrawals ADD COLUMN import_batch_id UUID REFERENCES import_batches(id);
CREATE INDEX receipts_import_idx    ON receipts (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX expenses_import_idx    ON expenses (import_batch_id) WHERE import_batch_id IS NOT NULL;
CREATE INDEX withdrawals_import_idx ON withdrawals (import_batch_id) WHERE import_batch_id IS NOT NULL;

-- Expense lines in the same order as the Excel statement (محاسبات).
ALTER TABLE expense_categories ADD COLUMN sort_order INT NOT NULL DEFAULT 100;

GRANT SELECT, INSERT, UPDATE ON import_batches TO pz_partner;
GRANT SELECT ON import_batches TO pz_manager;

-- A membership needs only its start date: the end date follows from the plan
-- (30 days for monthly seats and internet, so 1 Aqrab -> 30 Aqrab). An end date
-- given explicitly is kept; changing the start or plan alone moves the end with it.
CREATE FUNCTION membership_end_date() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.end_date IS NULL
       OR (TG_OP = 'UPDATE' AND NEW.end_date IS NOT DISTINCT FROM OLD.end_date
           AND (NEW.start_date IS DISTINCT FROM OLD.start_date OR NEW.plan_id IS DISTINCT FROM OLD.plan_id)) THEN
        NEW.end_date := NEW.start_date + (SELECT duration_days FROM plans WHERE id = NEW.plan_id) - 1;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER memberships_end_date BEFORE INSERT OR UPDATE ON memberships
    FOR EACH ROW EXECUTE FUNCTION membership_end_date();
