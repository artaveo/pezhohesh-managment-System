-- Step 24: the number of a removed member can go to someone new. While the fingerprint
-- device still holds the old person under it (fingers and dates) the number stays theirs.
-- Removing a member can ask for the number to be freed (`free_no`); the hall computer then
-- removes that user from the device with every finger, and `no_freed_at` marks the number
-- as given up. A number the device no longer has at all is freed the same way. Only
-- numbers not given up have to be unique.

ALTER TABLE members ADD COLUMN free_no BOOLEAN NOT NULL DEFAULT false,
                    ADD COLUMN no_freed_at TIMESTAMPTZ;
ALTER TABLE members DROP CONSTRAINT members_member_no_key;
CREATE UNIQUE INDEX members_member_no_key ON members (member_no) WHERE no_freed_at IS NULL;

-- A member brought back takes their number again; that fails while someone new has it.
CREATE FUNCTION members_keep_no() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
        NEW.free_no := false;
        NEW.no_freed_at := NULL;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER members_keep_no BEFORE UPDATE OF deleted_at ON members
    FOR EACH ROW EXECUTE FUNCTION members_keep_no();

-- The next number for this computer: a freed number first (lowest), when no member holds
-- it again and the device (as read last) does not have it; otherwise one past the highest
-- number held, stepping over the device's IDs and other computers' ranges as before.
-- Gaps that were never freed stay unused: the device may still hold someone under them.
CREATE OR REPLACE FUNCTION next_member_no() RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH me AS (
        SELECT COALESCE(d.member_no_from, 1) AS lo, COALESCE(d.member_no_to, 2147483647) AS hi,
               d.member_no_from IS NULL AS free
        FROM (SELECT current_device() AS id) c LEFT JOIN devices d ON d.id = c.id
    ), others AS (
        SELECT member_no_from AS lo, member_no_to AS hi FROM devices
        WHERE member_no_from IS NOT NULL AND id IS DISTINCT FROM current_device()
    ), freed AS (
        SELECT min(m.member_no) AS n FROM members m, me
        WHERE m.no_freed_at IS NOT NULL AND m.member_no BETWEEN me.lo AND me.hi
          AND NOT EXISTS (SELECT 1 FROM members x WHERE x.member_no = m.member_no AND x.no_freed_at IS NULL)
          AND NOT EXISTS (SELECT 1 FROM k50_device_ids k WHERE k.no = m.member_no)
          AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE m.member_no BETWEEN o.lo AND o.hi))
    ), start AS (
        SELECT COALESCE(max(m.member_no), me.lo - 1) + 1 AS first FROM me
        LEFT JOIN members m ON m.member_no BETWEEN me.lo AND me.hi AND m.no_freed_at IS NULL
             AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE m.member_no BETWEEN o.lo AND o.hi))
        GROUP BY me.lo
    )
    SELECT COALESCE((SELECT n FROM freed), (
        SELECT min(n)::INT FROM me, start s, generate_series(s.first, LEAST(me.hi::BIGINT, s.first + 100000)) n
        WHERE NOT EXISTS (SELECT 1 FROM k50_device_ids k WHERE k.no = n)
          AND NOT (me.free AND EXISTS (SELECT 1 FROM others o WHERE n BETWEEN o.lo AND o.hi))
    ))
$$;
