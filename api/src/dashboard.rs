//! Home-screen numbers. One call returns everything the dashboard shows for a period,
//! together with the previous period so the app can show growth or decline.

use axum::{extract::{Query, State}, http::StatusCode, Json};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};

use crate::AppState;

#[derive(Deserialize)]
pub struct Params {
    /// Label only: day | month | year.
    pub period: Option<String>,
    /// Current window [from, to) and the previous window [prev_from, from).
    /// The app sends Solar (Hijri Shamsi) month and year boundaries; without them
    /// the window is today vs yesterday.
    pub from: Option<chrono::NaiveDate>,
    pub to: Option<chrono::NaiveDate>,
    pub prev_from: Option<chrono::NaiveDate>,
}

#[derive(Serialize)]
pub struct Dashboard {
    period: String,
    kpis: Kpis,
    /// Daily income and expenses for the last 30 days, oldest first.
    trend: Vec<TrendPoint>,
    /// Income in the period by category (monthly, daily, internet, hotspot, books...).
    income_by_category: Vec<CategoryAmount>,
    /// Memberships ending in the next 7 days.
    expiring: Vec<Expiring>,
    overdue_books: i64,
}

#[derive(Serialize, FromRow)]
pub struct Kpis {
    active_members: i64,
    active_members_prev: i64,
    new_members: i64,
    new_members_prev: i64,
    income: f64,
    income_prev: f64,
    expenses: f64,
    expenses_prev: f64,
    attendance: i64,
    attendance_prev: i64,
}

#[derive(Serialize, FromRow)]
pub struct TrendPoint {
    day: chrono::NaiveDate,
    income: f64,
    expenses: f64,
}

#[derive(Serialize, FromRow)]
pub struct CategoryAmount {
    category: String,
    amount: f64,
}

#[derive(Serialize, FromRow)]
pub struct Expiring {
    member_no: i32,
    name: String,
    end_date: chrono::NaiveDate,
}

pub async fn get(State(s): State<AppState>, Query(p): Query<Params>) -> Result<Json<Dashboard>, StatusCode> {
    let today = chrono::Local::now().date_naive();
    let from = p.from.unwrap_or(today);
    let to = p.to.unwrap_or(from + chrono::Days::new(1));
    let prev_from = p.prev_from.unwrap_or(from - (to - from));
    if !(prev_from < from && from < to) {
        return Err(StatusCode::BAD_REQUEST);
    }
    // Compare like with like: month-to-date against the same number of days of last month.
    let to = to.min(today + chrono::Days::new(1)).max(from + chrono::Days::new(1));
    let prev_to = (prev_from + (to - from)).min(from);
    let window = Window { from, to, prev_from, prev_to };
    load(&s.db, p.period.unwrap_or_else(|| "day".into()), window).await.map(Json).map_err(|e| {
        tracing::error!("dashboard: {e}");
        StatusCode::INTERNAL_SERVER_ERROR
    })
}

#[derive(Clone, Copy)]
struct Window {
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
    prev_from: chrono::NaiveDate,
    prev_to: chrono::NaiveDate,
}

async fn load(db: &PgPool, period: String, w: Window) -> sqlx::Result<Dashboard> {
    // [cur_start, cur_end) and [prev_start, cur_start); AFN only, USD is PEC's and shown there.
    let kpis: Kpis = sqlx::query_as(
        r#"
        WITH w AS (SELECT $1::date AS cs, $2::date AS ce, $3::date AS ps, $4::date AS pe)
        SELECT
            (SELECT count(DISTINCT member_id) FROM memberships, w
              WHERE deleted_at IS NULL AND member_id IS NOT NULL
                AND start_date < w.ce AND end_date >= w.ce - 1) AS active_members,
            (SELECT count(DISTINCT member_id) FROM memberships, w
              WHERE deleted_at IS NULL AND member_id IS NOT NULL
                AND start_date < w.pe AND end_date >= w.pe - 1) AS active_members_prev,
            (SELECT count(*) FROM members, w WHERE deleted_at IS NULL AND joined_on >= w.cs AND joined_on < w.ce) AS new_members,
            (SELECT count(*) FROM members, w WHERE deleted_at IS NULL AND joined_on >= w.ps AND joined_on < w.pe) AS new_members_prev,
            (SELECT COALESCE(sum(amount), 0)::float8 FROM receipts, w
              WHERE NOT voided AND deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
                AND issued_on >= w.cs AND issued_on < w.ce) AS income,
            (SELECT COALESCE(sum(amount), 0)::float8 FROM receipts, w
              WHERE NOT voided AND deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
                AND issued_on >= w.ps AND issued_on < w.pe) AS income_prev,
            (SELECT COALESCE(sum(amount), 0)::float8 FROM expenses, w
              WHERE deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
                AND spent_on >= w.cs AND spent_on < w.ce) AS expenses,
            (SELECT COALESCE(sum(amount), 0)::float8 FROM expenses, w
              WHERE deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
                AND spent_on >= w.ps AND spent_on < w.pe) AS expenses_prev,
            (SELECT count(DISTINCT (device_user_no, punched_at::date)) FROM attendance, w
              WHERE punched_at >= w.cs AND punched_at < w.ce) AS attendance,
            (SELECT count(DISTINCT (device_user_no, punched_at::date)) FROM attendance, w
              WHERE punched_at >= w.ps AND punched_at < w.pe) AS attendance_prev
        FROM w
        "#,
    )
    .bind(w.from)
    .bind(w.to)
    .bind(w.prev_from)
    .bind(w.prev_to)
    .fetch_one(db)
    .await?;

    let trend: Vec<TrendPoint> = sqlx::query_as(
        r#"
        SELECT d::date AS day,
            COALESCE((SELECT sum(amount) FROM receipts r WHERE r.issued_on = d::date AND NOT r.voided
                      AND r.deleted_at IS NULL AND r.department = 'hall' AND r.currency = 'AFN'), 0)::float8 AS income,
            COALESCE((SELECT sum(amount) FROM expenses e WHERE e.spent_on = d::date
                      AND e.deleted_at IS NULL AND e.department = 'hall' AND e.currency = 'AFN'), 0)::float8 AS expenses
        FROM generate_series(current_date - 29, current_date, interval '1 day') AS d
        ORDER BY d
        "#,
    )
    .fetch_all(db)
    .await?;

    let income_by_category: Vec<CategoryAmount> = sqlx::query_as(
        r#"
        SELECT income_category AS category, sum(amount)::float8 AS amount
        FROM receipts
        WHERE NOT voided AND deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
          AND issued_on >= $1 AND issued_on < $2
        GROUP BY income_category
        ORDER BY amount DESC
        "#,
    )
    .bind(w.from)
    .bind(w.to)
    .fetch_all(db)
    .await?;

    let expiring: Vec<Expiring> = sqlx::query_as(
        r#"
        SELECT m.member_no, trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name, x.end_date
        FROM (SELECT member_id, max(end_date) AS end_date FROM memberships
              WHERE deleted_at IS NULL AND member_id IS NOT NULL GROUP BY member_id) x
        JOIN members m ON m.id = x.member_id AND m.deleted_at IS NULL
        WHERE x.end_date BETWEEN current_date AND current_date + 7
        ORDER BY x.end_date, m.member_no
        LIMIT 8
        "#,
    )
    .fetch_all(db)
    .await?;

    let overdue_books: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM book_loans WHERE deleted_at IS NULL AND returned_on IS NULL AND due_on < current_date",
    )
    .fetch_one(db)
    .await?;

    Ok(Dashboard { period, kpis, trend, income_by_category, expiring, overdue_books })
}
