-- Step 19: the Excel book's months on the registrations page and on member pages, and
-- periods paid in parts (the rest is owed until a second bill pays it).

-- Solar months as dates, from the same arithmetic as api/src/solar.rs (a test checks they
-- agree). The same rows on every computer, so this table is not shared by sync.
CREATE TABLE solar_months (
    year      INT NOT NULL,
    month     INT NOT NULL CHECK (month BETWEEN 1 AND 12),
    starts_on DATE PRIMARY KEY,
    ends_on   DATE NOT NULL,
    UNIQUE (year, month)
);
INSERT INTO solar_months (year, month, starts_on, ends_on)
SELECT y, m, d::date, COALESCE(lead(d::date) OVER (ORDER BY d::date) - 1, d::date + 29)
FROM (VALUES
    (1395, 1, '2016-03-20'), (1395, 2, '2016-04-20'), (1395, 3, '2016-05-21'), (1395, 4, '2016-06-21'), (1395, 5, '2016-07-22'), (1395, 6, '2016-08-22'),
    (1395, 7, '2016-09-22'), (1395, 8, '2016-10-22'), (1395, 9, '2016-11-21'), (1395, 10, '2016-12-21'), (1395, 11, '2017-01-20'), (1395, 12, '2017-02-19'),
    (1396, 1, '2017-03-21'), (1396, 2, '2017-04-21'), (1396, 3, '2017-05-22'), (1396, 4, '2017-06-22'), (1396, 5, '2017-07-23'), (1396, 6, '2017-08-23'),
    (1396, 7, '2017-09-23'), (1396, 8, '2017-10-23'), (1396, 9, '2017-11-22'), (1396, 10, '2017-12-22'), (1396, 11, '2018-01-21'), (1396, 12, '2018-02-20'),
    (1397, 1, '2018-03-21'), (1397, 2, '2018-04-21'), (1397, 3, '2018-05-22'), (1397, 4, '2018-06-22'), (1397, 5, '2018-07-23'), (1397, 6, '2018-08-23'),
    (1397, 7, '2018-09-23'), (1397, 8, '2018-10-23'), (1397, 9, '2018-11-22'), (1397, 10, '2018-12-22'), (1397, 11, '2019-01-21'), (1397, 12, '2019-02-20'),
    (1398, 1, '2019-03-21'), (1398, 2, '2019-04-21'), (1398, 3, '2019-05-22'), (1398, 4, '2019-06-22'), (1398, 5, '2019-07-23'), (1398, 6, '2019-08-23'),
    (1398, 7, '2019-09-23'), (1398, 8, '2019-10-23'), (1398, 9, '2019-11-22'), (1398, 10, '2019-12-22'), (1398, 11, '2020-01-21'), (1398, 12, '2020-02-20'),
    (1399, 1, '2020-03-20'), (1399, 2, '2020-04-20'), (1399, 3, '2020-05-21'), (1399, 4, '2020-06-21'), (1399, 5, '2020-07-22'), (1399, 6, '2020-08-22'),
    (1399, 7, '2020-09-22'), (1399, 8, '2020-10-22'), (1399, 9, '2020-11-21'), (1399, 10, '2020-12-21'), (1399, 11, '2021-01-20'), (1399, 12, '2021-02-19'),
    (1400, 1, '2021-03-21'), (1400, 2, '2021-04-21'), (1400, 3, '2021-05-22'), (1400, 4, '2021-06-22'), (1400, 5, '2021-07-23'), (1400, 6, '2021-08-23'),
    (1400, 7, '2021-09-23'), (1400, 8, '2021-10-23'), (1400, 9, '2021-11-22'), (1400, 10, '2021-12-22'), (1400, 11, '2022-01-21'), (1400, 12, '2022-02-20'),
    (1401, 1, '2022-03-21'), (1401, 2, '2022-04-21'), (1401, 3, '2022-05-22'), (1401, 4, '2022-06-22'), (1401, 5, '2022-07-23'), (1401, 6, '2022-08-23'),
    (1401, 7, '2022-09-23'), (1401, 8, '2022-10-23'), (1401, 9, '2022-11-22'), (1401, 10, '2022-12-22'), (1401, 11, '2023-01-21'), (1401, 12, '2023-02-20'),
    (1402, 1, '2023-03-21'), (1402, 2, '2023-04-21'), (1402, 3, '2023-05-22'), (1402, 4, '2023-06-22'), (1402, 5, '2023-07-23'), (1402, 6, '2023-08-23'),
    (1402, 7, '2023-09-23'), (1402, 8, '2023-10-23'), (1402, 9, '2023-11-22'), (1402, 10, '2023-12-22'), (1402, 11, '2024-01-21'), (1402, 12, '2024-02-20'),
    (1403, 1, '2024-03-20'), (1403, 2, '2024-04-20'), (1403, 3, '2024-05-21'), (1403, 4, '2024-06-21'), (1403, 5, '2024-07-22'), (1403, 6, '2024-08-22'),
    (1403, 7, '2024-09-22'), (1403, 8, '2024-10-22'), (1403, 9, '2024-11-21'), (1403, 10, '2024-12-21'), (1403, 11, '2025-01-20'), (1403, 12, '2025-02-19'),
    (1404, 1, '2025-03-21'), (1404, 2, '2025-04-21'), (1404, 3, '2025-05-22'), (1404, 4, '2025-06-22'), (1404, 5, '2025-07-23'), (1404, 6, '2025-08-23'),
    (1404, 7, '2025-09-23'), (1404, 8, '2025-10-23'), (1404, 9, '2025-11-22'), (1404, 10, '2025-12-22'), (1404, 11, '2026-01-21'), (1404, 12, '2026-02-20'),
    (1405, 1, '2026-03-21'), (1405, 2, '2026-04-21'), (1405, 3, '2026-05-22'), (1405, 4, '2026-06-22'), (1405, 5, '2026-07-23'), (1405, 6, '2026-08-23'),
    (1405, 7, '2026-09-23'), (1405, 8, '2026-10-23'), (1405, 9, '2026-11-22'), (1405, 10, '2026-12-22'), (1405, 11, '2027-01-21'), (1405, 12, '2027-02-20'),
    (1406, 1, '2027-03-21'), (1406, 2, '2027-04-21'), (1406, 3, '2027-05-22'), (1406, 4, '2027-06-22'), (1406, 5, '2027-07-23'), (1406, 6, '2027-08-23'),
    (1406, 7, '2027-09-23'), (1406, 8, '2027-10-23'), (1406, 9, '2027-11-22'), (1406, 10, '2027-12-22'), (1406, 11, '2028-01-21'), (1406, 12, '2028-02-20'),
    (1407, 1, '2028-03-20'), (1407, 2, '2028-04-20'), (1407, 3, '2028-05-21'), (1407, 4, '2028-06-21'), (1407, 5, '2028-07-22'), (1407, 6, '2028-08-22'),
    (1407, 7, '2028-09-22'), (1407, 8, '2028-10-22'), (1407, 9, '2028-11-21'), (1407, 10, '2028-12-21'), (1407, 11, '2029-01-20'), (1407, 12, '2029-02-19'),
    (1408, 1, '2029-03-20'), (1408, 2, '2029-04-20'), (1408, 3, '2029-05-21'), (1408, 4, '2029-06-21'), (1408, 5, '2029-07-22'), (1408, 6, '2029-08-22'),
    (1408, 7, '2029-09-22'), (1408, 8, '2029-10-22'), (1408, 9, '2029-11-21'), (1408, 10, '2029-12-21'), (1408, 11, '2030-01-20'), (1408, 12, '2030-02-19'),
    (1409, 1, '2030-03-21'), (1409, 2, '2030-04-21'), (1409, 3, '2030-05-22'), (1409, 4, '2030-06-22'), (1409, 5, '2030-07-23'), (1409, 6, '2030-08-23'),
    (1409, 7, '2030-09-23'), (1409, 8, '2030-10-23'), (1409, 9, '2030-11-22'), (1409, 10, '2030-12-22'), (1409, 11, '2031-01-21'), (1409, 12, '2031-02-20'),
    (1410, 1, '2031-03-21'), (1410, 2, '2031-04-21'), (1410, 3, '2031-05-22'), (1410, 4, '2031-06-22'), (1410, 5, '2031-07-23'), (1410, 6, '2031-08-23'),
    (1410, 7, '2031-09-23'), (1410, 8, '2031-10-23'), (1410, 9, '2031-11-22'), (1410, 10, '2031-12-22'), (1410, 11, '2032-01-21'), (1410, 12, '2032-02-20'),
    (1411, 1, '2032-03-20'), (1411, 2, '2032-04-20'), (1411, 3, '2032-05-21'), (1411, 4, '2032-06-21'), (1411, 5, '2032-07-22'), (1411, 6, '2032-08-22'),
    (1411, 7, '2032-09-22'), (1411, 8, '2032-10-22'), (1411, 9, '2032-11-21'), (1411, 10, '2032-12-21'), (1411, 11, '2033-01-20'), (1411, 12, '2033-02-19'),
    (1412, 1, '2033-03-20'), (1412, 2, '2033-04-20'), (1412, 3, '2033-05-21'), (1412, 4, '2033-06-21'), (1412, 5, '2033-07-22'), (1412, 6, '2033-08-22'),
    (1412, 7, '2033-09-22'), (1412, 8, '2033-10-22'), (1412, 9, '2033-11-21'), (1412, 10, '2033-12-21'), (1412, 11, '2034-01-20'), (1412, 12, '2034-02-19'),
    (1413, 1, '2034-03-21'), (1413, 2, '2034-04-21'), (1413, 3, '2034-05-22'), (1413, 4, '2034-06-22'), (1413, 5, '2034-07-23'), (1413, 6, '2034-08-23'),
    (1413, 7, '2034-09-23'), (1413, 8, '2034-10-23'), (1413, 9, '2034-11-22'), (1413, 10, '2034-12-22'), (1413, 11, '2035-01-21'), (1413, 12, '2035-02-20'),
    (1414, 1, '2035-03-21'), (1414, 2, '2035-04-21'), (1414, 3, '2035-05-22'), (1414, 4, '2035-06-22'), (1414, 5, '2035-07-23'), (1414, 6, '2035-08-23'),
    (1414, 7, '2035-09-23'), (1414, 8, '2035-10-23'), (1414, 9, '2035-11-22'), (1414, 10, '2035-12-22'), (1414, 11, '2036-01-21'), (1414, 12, '2036-02-20'),
    (1415, 1, '2036-03-20'), (1415, 2, '2036-04-20'), (1415, 3, '2036-05-21'), (1415, 4, '2036-06-21'), (1415, 5, '2036-07-22'), (1415, 6, '2036-08-22'),
    (1415, 7, '2036-09-22'), (1415, 8, '2036-10-22'), (1415, 9, '2036-11-21'), (1415, 10, '2036-12-21'), (1415, 11, '2037-01-20'), (1415, 12, '2037-02-19'),
    (1416, 1, '2037-03-20'), (1416, 2, '2037-04-20'), (1416, 3, '2037-05-21'), (1416, 4, '2037-06-21'), (1416, 5, '2037-07-22'), (1416, 6, '2037-08-22'),
    (1416, 7, '2037-09-22'), (1416, 8, '2037-10-22'), (1416, 9, '2037-11-21'), (1416, 10, '2037-12-21'), (1416, 11, '2038-01-20'), (1416, 12, '2038-02-19'),
    (1417, 1, '2038-03-21'), (1417, 2, '2038-04-21'), (1417, 3, '2038-05-22'), (1417, 4, '2038-06-22'), (1417, 5, '2038-07-23'), (1417, 6, '2038-08-23'),
    (1417, 7, '2038-09-23'), (1417, 8, '2038-10-23'), (1417, 9, '2038-11-22'), (1417, 10, '2038-12-22'), (1417, 11, '2039-01-21'), (1417, 12, '2039-02-20'),
    (1418, 1, '2039-03-21'), (1418, 2, '2039-04-21'), (1418, 3, '2039-05-22'), (1418, 4, '2039-06-22'), (1418, 5, '2039-07-23'), (1418, 6, '2039-08-23'),
    (1418, 7, '2039-09-23'), (1418, 8, '2039-10-23'), (1418, 9, '2039-11-22'), (1418, 10, '2039-12-22'), (1418, 11, '2040-01-21'), (1418, 12, '2040-02-20'),
    (1419, 1, '2040-03-20'), (1419, 2, '2040-04-20'), (1419, 3, '2040-05-21'), (1419, 4, '2040-06-21'), (1419, 5, '2040-07-22'), (1419, 6, '2040-08-22'),
    (1419, 7, '2040-09-22'), (1419, 8, '2040-10-22'), (1419, 9, '2040-11-21'), (1419, 10, '2040-12-21'), (1419, 11, '2041-01-20'), (1419, 12, '2041-02-19'),
    (1420, 1, '2041-03-20'), (1420, 2, '2041-04-20'), (1420, 3, '2041-05-21'), (1420, 4, '2041-06-21'), (1420, 5, '2041-07-22'), (1420, 6, '2041-08-22'),
    (1420, 7, '2041-09-22'), (1420, 8, '2041-10-22'), (1420, 9, '2041-11-21'), (1420, 10, '2041-12-21'), (1420, 11, '2042-01-20'), (1420, 12, '2042-02-19'),
    (1421, 1, '2042-03-21'), (1421, 2, '2042-04-21'), (1421, 3, '2042-05-22'), (1421, 4, '2042-06-22'), (1421, 5, '2042-07-23'), (1421, 6, '2042-08-23'),
    (1421, 7, '2042-09-23'), (1421, 8, '2042-10-23'), (1421, 9, '2042-11-22'), (1421, 10, '2042-12-22'), (1421, 11, '2043-01-21'), (1421, 12, '2043-02-20'),
    (1422, 1, '2043-03-21'), (1422, 2, '2043-04-21'), (1422, 3, '2043-05-22'), (1422, 4, '2043-06-22'), (1422, 5, '2043-07-23'), (1422, 6, '2043-08-23'),
    (1422, 7, '2043-09-23'), (1422, 8, '2043-10-23'), (1422, 9, '2043-11-22'), (1422, 10, '2043-12-22'), (1422, 11, '2044-01-21'), (1422, 12, '2044-02-20'),
    (1423, 1, '2044-03-20'), (1423, 2, '2044-04-20'), (1423, 3, '2044-05-21'), (1423, 4, '2044-06-21'), (1423, 5, '2044-07-22'), (1423, 6, '2044-08-22'),
    (1423, 7, '2044-09-22'), (1423, 8, '2044-10-22'), (1423, 9, '2044-11-21'), (1423, 10, '2044-12-21'), (1423, 11, '2045-01-20'), (1423, 12, '2045-02-19'),
    (1424, 1, '2045-03-20'), (1424, 2, '2045-04-20'), (1424, 3, '2045-05-21'), (1424, 4, '2045-06-21'), (1424, 5, '2045-07-22'), (1424, 6, '2045-08-22'),
    (1424, 7, '2045-09-22'), (1424, 8, '2045-10-22'), (1424, 9, '2045-11-21'), (1424, 10, '2045-12-21'), (1424, 11, '2046-01-20'), (1424, 12, '2046-02-19'),
    (1425, 1, '2046-03-21'), (1425, 2, '2046-04-21'), (1425, 3, '2046-05-22'), (1425, 4, '2046-06-22'), (1425, 5, '2046-07-23'), (1425, 6, '2046-08-23'),
    (1425, 7, '2046-09-23'), (1425, 8, '2046-10-23'), (1425, 9, '2046-11-22'), (1425, 10, '2046-12-22'), (1425, 11, '2047-01-21'), (1425, 12, '2047-02-20'),
    (1426, 1, '2047-03-21'), (1426, 2, '2047-04-21'), (1426, 3, '2047-05-22'), (1426, 4, '2047-06-22'), (1426, 5, '2047-07-23'), (1426, 6, '2047-08-23'),
    (1426, 7, '2047-09-23'), (1426, 8, '2047-10-23'), (1426, 9, '2047-11-22'), (1426, 10, '2047-12-22'), (1426, 11, '2048-01-21'), (1426, 12, '2048-02-20'),
    (1427, 1, '2048-03-20'), (1427, 2, '2048-04-20'), (1427, 3, '2048-05-21'), (1427, 4, '2048-06-21'), (1427, 5, '2048-07-22'), (1427, 6, '2048-08-22'),
    (1427, 7, '2048-09-22'), (1427, 8, '2048-10-22'), (1427, 9, '2048-11-21'), (1427, 10, '2048-12-21'), (1427, 11, '2049-01-20'), (1427, 12, '2049-02-19'),
    (1428, 1, '2049-03-20'), (1428, 2, '2049-04-20'), (1428, 3, '2049-05-21'), (1428, 4, '2049-06-21'), (1428, 5, '2049-07-22'), (1428, 6, '2049-08-22'),
    (1428, 7, '2049-09-22'), (1428, 8, '2049-10-22'), (1428, 9, '2049-11-21'), (1428, 10, '2049-12-21'), (1428, 11, '2050-01-20'), (1428, 12, '2050-02-19'),
    (1429, 1, '2050-03-21'), (1429, 2, '2050-04-21'), (1429, 3, '2050-05-22'), (1429, 4, '2050-06-22'), (1429, 5, '2050-07-23'), (1429, 6, '2050-08-23'),
    (1429, 7, '2050-09-23'), (1429, 8, '2050-10-23'), (1429, 9, '2050-11-22'), (1429, 10, '2050-12-22'), (1429, 11, '2051-01-21'), (1429, 12, '2051-02-20'),
    (1430, 1, '2051-03-21'), (1430, 2, '2051-04-21'), (1430, 3, '2051-05-22'), (1430, 4, '2051-06-22'), (1430, 5, '2051-07-23'), (1430, 6, '2051-08-23'),
    (1430, 7, '2051-09-23'), (1430, 8, '2051-10-23'), (1430, 9, '2051-11-22'), (1430, 10, '2051-12-22'), (1430, 11, '2052-01-21'), (1430, 12, '2052-02-20')
) AS v(y, m, d);
GRANT SELECT ON solar_months TO pz_partner, pz_manager, pz_pec;

