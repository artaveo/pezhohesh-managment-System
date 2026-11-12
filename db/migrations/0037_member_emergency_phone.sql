-- A second number for a member: a relative to call in an emergency. Members from before stay
-- empty until it is filled in; a new member must have it (checked by the API, not here, so
-- the old rows and the Excel import keep working).
ALTER TABLE members ADD COLUMN emergency_phone TEXT;
