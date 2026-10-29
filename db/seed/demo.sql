-- DEMO DATA ONLY: made-up members and money so the dashboard can be previewed.
-- Never load this into the real database. Load into a separate one:
--   createdb pezhohesh_demo  &&  psql -d pezhohesh_demo -f db/seed/demo.sql   (after the API has migrated it)
BEGIN;

INSERT INTO devices (id, name, receipt_prefix) VALUES ('00000000-0000-7000-8000-000000000001', 'Demo laptop', 'D')
ON CONFLICT DO NOTHING;

INSERT INTO plans (id, kind, name, price, duration_days) VALUES
    ('00000000-0000-7000-8000-0000000000a1', 'monthly',  'عضویت ماهانه', 1500, 30),
    ('00000000-0000-7000-8000-0000000000a2', 'daily',    'عضویت روزانه',  100,  1),
    ('00000000-0000-7000-8000-0000000000a3', 'internet', 'انترنت ماهانه', 500, 30)
ON CONFLICT DO NOTHING;

-- 140 members who joined over the last 120 days
INSERT INTO members (id, member_no, first_name, last_name, father_name, phone, field_of_study, joined_on)
SELECT gen_random_uuid(), 51000 + g,
       (ARRAY['احمد','مریم','علی','زهرا','حسین','فاطمه','محمد','سکینه','رضا','نرگس','جواد','لیلا'])[1 + g % 12],
       (ARRAY['حسینی','محمدی','رحیمی','کریمی','احمدی','جعفری','موسوی','نظری'])[1 + g % 8],
       (ARRAY['غلام','محمد','علی','حسن','عبدالله'])[1 + g % 5],
       '07' || lpad((g * 7919 % 100000000)::text, 8, '0'),
       (ARRAY['طب','انجنیری','حقوق','کمپیوتر','اقتصاد','کانکور'])[1 + g % 6],
       current_date - (g * 120 / 140)
FROM generate_series(1, 140) g;

-- monthly memberships: most members renewed, some lapsed
INSERT INTO memberships (id, member_id, plan_id, start_date, end_date, fee)
SELECT gen_random_uuid(), m.id, '00000000-0000-7000-8000-0000000000a1', s, s + 29, 1500
FROM members m
CROSS JOIN LATERAL (SELECT g::date AS s FROM generate_series(m.joined_on, current_date, interval '30 days') g) AS gs
WHERE m.member_no % 9 <> 0 OR s < current_date - 40;

-- a receipt for every membership, plus daily seats, internet, hotspot and books
INSERT INTO receipts (id, receipt_no, department, issued_on, amount, membership_id, income_category)
SELECT gen_random_uuid(), 'D-1405-' || lpad(row_number() OVER ()::text, 6, '0'), 'hall', ms.start_date, ms.fee, ms.id, 'monthly'
FROM memberships ms;

INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category)
SELECT gen_random_uuid(), 'D-1405-9' || lpad(row_number() OVER ()::text, 5, '0'), 'hall', d::date, amt, cat
FROM generate_series(current_date - 60, current_date, interval '1 day') d
CROSS JOIN LATERAL (VALUES
    ('daily',    (300 + (extract(doy FROM d)::int * 37) % 700)::numeric),
    ('internet', (CASE WHEN extract(dow FROM d) IN (0, 3) THEN 1500 ELSE 500 END)::numeric),
    ('hotspot',  (200 + (extract(doy FROM d)::int * 53) % 400)::numeric),
    ('books',    (CASE WHEN extract(dow FROM d) = 5 THEN 300 ELSE 100 END)::numeric)
) AS x(cat, amt);

INSERT INTO expense_categories (id, department, name) VALUES
    ('00000000-0000-7000-8000-0000000000e1', 'hall', 'ماکولات'),
    ('00000000-0000-7000-8000-0000000000e2', 'hall', 'برق و انترنت'),
    ('00000000-0000-7000-8000-0000000000e3', 'hall', 'ترمیمات')
ON CONFLICT DO NOTHING;

INSERT INTO expenses (id, department, category_id, spent_on, amount)
SELECT gen_random_uuid(), 'hall',
       (ARRAY['00000000-0000-7000-8000-0000000000e1','00000000-0000-7000-8000-0000000000e2','00000000-0000-7000-8000-0000000000e3'])[1 + extract(doy FROM d)::int % 3]::uuid,
       d::date, (400 + (extract(doy FROM d)::int * 71) % 1800)
FROM generate_series(current_date - 60, current_date, interval '1 day') d;

-- two earlier years of daily takings (smaller, growing) so the yearly history and
-- "same month last year" comparisons have something to show
INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category)
SELECT gen_random_uuid(), 'D-1404-8' || lpad(row_number() OVER ()::text, 6, '0'), 'hall', d::date,
       round(amt * (0.55 + 0.35 * (800 - (current_date - d::date)) / 800.0)), cat
FROM generate_series(current_date - 800, current_date - 61, interval '1 day') d
CROSS JOIN LATERAL (VALUES
    ('monthly',  (2500 + (extract(doy FROM d)::int * 113) % 3500)::numeric),
    ('daily',    (300 + (extract(doy FROM d)::int * 37) % 700)::numeric),
    ('internet', (CASE WHEN extract(dow FROM d) IN (0, 3) THEN 1500 ELSE 500 END)::numeric),
    ('hotspot',  (200 + (extract(doy FROM d)::int * 53) % 400)::numeric)
) AS x(cat, amt);

INSERT INTO expenses (id, department, category_id, spent_on, amount)
SELECT gen_random_uuid(), 'hall',
       (ARRAY['00000000-0000-7000-8000-0000000000e1','00000000-0000-7000-8000-0000000000e2','00000000-0000-7000-8000-0000000000e3'])[1 + extract(doy FROM d)::int % 3]::uuid,
       d::date, (300 + (extract(doy FROM d)::int * 71) % 1500)
FROM generate_series(current_date - 800, current_date - 61, interval '1 day') d;

-- attendance from the fingerprint device: active members, most days
INSERT INTO attendance (id, member_id, device_user_no, punched_at)
SELECT gen_random_uuid(), m.id, m.member_no, d + interval '8 hours' + (m.member_no % 120) * interval '1 minute'
FROM members m
CROSS JOIN generate_series(current_date - 30, current_date, interval '1 day') d
WHERE (m.member_no + extract(doy FROM d)::int) % 4 <> 0 AND m.joined_on <= d::date;

INSERT INTO book_loans (id, member_id, book_title, loaned_on, due_on, weekly_fee)
SELECT gen_random_uuid(), id, 'کتاب نمونه', current_date - 20, current_date - 6, 50
FROM members WHERE member_no % 31 = 0;

COMMIT;
