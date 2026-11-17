-- «یادداشت‌ها» for the manager too (the partners asked for it after 0036): the manager's
-- database role may read and write the notes again, and the section is ticked for the
-- manager where the partners already chose the manager's sections (they can untick it on
-- «کاربران»). Removing a note stays with the partners (soft delete is an UPDATE, so the
-- manager may do that too, as with other lines).
GRANT SELECT, INSERT, UPDATE ON notes TO pz_manager;

UPDATE settings
SET value = jsonb_set(value, '{manager}', (value -> 'manager') || '"notes"'::jsonb)
WHERE key = 'role_access'
  AND jsonb_typeof(value -> 'manager') = 'array'
  AND NOT (value -> 'manager') ? 'notes';