-- Every fee cell of the Excel book's monthly and internet sheets: the import made one
-- receipt per cell, dated the 1st of its month, with the member number in its text
-- ("عضویت ماهانه · نام · شمارهٔ 51741 (اکسل 1405)"). The import now links the member too;
-- rows imported before are linked here. Every database runs this itself, so it is not sent
-- to the other computers (pezhohesh.applying).
ALTER TABLE receipts ADD COLUMN member_id UUID REFERENCES members(id);
SET LOCAL pezhohesh.applying = 'on';
UPDATE receipts r SET member_id = m.id
FROM members m
WHERE r.import_batch_id IS NOT NULL AND r.member_id IS NULL AND r.income_category IN ('monthly', 'internet')
  AND m.member_no = NULLIF(substring(r.description FROM 'شمارهٔ ([0-9]+)'), '')::int;
RESET pezhohesh.applying;
CREATE INDEX receipts_member_idx ON receipts (member_id, income_category, issued_on) WHERE member_id IS NOT NULL;

CREATE VIEW v_excel_months WITH (security_invoker = true) AS
SELECT r.id AS receipt_id, r.income_category AS kind, sm.year, sm.month,
       sm.starts_on AS month_start, sm.ends_on AS month_end, r.amount::float8 AS amount,
       m.id AS member_id, m.member_no AS member_no,
       COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), NULLIF(split_part(r.description, ' · ', 2), ''), '—') AS name,
       m.phone
