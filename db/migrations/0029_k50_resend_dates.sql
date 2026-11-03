-- The K50 gives a user's days back without leading zeros ("2026-11-3 0:0:0"). The helper read
-- that as the 30th, so it decided the device had stored the wrong day and wrote the days again
-- in its other forms; one of them left the device with days it cannot read back, and the door
-- then refused a finger it knew (member 511053, 2026-11-03: «تاریخی ندارد»). It happened to
-- every member whose first or last day has a one-digit day or month. Their days are sent once
-- more by the next rounds, now read back correctly.
UPDATE k50_users SET pushed_start = NULL
WHERE pushed_at IS NOT NULL AND pushed_start IS NOT NULL AND pushed_end IS NOT NULL
  AND (extract(day FROM pushed_start) < 10 OR extract(month FROM pushed_start) < 10
       OR extract(day FROM pushed_end) < 10 OR extract(month FROM pushed_end) < 10);
