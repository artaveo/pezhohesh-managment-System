-- A member's membership put on hold («تعلیق»), most often for money left unpaid: the
-- fingerprint device stops letting them in, while their periods and end date stay as they
-- are. `pause_reason` 'debt' is lifted by itself once everything the member owes is paid.
-- members already has its triggers and grants, so the new columns sync and are audited.
ALTER TABLE members
    ADD COLUMN paused_at TIMESTAMPTZ,
    ADD COLUMN pause_reason TEXT CHECK (pause_reason IN ('debt', 'other')),
    ADD COLUMN pause_note TEXT;