FROM receipts r
JOIN import_batches b ON b.id = r.import_batch_id AND b.replaced_at IS NULL
JOIN solar_months sm ON sm.starts_on = r.issued_on
LEFT JOIN members m ON m.id = r.member_id AND m.deleted_at IS NULL
WHERE r.income_category IN ('monthly', 'internet') AND NOT r.voided AND r.deleted_at IS NULL;
GRANT SELECT ON v_excel_months TO pz_partner, pz_manager;

-- A period may be paid in parts: the first bill and, later, bills for the rest.
ALTER TABLE receipts ADD COLUMN pays_rest BOOLEAN NOT NULL DEFAULT false;

-- What each period cost, what its bills paid, and what is still owed.
CREATE VIEW v_period_paid WITH (security_invoker = true) AS
SELECT ms.id AS membership_id, ms.member_id,
       (ms.fee - ms.discount)::float8 AS due,
       COALESCE(sum(r.amount), 0)::float8 AS paid,
       GREATEST(ms.fee - ms.discount - COALESCE(sum(r.amount), 0), 0)::float8 AS owed,
       (array_agg(r.id ORDER BY r.pays_rest, r.created_at) FILTER (WHERE r.id IS NOT NULL))[1] AS receipt_id,
       (array_agg(r.receipt_no ORDER BY r.pays_rest, r.created_at) FILTER (WHERE r.id IS NOT NULL))[1] AS receipt_no,
       min(r.issued_on) AS issued_on
