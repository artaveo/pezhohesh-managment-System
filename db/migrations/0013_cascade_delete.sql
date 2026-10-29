-- Step 15: removing things the standard way. Nothing is erased: a removal sets deleted_at
-- (soft delete) with the reason, the audit log keeps who did it and what the row was, and a
-- partner can bring it back. Money received is never removed: a bill is voided, and it stays
-- in the books even when its member is removed.
--
-- Removing a member removes their periods and documents with them, by trigger, all marked
-- with one delete_batch, so bringing the member back brings back exactly those rows and not
-- a period that was removed on its own before. A member who still has a book or a guarantee
-- out cannot be removed (the book must come back first), as in library systems such as Koha.

ALTER TABLE members          ADD COLUMN delete_batch UUID, ADD COLUMN deleted_reason TEXT;
ALTER TABLE memberships      ADD COLUMN delete_batch UUID, ADD COLUMN deleted_reason TEXT;
ALTER TABLE member_documents ADD COLUMN delete_batch UUID;
ALTER TABLE expenses         ADD COLUMN deleted_reason TEXT;
ALTER TABLE withdrawals      ADD COLUMN deleted_reason TEXT;

CREATE FUNCTION members_before_remove() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        IF EXISTS (SELECT 1 FROM book_loans WHERE member_id = NEW.id AND returned_on IS NULL AND deleted_at IS NULL)
           OR EXISTS (SELECT 1 FROM loan_deposits WHERE member_id = NEW.id AND returned_on IS NULL AND deleted_at IS NULL) THEN
            RAISE EXCEPTION 'member_has_open_loans';
        END IF;
        NEW.delete_batch := COALESCE(NEW.delete_batch, gen_random_uuid());
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        NEW.delete_batch := NULL;
        NEW.deleted_reason := NULL;
    END IF;
    RETURN NEW;
END $$;

CREATE FUNCTION members_cascade() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
        UPDATE memberships SET deleted_at = NEW.deleted_at, delete_batch = NEW.delete_batch, deleted_reason = NEW.deleted_reason
            WHERE member_id = NEW.id AND deleted_at IS NULL;
        UPDATE member_documents SET deleted_at = NEW.deleted_at, delete_batch = NEW.delete_batch
            WHERE member_id = NEW.id AND deleted_at IS NULL;
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL AND OLD.delete_batch IS NOT NULL THEN
        UPDATE memberships SET deleted_at = NULL, delete_batch = NULL, deleted_reason = NULL
            WHERE member_id = NEW.id AND delete_batch = OLD.delete_batch;
        UPDATE member_documents SET deleted_at = NULL, delete_batch = NULL
            WHERE member_id = NEW.id AND delete_batch = OLD.delete_batch;
    END IF;
    RETURN NULL;
END $$;

CREATE TRIGGER members_before_remove BEFORE UPDATE OF deleted_at ON members
    FOR EACH ROW EXECUTE FUNCTION members_before_remove();
CREATE TRIGGER members_cascade AFTER UPDATE OF deleted_at ON members
    FOR EACH ROW EXECUTE FUNCTION members_cascade();

-- Tables that had no audit trail yet but hold figures people change.
CREATE TRIGGER expense_categories_audit AFTER INSERT OR UPDATE OR DELETE ON expense_categories FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER salary_accruals_audit AFTER INSERT OR UPDATE OR DELETE ON salary_accruals FOR EACH ROW EXECUTE FUNCTION write_audit();

-- The «چه کسی چه کرد» page reads newest first, often for one table or one row.
CREATE INDEX audit_log_at_idx ON audit_log (at DESC, id DESC);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);
