-- Step 2b: light/dark preference per person, and the "days left" views behind the
-- dashboard lists and the members / books pages.

ALTER TABLE app_users ADD COLUMN theme_mode TEXT NOT NULL DEFAULT 'system'
    CHECK (theme_mode IN ('system', 'light', 'dark'));

-- Each member's latest paid period. days_left counts down past zero (-1, -2, ...) once it
-- has ended; a renewal starts the day after the old end date, so those days are owed.
CREATE VIEW v_member_status WITH (security_invoker = true) AS
SELECT m.id AS member_id, m.member_no,
       trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name,
       m.father_name, m.phone,
       last.end_date, last.plan_name,
       (last.end_date - current_date) AS days_left
FROM members m
LEFT JOIN LATERAL (
    SELECT ms.end_date, p.name AS plan_name
    FROM memberships ms JOIN plans p ON p.id = ms.plan_id
    WHERE ms.member_id = m.id AND ms.deleted_at IS NULL
    ORDER BY ms.end_date DESC
    LIMIT 1
) last ON true
WHERE m.deleted_at IS NULL;

-- Books that are out right now, with days until (or past) the due date.
CREATE VIEW v_open_loans WITH (security_invoker = true) AS
SELECT l.id AS loan_id, m.member_no,
       trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS member_name,
       m.phone,
       COALESCE(b.title, l.book_title, '—') AS book_title,
       l.loaned_on, l.due_on,
       (l.due_on - current_date) AS days_left
FROM book_loans l
JOIN members m ON m.id = l.member_id
LEFT JOIN books b ON b.id = l.book_id
WHERE l.deleted_at IS NULL AND l.returned_on IS NULL;

GRANT SELECT ON v_member_status, v_open_loans TO pz_partner, pz_manager;
