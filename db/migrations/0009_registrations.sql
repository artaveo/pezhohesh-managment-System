-- Step 10: who signed up when. One row per period sold (or recorded) at the desk, on the
-- day of its bill (a period recorded without a bill: the day it started), and whether it
-- was the member's first period of its kind (a new sign-up) or a renewal.
CREATE VIEW v_registrations WITH (security_invoker = true) AS
SELECT ms.id,
       COALESCE(r.issued_on, ms.start_date) AS day,
       p.kind::text AS kind, p.name AS plan_name, ms.member_id, m.member_no,
       COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), ms.guest_name, '—') AS name,
       m.phone, ms.start_date, ms.end_date,
       COALESCE(r.amount, 0)::float8 AS amount, r.id AS receipt_id, r.receipt_no,
       ms.member_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM memberships e JOIN plans ep ON ep.id = e.plan_id
           WHERE e.member_id = ms.member_id AND e.deleted_at IS NULL AND ep.kind = p.kind
             AND (e.start_date, e.created_at, e.id) < (ms.start_date, ms.created_at, ms.id)
       ) AS first,
       r.id IS NULL AS record_only
FROM memberships ms
JOIN plans p ON p.id = ms.plan_id
LEFT JOIN members m ON m.id = ms.member_id
LEFT JOIN receipts r ON r.membership_id = ms.id AND NOT r.voided AND r.deleted_at IS NULL
WHERE ms.deleted_at IS NULL;
GRANT SELECT ON v_registrations TO pz_partner, pz_manager;

-- Other names of a person (after two names of one person were joined), so the Excel import
-- still finds "ذاکر ناصری" when the person kept the name of the sign-in account.
ALTER TABLE staff ADD COLUMN aliases TEXT[] NOT NULL DEFAULT '{}';
