-- Step 16: members send their photo and tazkira from their own phone. A QR code on the
-- laptop opens a small page over the office Wi-Fi (or the laptop's own hotspot), with no
-- internet. What arrives waits here until the desk looks at it and puts it on the right
-- member's file, so nobody can put a picture on someone else's record.

CREATE TABLE document_inbox (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    member_no     INT,                          -- as typed on the phone
    phone         TEXT,
    kind          doc_kind NOT NULL,
    file_path     TEXT NOT NULL,                -- in the files folder, like member_documents
    sha256        TEXT NOT NULL,
    mime_type     TEXT NOT NULL,
    size_bytes    INT NOT NULL,
    from_ip       TEXT,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    member_id     UUID REFERENCES members(id),  -- the member it was put on
    document_id   UUID REFERENCES member_documents(id),
    handled_by    UUID REFERENCES app_users(id),
    handled_at    TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX document_inbox_pending_idx ON document_inbox (received_at DESC) WHERE status = 'pending';

GRANT SELECT, UPDATE ON document_inbox TO pz_partner, pz_manager;

CREATE TRIGGER document_inbox_touch BEFORE UPDATE ON document_inbox FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER document_inbox_audit AFTER INSERT OR UPDATE OR DELETE ON document_inbox FOR EACH ROW EXECUTE FUNCTION write_audit();