FROM memberships ms
LEFT JOIN receipts r ON r.membership_id = ms.id AND NOT r.voided AND r.deleted_at IS NULL
WHERE ms.deleted_at IS NULL
GROUP BY ms.id;
GRANT SELECT ON v_period_paid TO pz_partner, pz_manager;

-- Who signed up when: the periods typed in the app (as before) and, for months the Excel
-- book holds, each fee cell that no period of the same month already shows. A period with
-- no bill (dates read from the fingerprint device, money already in the Excel import)
-- shows the Excel fee of its month. Nothing here is counted again in the accounts.
DROP VIEW v_registrations;
CREATE VIEW v_registrations WITH (security_invoker = true) AS
SELECT ms.id,
       COALESCE(pp.issued_on, ms.start_date) AS day,
       p.kind::text AS kind, p.name AS plan_name, ms.member_id, m.member_no,
       COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), ms.guest_name, '—') AS name,
       m.phone, ms.start_date, ms.end_date,
       COALESCE(CASE WHEN pp.receipt_id IS NOT NULL THEN pp.paid END, xm.amount, 0)::float8 AS amount,
       pp.receipt_id, pp.receipt_no,
       ms.member_id IS NOT NULL AND NOT EXISTS (
           SELECT 1 FROM memberships e JOIN plans ep ON ep.id = e.plan_id
           WHERE e.member_id = ms.member_id AND e.deleted_at IS NULL AND ep.kind = p.kind
             AND (e.start_date, e.created_at, e.id) < (ms.start_date, ms.created_at, ms.id)
       ) AND NOT EXISTS (
           SELECT 1 FROM v_excel_months x
           WHERE x.member_id = ms.member_id AND x.kind = p.kind::text AND x.month_end < ms.start_date
       ) AS first,
       pp.receipt_id IS NULL AS record_only,
       CASE WHEN pp.receipt_id IS NULL AND xm.amount IS NOT NULL THEN 'excel_dated' ELSE 'app' END AS source,
       CASE WHEN pp.receipt_id IS NOT NULL THEN pp.owed ELSE 0 END::float8 AS owed
