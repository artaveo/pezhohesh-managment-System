-- Step 20: a small copy of each member's photo, inside the database, so computers that work
-- straight on the server (which have no photo files) still see it. Tazkira scans stay files
-- on the hall computer and in its backups only.
ALTER TABLE member_documents ADD COLUMN thumb BYTEA;
ALTER TABLE member_documents ADD COLUMN thumb_mime TEXT;
