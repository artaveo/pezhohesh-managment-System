//! The last three months of 1404, the only part of that year the partners still have (their
//! own estimate, the Excel sheet «1404 Data»). Migration 0012 added them once, but only where
//! both partners were already on file, so a database made on a fresh PostgreSQL, where the
//! partners come in later with the Excel import, never got them. This adds them as soon as the
//! partners are there, once: a database that has (or had and deleted) any 1404 estimate, or
//! real receipts from before 1405, is left alone.

use sqlx::PgPool;

const MONTHS: &str = "
INSERT INTO month_summaries (solar_year, solar_month, starts_on, net_balance, note)
SELECT v.y, v.m, v.d, v.amount, 'برآورد شرکا؛ معاش کانتیندار کم نشده'
FROM (VALUES (1404, 10, DATE '2025-12-22', 24500), (1404, 11, DATE '2026-01-21', 24500), (1404, 12, DATE '2026-02-20', 24200))
     AS v(y, m, d, amount)
WHERE EXISTS (SELECT 1 FROM staff WHERE deleted_at IS NULL AND (full_name = 'جلیل رحیمی' OR 'جلیل رحیمی' = ANY(aliases)))
  AND EXISTS (SELECT 1 FROM staff WHERE deleted_at IS NULL AND (full_name = 'ذاکر ناصری' OR 'ذاکر ناصری' = ANY(aliases)))
  AND NOT EXISTS (SELECT 1 FROM month_summaries WHERE department = 'hall' AND solar_year = 1404)
  AND NOT EXISTS (SELECT 1 FROM receipts WHERE issued_on < DATE '2026-03-21')";

/// What the partners took in those months, one line per month (as in migration 0012).
const WITHDRAWALS: &str = "
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
WHERE NOT EXISTS (SELECT 1 FROM withdrawals WHERE taken_on < DATE '2026-03-21')";

/// Run at start and after each Excel import; does nothing once 1404 is there.
pub async fn ensure_1404(db: &PgPool) {
    if let Err(e) = add_1404(db).await {
        tracing::warn!("1404 history: {e}");
    }
}

async fn add_1404(db: &PgPool) -> Result<(), sqlx::Error> {
    let mut tx = db.begin().await?;
    let months = sqlx::query(MONTHS).execute(&mut *tx).await?.rows_affected();
    if months > 0 {
        let taken = sqlx::query(WITHDRAWALS).execute(&mut *tx).await?.rows_affected();
        tracing::info!("added 1404 history: {months} months, {taken} withdrawals");
    }
    tx.commit().await
}
