-- The server had grown to 384 MB for some 40 MB of data. Two reasons:
--  1. Every Excel import marked all of the year's rows deleted and wrote them all again
--     (about 1,500 a time, 21 times): 31,700 bills where 1,537 count.
--  2. «چه کسی چه کرد» kept the whole row before and after each change, and every one of those
--     rows; the sync queue kept every change too.
-- From now on an import writes only what changed (import_excel.rs), a change keeps only the
-- fields that changed (plus the few that name the row), and bulk work writes one line.
-- Here the old copies go. Every computer runs this itself, so nothing of it is sent on.

CREATE OR REPLACE FUNCTION write_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_user UUID := nullif(current_setting('app.user_id', true), '')::UUID;
        v_dev  UUID := nullif(current_setting('app.device_id', true), '')::UUID;
        b JSONB;
        a JSONB;
        -- Kept on every change, so a line still says what it was about.
        names TEXT[] := ARRAY['member_id', 'member_no', 'first_name', 'last_name', 'full_name', 'name', 'title',
                              'receipt_no', 'code', 'book_title', 'amount', 'staff_id', 'deleted_reason', 'void_reason'];
BEGIN
    -- An import or a cleanup writes its own single line instead.
    IF current_setting('pezhohesh.bulk', true) = 'on' THEN
        RETURN COALESCE(NEW, OLD);
    END IF;
    IF TG_OP = 'UPDATE' THEN
        SELECT jsonb_object_agg(o.key, o.value) FILTER (WHERE o.value IS DISTINCT FROM n.value OR o.key = ANY(names)),
               jsonb_object_agg(n.key, n.value) FILTER (WHERE o.value IS DISTINCT FROM n.value OR o.key = ANY(names)),
               count(*) FILTER (WHERE o.value IS DISTINCT FROM n.value AND o.key <> 'updated_at')
          INTO b, a
          FROM jsonb_each(to_jsonb(OLD)) o JOIN jsonb_each(to_jsonb(NEW)) n USING (key);
        -- Nothing changed but the time stamp.
        IF NOT EXISTS (SELECT 1 FROM jsonb_each(to_jsonb(OLD)) o JOIN jsonb_each(to_jsonb(NEW)) n USING (key)
                       WHERE o.value IS DISTINCT FROM n.value AND o.key <> 'updated_at') THEN
            RETURN NEW;
        END IF;
    ELSIF TG_OP = 'INSERT' THEN
        a := to_jsonb(NEW);
    ELSE
        b := to_jsonb(OLD);
    END IF;
    INSERT INTO audit_log (user_id, device_id, table_name, row_id, action, before, after)
    VALUES (v_user, v_dev, TG_TABLE_NAME, COALESCE(NEW.id, OLD.id), lower(TG_OP), b, a);
    RETURN COALESCE(NEW, OLD);
END $$;
-- CREATE OR REPLACE drops these: the app's roles may not write audit_log themselves (0002).
ALTER FUNCTION write_audit() SECURITY DEFINER SET search_path = public;

SET LOCAL pezhohesh.applying = 'on';
SET LOCAL pezhohesh.bulk = 'on';

-- The rows of replaced imports (already marked deleted, counted nowhere).
CREATE TEMP TABLE old_batches ON COMMIT DROP AS SELECT id FROM import_batches WHERE replaced_at IS NOT NULL;
DELETE FROM hotspot_sales WHERE import_batch_id IN (SELECT id FROM old_batches);
DELETE FROM hotspot_purchases WHERE import_batch_id IN (SELECT id FROM old_batches);
DELETE FROM hotspot_buys WHERE import_batch_id IN (SELECT id FROM old_batches);
DELETE FROM receipts r WHERE r.import_batch_id IN (SELECT id FROM old_batches)
    AND NOT EXISTS (SELECT 1 FROM hotspot_sales s WHERE s.receipt_id = r.id);
DELETE FROM expenses WHERE import_batch_id IN (SELECT id FROM old_batches);
DELETE FROM withdrawals WHERE import_batch_id IN (SELECT id FROM old_batches);

-- Their trail: the log lines and queued changes of rows written by an import.
DELETE FROM audit_log
WHERE table_name IN ('receipts', 'expenses', 'withdrawals', 'hotspot_sales', 'hotspot_purchases', 'hotspot_buys', 'members')
  AND (after ->> 'import_batch_id' IS NOT NULL OR before ->> 'import_batch_id' IS NOT NULL);
DELETE FROM sync_log
WHERE tbl IN ('receipts', 'expenses', 'withdrawals', 'hotspot_sales', 'hotspot_purchases', 'hotspot_buys')
  AND row ->> 'import_batch_id' IN (SELECT id::text FROM old_batches);

-- A punch dated in the future (2119-04-17 on the device) stopped all reading after it.
DELETE FROM attendance WHERE punched_at > now() + interval '1 day';

-- Photos no longer go to the main server: the small copies kept there are dropped. The
-- files themselves go to the file server (files.rs); this marks which are there.
UPDATE member_documents SET thumb = NULL, thumb_mime = NULL WHERE thumb IS NOT NULL;
ALTER TABLE member_documents ADD COLUMN remote_at TIMESTAMPTZ;
