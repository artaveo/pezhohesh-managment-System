-- Step 18: a member made in the app may get a number the K50 already gives someone else
-- (people added in ZKAccess who were never in the Excel book). The app now writes such an
-- ID only when the device does not have it, or has it under the same name, or a partner
-- says it is the same person; `claimed` records that. `device_read` is what the device
-- gave back for the dates. `k50_device_ids` is the device's user list from the last
-- compare, so new member numbers step over IDs already in use there.

ALTER TABLE k50_users ADD COLUMN claimed BOOLEAN, ADD COLUMN device_read JSONB;
UPDATE k50_users k SET claimed = true FROM members m
 WHERE m.id = k.member_id AND m.import_batch_id IS NOT NULL AND k.pushed_at IS NOT NULL;

CREATE TABLE k50_device_ids (
    no      INT PRIMARY KEY,
    name    TEXT,
    seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT ON k50_device_ids TO pz_partner, pz_manager;
