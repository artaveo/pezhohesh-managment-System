-- An Excel fee cell was dated the first of its month, because the book has no payment day.
-- Now the day comes from the member's period (the device's dates) where one is known, so a
-- cell is found by the month its day falls in, not by that day being the first.
CREATE OR REPLACE VIEW v_excel_months WITH (security_invoker = true) AS
SELECT r.id AS receipt_id, r.income_category AS kind, sm.year, sm.month,
       sm.starts_on AS month_start, sm.ends_on AS month_end, r.amount::float8 AS amount,
       m.id AS member_id, m.member_no AS member_no,
       COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), NULLIF(split_part(r.description, ' · ', 2), ''), '—') AS name,
       m.phone
FROM receipts r
JOIN import_batches b ON b.id = r.import_batch_id AND b.replaced_at IS NULL
JOIN solar_months sm ON r.issued_on BETWEEN sm.starts_on AND sm.ends_on
LEFT JOIN members m ON m.id = r.member_id AND m.deleted_at IS NULL
WHERE r.income_category IN ('monthly', 'internet') AND NOT r.voided AND r.deleted_at IS NULL;
