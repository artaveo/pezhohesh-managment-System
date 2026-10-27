-- Step 9: a member's photo (for the membership card) and tazkira scans. The files live in
-- %APPDATA%\Pezhohesh\files, named by their SHA-256, so the same file is never stored twice
-- and a backup can copy only the new ones. A member has at most one current file per kind;
-- replacing one keeps the old row (soft-deleted) for the audit log.
ALTER TABLE member_documents ADD COLUMN size_bytes INT NOT NULL DEFAULT 0;
ALTER TABLE member_documents ADD COLUMN created_by UUID REFERENCES app_users(id);
CREATE UNIQUE INDEX member_documents_one_per_kind
    ON member_documents (member_id, kind) WHERE deleted_at IS NULL AND kind <> 'other';
CREATE INDEX member_documents_sha_idx ON member_documents (sha256);
