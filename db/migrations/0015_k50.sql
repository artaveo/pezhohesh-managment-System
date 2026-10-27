-- Step 17: the ZKTeco K50 at the door. Each member is a user on the device under their
-- member number, with the dates their seat is paid for; the device refuses a finger
-- outside them. The app works out what the device should hold from the memberships and
-- sends only what changed; this table is what it last sent.

CREATE TABLE k50_users (
    member_id      UUID PRIMARY KEY REFERENCES members(id),
    member_no      INT NOT NULL,
    pushed_name    TEXT,
    pushed_start   DATE,
    pushed_end     DATE,
    pushed_enabled BOOLEAN,
    pushed_at      TIMESTAMPTZ,
    -- The device took the start and end dates (some firmware only takes "enabled").
    valid_dates    BOOLEAN,
    fingers        INT,
    error          TEXT,
    error_at       TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER k50_users_touch BEFORE UPDATE ON k50_users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Finger punches read from the device (the table is from step 1).
ALTER TABLE attendance ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE attendance ADD COLUMN verify_mode INT, ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE INDEX attendance_member_idx ON attendance (member_id, punched_at DESC);
CREATE INDEX attendance_day_idx ON attendance (punched_at);

GRANT SELECT ON k50_users TO pz_partner, pz_manager;
