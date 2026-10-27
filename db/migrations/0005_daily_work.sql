-- Step 4: the daily work moves into the app: registering and renewing members, daily
-- seats, printed bills, expenses and withdrawals.

-- This computer, for bill numbers (H-1405-000001). The manager and education laptops get
-- their own row (M, P) when they are set up; until then every bill is the office laptop's.
INSERT INTO devices (id, name, receipt_prefix)
SELECT gen_random_uuid(), 'دفتر قرائت‌خانه', 'H'
WHERE NOT EXISTS (SELECT 1 FROM devices);
INSERT INTO settings (key, value)
SELECT 'this_device_id', to_jsonb(id::text) FROM devices ORDER BY created_at LIMIT 1
ON CONFLICT (key) DO NOTHING;

-- The price list, in the order the forms show it. Partners change prices in Settings;
-- a bill keeps the amount it was issued with.
ALTER TABLE plans ADD COLUMN sort_order INT NOT NULL DEFAULT 100;
INSERT INTO plans (id, kind, name, price, duration_days, sort_order)
SELECT gen_random_uuid(), v.kind::plan_kind, v.name, v.price, v.days, v.sort_order
FROM (VALUES
    ('monthly',  'عضویت ماهانه 300', 300, 30, 1),
    ('monthly',  'عضویت ماهانه 250', 250, 30, 2),
    ('internet', 'انترنت ماهانه',    400, 30, 3),
    ('daily',    'عضویت روزانه',      30,  1, 4)
) AS v(kind, name, price, days, sort_order)
WHERE NOT EXISTS (SELECT 1 FROM plans);

-- A wrong bill is voided, never deleted: who, when and why stay on it.
ALTER TABLE receipts
    ADD COLUMN void_reason TEXT,
    ADD COLUMN voided_by   UUID REFERENCES app_users(id),
    ADD COLUMN voided_at   TIMESTAMPTZ;

-- Members without a paid period yet (imported from Excel) get their current dates typed
-- in later; such a period has no bill because the money is already in the Excel import.
ALTER TABLE memberships ADD COLUMN note TEXT;

CREATE INDEX receipts_issued_idx ON receipts (issued_on DESC, created_at DESC);
CREATE INDEX receipts_membership_idx ON receipts (membership_id) WHERE membership_id IS NOT NULL;
CREATE INDEX expenses_spent_idx ON expenses (spent_on DESC);
CREATE INDEX withdrawals_taken_idx ON withdrawals (taken_on DESC);


-- The expense lines of the year statement, in its order, so a fresh database has them
-- too (the Excel import finds these by name).
INSERT INTO expense_categories (id, department, name, sort_order)
SELECT gen_random_uuid(), 'hall', v.name, v.sort_order
FROM (VALUES
    ('کرایه سالن', 1), ('پول صرفیه انترنت', 2), ('اجوره مدیر اداری', 3), ('اجوره مدیر ارتباطات', 4),
    ('اجوره کانتیندار', 5), ('پول صرفیه برق', 6), ('پول صرفیه آب', 7), ('فاضلاب', 8),
    ('پول چوکیداری', 9), ('ماکولات', 10), ('مصارف جانبی', 11), ('ترمیمات و بهسازی', 12),
    ('مصارفات شرکت خدمات', 13), ('10% برای احتمالات', 14)
) AS v(name, sort_order)
ON CONFLICT (department, name) DO NOTHING;

-- A daily seat bought by a member says nothing about their monthly end date.
CREATE OR REPLACE VIEW v_member_status WITH (security_invoker = true) AS
SELECT m.id AS member_id, m.member_no,
       trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name,
       m.father_name, m.phone,
       last.end_date, last.plan_name,
       (last.end_date - current_date) AS days_left
FROM members m
LEFT JOIN LATERAL (
    SELECT ms.end_date, p.name AS plan_name
    FROM memberships ms JOIN plans p ON p.id = ms.plan_id
    WHERE ms.member_id = m.id AND ms.deleted_at IS NULL AND p.kind <> 'daily'
    ORDER BY ms.end_date DESC
    LIMIT 1
) last ON true
WHERE m.deleted_at IS NULL;
