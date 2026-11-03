-- v1.0: the members list can show only those with no finger on the fingerprint device.
-- The fingers themselves stay partners-only (k50_fingers); this says only which member
-- numbers have at least one, from the app's copy of the device's fingers or from the last
-- look at the member on the device (k50_users.fingers). Both live on the computer that talks
-- to the device, so the answer is that computer's.
CREATE OR REPLACE FUNCTION k50_finger_nos() RETURNS SETOF INT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT ltrim(no, '0')::int FROM k50_fingers WHERE ltrim(no, '0') ~ '^[0-9]{1,9}$'
    UNION
    SELECT member_no FROM k50_users WHERE fingers > 0
$$;
REVOKE ALL ON FUNCTION k50_finger_nos() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION k50_finger_nos() TO pz_partner, pz_manager;