FROM memberships ms
JOIN plans p ON p.id = ms.plan_id
LEFT JOIN members m ON m.id = ms.member_id
LEFT JOIN v_period_paid pp ON pp.membership_id = ms.id
LEFT JOIN LATERAL (
    SELECT sum(x.amount) AS amount FROM v_excel_months x
    WHERE x.member_id = ms.member_id AND x.kind = p.kind::text AND ms.start_date BETWEEN x.month_start AND x.month_end
) xm ON pp.receipt_id IS NULL
WHERE ms.deleted_at IS NULL
UNION ALL
SELECT x.receipt_id, x.month_start, x.kind,
       CASE x.kind WHEN 'internet' THEN 'انترنت ماهانه' ELSE 'عضویت ماهانه' END,
       x.member_id, x.member_no, x.name, x.phone, x.month_start, x.month_end, x.amount, NULL, NULL,
       x.first_cell AND NOT EXISTS (
           SELECT 1 FROM memberships e JOIN plans ep ON ep.id = e.plan_id
           WHERE e.member_id = x.member_id AND e.deleted_at IS NULL AND ep.kind::text = x.kind AND e.start_date < x.month_start
       ),
       true, 'excel', 0
FROM (
    SELECT e.*, e.month_start = min(e.month_start) OVER (PARTITION BY e.kind, COALESCE(e.member_id::text, e.name)) AS first_cell
    FROM v_excel_months e
) x
WHERE NOT EXISTS (
    SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id
    WHERE ms.member_id = x.member_id AND ms.deleted_at IS NULL AND p.kind::text = x.kind
      AND ms.start_date BETWEEN x.month_start AND x.month_end
)
UNION ALL
-- Daily seats of the Excel book: each cell has its own day ("عضویت روزانه · نام").
SELECT r.id, r.issued_on, 'daily', 'عضویت روزانه', NULL, NULL,
       COALESCE(NULLIF(split_part(r.description, ' · ', 2), ''), '—'), NULL, r.issued_on, r.issued_on,
       r.amount::float8, NULL, NULL, false, true, 'excel', 0
FROM receipts r
JOIN import_batches b ON b.id = r.import_batch_id AND b.replaced_at IS NULL
WHERE r.income_category = 'daily' AND NOT r.voided AND r.deleted_at IS NULL;
GRANT SELECT ON v_registrations TO pz_partner, pz_manager;

-- Members who still owe part of a period show it in red on the lists.
CREATE OR REPLACE VIEW v_member_status WITH (security_invoker = true) AS
SELECT m.id AS member_id, m.member_no,
       trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name,
       m.father_name, m.phone,
       last.end_date, last.plan_name,
       (last.end_date - current_date) AS days_left,
       GREATEST(anyp.start_date, CASE WHEN m.import_batch_id IS NULL THEN m.joined_on END) AS last_start,
       GREATEST(anyp.created_at, m.created_at) AS last_at,
       COALESCE((SELECT sum(pp.owed) FROM v_period_paid pp WHERE pp.member_id = m.id AND pp.receipt_id IS NOT NULL), 0)::float8 AS owed
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
