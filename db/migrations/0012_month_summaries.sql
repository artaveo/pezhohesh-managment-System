-- Step 14: months whose detail was lost. Only a hand-made estimate of the month's balance
-- (income minus expenses) is known, as for Jadi, Dalw and Hut 1404; the statement shows it
-- as «بیلانس برآوردی» and the partners' shares are worked out from it. What else is known
-- for those months (withdrawals, later the canteen keeper's pay) is typed as usual.

CREATE TABLE month_summaries (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    department    department NOT NULL DEFAULT 'hall',
    solar_year    INT NOT NULL CHECK (solar_year >= 1390),
    solar_month   INT NOT NULL CHECK (solar_month BETWEEN 1 AND 12),
    starts_on     DATE NOT NULL,                 -- first day of that Solar month, for date ranges
    net_balance   NUMERIC(14,2) NOT NULL,
    note          TEXT,
    created_by    UUID REFERENCES app_users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ, device_id UUID REFERENCES devices(id)
);
CREATE UNIQUE INDEX month_summaries_month_idx ON month_summaries (department, solar_year, solar_month) WHERE deleted_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON month_summaries TO pz_partner;
GRANT SELECT ON month_summaries TO pz_manager;

CREATE TRIGGER month_summaries_touch BEFORE UPDATE ON month_summaries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER month_summaries_audit AFTER INSERT OR UPDATE OR DELETE ON month_summaries FOR EACH ROW EXECUTE FUNCTION write_audit();

-- The last three months of 1404, from the partners' own estimate (the Excel sheet «1404 Data»),
-- on the office database only (where the two partners are on file).
INSERT INTO month_summaries (solar_year, solar_month, starts_on, net_balance, note)
SELECT v.y, v.m, v.d, v.amount, 'برآورد شرکا؛ معاش کانتیندار کم نشده'
FROM (VALUES (1404, 10, DATE '2025-12-22', 24500), (1404, 11, DATE '2026-01-21', 24500), (1404, 12, DATE '2026-02-20', 24200))
     AS v(y, m, d, amount)
WHERE EXISTS (SELECT 1 FROM staff WHERE deleted_at IS NULL AND full_name = 'جلیل رحیمی')
  AND NOT EXISTS (SELECT 1 FROM receipts WHERE issued_on < DATE '2026-03-21');

-- What the partners took in those months, one line per month. Jalil's Jadi is not known:
-- the average of Dalw and Hut.
INSERT INTO withdrawals (id, staff_id, department, taken_on, amount, note)
SELECT gen_random_uuid(), s.id, 'hall', v.d, v.amount, v.note
FROM (VALUES
        ('جلیل رحیمی', DATE '2025-12-22', 21350, 'جدی 1404، برآورد: اوسط دلو و حوت'),
        ('جلیل رحیمی', DATE '2026-01-21', 22500, 'جمع برداشت‌های دلو 1404 (اکسل)'),
        ('جلیل رحیمی', DATE '2026-02-20', 20200, 'جمع برداشت‌های حوت 1404 (اکسل)'),
        ('ذاکر ناصری', DATE '2025-12-22', 2500, 'جدی 1404 (اکسل)'),
        ('ذاکر ناصری', DATE '2026-01-21', 2500, 'دلو 1404 (اکسل)'),
        ('ذاکر ناصری', DATE '2026-02-20', 2500, 'حوت 1404 (اکسل)')
     ) AS v(name, d, amount, note)
JOIN LATERAL (
    SELECT id FROM staff WHERE deleted_at IS NULL AND (full_name = v.name OR v.name = ANY(aliases)) ORDER BY created_at LIMIT 1
) s ON true
WHERE EXISTS (SELECT 1 FROM month_summaries WHERE solar_year = 1404)
  AND NOT EXISTS (SELECT 1 FROM withdrawals WHERE deleted_at IS NULL AND taken_on < DATE '2026-03-21');
