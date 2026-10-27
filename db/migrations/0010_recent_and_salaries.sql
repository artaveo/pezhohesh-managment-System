-- Step 11: the members list shows the newest sign-ups first, and staff get a fixed monthly
-- salary that is posted to the month's expenses by itself.

-- When a member last signed up for anything (a daily seat too), so "all members" can put
-- the newest first. Members from the Excel book have no real join date (1 Hamal is a
-- placeholder), so for them only their periods count.
CREATE OR REPLACE VIEW v_member_status WITH (security_invoker = true) AS
SELECT m.id AS member_id, m.member_no,
       trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name,
       m.father_name, m.phone,
       last.end_date, last.plan_name,
       (last.end_date - current_date) AS days_left,
       GREATEST(anyp.start_date, CASE WHEN m.import_batch_id IS NULL THEN m.joined_on END) AS last_start,
       GREATEST(anyp.created_at, m.created_at) AS last_at
FROM members m
LEFT JOIN LATERAL (
    SELECT ms.end_date, p.name AS plan_name
    FROM memberships ms JOIN plans p ON p.id = ms.plan_id
    WHERE ms.member_id = m.id AND ms.deleted_at IS NULL AND p.kind <> 'daily'
    ORDER BY ms.end_date DESC
    LIMIT 1
) last ON true
LEFT JOIN LATERAL (
    SELECT max(ms.start_date) AS start_date, max(ms.created_at) AS created_at
    FROM memberships ms
    WHERE ms.member_id = m.id AND ms.deleted_at IS NULL
) anyp ON true
WHERE m.deleted_at IS NULL;

-- Salaries: the fixed amount, the statement line it is paid under (so the monthly statement
-- and the partners' shares keep working as in the Excel book), and the first month it counts.
ALTER TABLE staff
    ADD COLUMN salary_category_id UUID REFERENCES expense_categories(id),
    ADD COLUMN salary_from DATE;

-- Each posted month points at the expense line it wrote.
ALTER TABLE salary_accruals
    ADD COLUMN expense_id UUID REFERENCES expenses(id),
    ADD COLUMN created_at TIMESTAMPTZ NOT NULL DEFAULT now();
