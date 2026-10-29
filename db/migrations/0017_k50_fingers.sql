-- v0.19: the app's own copy of every finger stored on the fingerprint device, so a member
-- the device loses (a reset, a ZKAccess "sync to device") gets their fingers back without
-- coming in to enrol again, and ZKAccess's database is not the only other copy.
-- One row per device user number and finger; a finger that disappears from the device is
-- kept here. Not copied online (see online.rs): fingerprints stay on the office laptop.
CREATE TABLE k50_fingers (
    no        TEXT NOT NULL,
    finger    INT NOT NULL CHECK (finger BETWEEN 0 AND 9),
    flag      INT NOT NULL DEFAULT 1,
    template  TEXT NOT NULL,
    read_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (no, finger)
);
GRANT SELECT ON k50_fingers TO pz_partner;
