-- A partner's word that the device user under this number, with this name, is the member
-- with that number, when the names are written too differently to match on their own
-- ("Abdulrashid" for «عبدالرشید رحیمی» is matched; a nickname is not). If the name on
-- the device changes, the word no longer counts. Local to the hall computer, like the
-- other fingerprint tables: no sync trigger.
CREATE TABLE k50_name_ok (
    member_no    INT PRIMARY KEY,
    device_name  TEXT NOT NULL,
    confirmed_by UUID REFERENCES app_users(id),
    confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON k50_name_ok TO pz_partner;
GRANT SELECT ON k50_name_ok TO pz_manager;
