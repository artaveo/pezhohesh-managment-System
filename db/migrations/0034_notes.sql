-- «یادداشت‌ها»: side reckonings the partners keep apart from the books (a loan between
-- partners, money promised, a plan's figures). Nothing here is income, expense or a
-- withdrawal; no report reads this table. A note has free text and, if wanted, lines of
-- money (label, amount, in or out) whose total the page works out.
CREATE TABLE notes (
    id          UUID PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT,
    -- [{"label": "...", "amount": 1200, "out": false}, ...]
    lines       JSONB NOT NULL DEFAULT '[]',
    currency    TEXT NOT NULL DEFAULT 'AFN' CHECK (currency IN ('AFN', 'USD')),
    noted_on    DATE NOT NULL DEFAULT CURRENT_DATE,
    pinned      BOOLEAN NOT NULL DEFAULT false,
    created_by  UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE INDEX notes_live_idx ON notes (pinned DESC, noted_on DESC) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE, DELETE ON notes TO pz_partner;
GRANT SELECT, INSERT, UPDATE ON notes TO pz_manager;

CREATE TRIGGER notes_touch BEFORE UPDATE ON notes FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER notes_audit AFTER INSERT OR UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER notes_sync AFTER INSERT OR UPDATE OR DELETE ON notes FOR EACH ROW EXECUTE FUNCTION sync_capture('id');
