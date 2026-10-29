-- The library's catalogue, as in the book list (لیست کتابها): every title has a code
-- (its section's number and its own, 553-001), a shelf (A1), an author and the number of
-- copies, and belongs to a section (رمان، کودک…). Two sections may share a number (400 is
-- «موفقیت و روانشناسی» and «انگلیسی»), so a code is unique within its section only.
-- A loan names the catalogue book when it was lent from the list (book_loans.book_id).
CREATE TABLE book_sections (
    id          UUID PRIMARY KEY,
    code        TEXT NOT NULL,
    name        TEXT NOT NULL,
    sort_order  INT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE UNIQUE INDEX book_sections_name_idx ON book_sections (lower(name)) WHERE deleted_at IS NULL;

ALTER TABLE books
    ADD COLUMN section_id UUID REFERENCES book_sections(id),
    ADD COLUMN code       TEXT,
    ADD COLUMN shelf      TEXT,
    ADD COLUMN note       TEXT;
CREATE UNIQUE INDEX books_code_idx ON books (section_id, code) WHERE deleted_at IS NULL AND code IS NOT NULL;
CREATE INDEX books_section_idx ON books (section_id);
CREATE INDEX book_loans_book_idx ON book_loans (book_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON book_sections TO pz_partner;
GRANT SELECT, INSERT, UPDATE ON book_sections TO pz_manager;

CREATE TRIGGER book_sections_touch BEFORE UPDATE ON book_sections FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER book_sections_audit AFTER INSERT OR UPDATE OR DELETE ON book_sections FOR EACH ROW EXECUTE FUNCTION write_audit();
CREATE TRIGGER book_sections_sync AFTER INSERT OR UPDATE OR DELETE ON book_sections FOR EACH ROW EXECUTE FUNCTION sync_capture('id');
