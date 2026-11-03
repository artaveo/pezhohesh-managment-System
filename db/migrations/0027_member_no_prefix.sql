-- v1.0: who registered a member shows in the ID. A partner's new members get one digit in
-- front of the shared sequence: Rahimi 1, Naseri 2 (2511047), the manager none (511048).
-- The sequence is one for everyone: the next number is the highest sequence number held
-- (with or without a digit in front) plus one, so two people never get the same number and
-- the numbers stay in order. Members numbered in a laptop's old range (900001 and up) keep
-- their numbers and do not move the sequence.
ALTER TABLE app_users ADD COLUMN member_no_prefix SMALLINT CHECK (member_no_prefix BETWEEN 1 AND 9);
UPDATE app_users u SET member_no_prefix = CASE
        WHEN s.full_name ~ 'رحیم[یي]' OR u.username ILIKE '%rahimi%' THEN 1
        WHEN s.full_name ~ 'ناصر[یي]' OR u.username ILIKE '%naseri%' THEN 2
    END
FROM staff s
WHERE s.id = u.staff_id AND u.role = 'partner' AND u.member_no_prefix IS NULL
  AND (s.full_name ~ 'رحیم[یي]|ناصر[یي]' OR u.username ~* 'rahimi|naseri');

-- The sequence number of an ID: 2511047 -> 511047; IDs without a digit in front as they are.
CREATE OR REPLACE FUNCTION member_no_base(n INT) RETURNS INT
LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN n BETWEEN 1000000 AND 9999999 THEN n % 1000000 ELSE n END
$$;

-- The digit in front of the IDs the signed-in person gives (none for the manager).
CREATE OR REPLACE FUNCTION my_member_no_prefix() RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT member_no_prefix::INT FROM app_users WHERE id = NULLIF(current_setting('app.user_id', true), '')::uuid
$$;

-- Last sequence number held + 1, with this person's digit in front. A sequence number that
-- a member (any digit) or a person on the fingerprint device already has is stepped over.
CREATE OR REPLACE FUNCTION next_member_no() RETURNS INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH used AS (
        SELECT member_no_base(member_no) AS b FROM members WHERE no_freed_at IS NULL
        UNION SELECT member_no_base(no) FROM k50_device_ids
    ), start AS (
        SELECT COALESCE(max(member_no_base(member_no)), 0) + 1 AS first FROM members
        WHERE no_freed_at IS NULL AND member_no_base(member_no) < 900000
    )
    SELECT (COALESCE(my_member_no_prefix(), 0) * 1000000 + min(s))::INT
    FROM start, generate_series(start.first, 999999) s
    WHERE NOT EXISTS (SELECT 1 FROM used u WHERE u.b = s)
$$;
GRANT EXECUTE ON FUNCTION member_no_base(INT), my_member_no_prefix(), next_member_no() TO pz_partner, pz_manager;
