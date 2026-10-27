//! Home-screen numbers. One call returns everything the dashboard shows for a period,
//! together with the previous period so the app can show growth or decline.

use axum::{extract::{Query, State}, Json};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};

use crate::auth::{begin_as, ApiError, CurrentUser};
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
    /// First day of the current Solar month and year, for the fixed income summary.
    pub month_from: Option<chrono::NaiveDate>,
    pub year_from: Option<chrono::NaiveDate>,
}

#[derive(Serialize)]
pub struct Dashboard {
    period: String,
    kpis: Kpis,
    /// Daily income and expenses for the last 30 days, oldest first.
    trend: Vec<TrendPoint>,
    /// Income in the period by category (monthly, daily, internet, hotspot, books...).
    income_by_category: Vec<CategoryAmount>,
    /// Hall income today, this Solar month, this Solar year and since the first record.
    income_summary: IncomeSummary,
    /// The most urgent memberships: ending within 5 days or ended in the last 30 days.
    members_attention: Vec<MemberDue>,
    members_due_soon: i64,
    members_expired: i64,
    /// The most urgent open loans: due within 2 days or overdue.
    books_attention: Vec<LoanDue>,
    books_due_soon: i64,
    books_overdue: i64,
}

#[derive(Serialize, FromRow)]
pub struct IncomeSummary {
    today: f64,
    month: f64,
    year: f64,
    all_time: f64,
}

/// Dashboard and the members page use the same window: 5 days ahead, 30 days back.
pub const MEMBER_DUE_DAYS: i32 = 5;
pub const MEMBER_EXPIRED_DAYS: i32 = 30;
/// Books: 2 days ahead, and every overdue loan (a book has to come back).
pub const BOOK_DUE_DAYS: i32 = 2;

#[derive(Serialize, FromRow)]
pub struct MemberDue {
    member_no: i32,
    name: String,
    end_date: chrono::NaiveDate,
    days_left: i32,
}

#[derive(Serialize, FromRow)]
pub struct LoanDue {
    book_title: String,
    card_no: String,
    member_name: String,
    due_on: chrono::NaiveDate,
    days_left: i32,
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

/// Study-hall home screen: partners and the manager. Education staff get their own later.
pub async fn get(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Dashboard>, ApiError> {
    if !user.sees_hall() {
        return Err(ApiError::FORBIDDEN);
    }
    let today = chrono::Local::now().date_naive();
    let from = p.from.unwrap_or(today);
    let to = p.to.unwrap_or(from + chrono::Days::new(1));
    let prev_from = p.prev_from.unwrap_or(from - (to - from));
    if !(prev_from < from && from < to) {
        return Err(ApiError::bad("bad_window"));
    }
    // Compare like with like: month-to-date against the same number of days of last month.
    let to = to.min(today + chrono::Days::new(1)).max(from + chrono::Days::new(1));
    let prev_to = (prev_from + (to - from)).min(from);
    let window = Window {
        from,
        to,
        prev_from,
        prev_to,
        month_from: p.month_from.unwrap_or(today),
        year_from: p.year_from.unwrap_or(today),
    };
    // Runs as the signed-in person's database role, so row-level security applies too.
    let mut tx = begin_as(&s.db, &user).await?;
    let data = load(&mut tx, p.period.unwrap_or_else(|| "day".into()), window).await?;
    tx.commit().await?;
    Ok(Json(data))
}

#[derive(Clone, Copy)]
struct Window {
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
    prev_from: chrono::NaiveDate,
    prev_to: chrono::NaiveDate,
    month_from: chrono::NaiveDate,
    year_from: chrono::NaiveDate,
}

async fn load(db: &mut PgConnection, period: String, w: Window) -> sqlx::Result<Dashboard> {
    // [cur_start, cur_end) and [prev_start, cur_start); AFN only, USD is PEC's and shown there.
    let kpis: Kpis = sqlx::query_as(
        r#"
        WITH w AS (SELECT $1::date AS cs, $2::date AS ce, $3::date AS ps, $4::date AS pe)
        SELECT
            (SELECT count(DISTINCT COALESCE(member_id, id)) FROM memberships, w
              WHERE deleted_at IS NULL
                AND start_date < w.ce AND end_date >= w.ce - 1) AS active_members,
            (SELECT count(DISTINCT COALESCE(member_id, id)) FROM memberships, w
              WHERE deleted_at IS NULL
                AND start_date < w.pe AND end_date >= w.pe - 1) AS active_members_prev,
            -- Sign-ups: new monthly members and daily seats (renewals are not new).
            (SELECT count(*) FROM v_registrations, w
              WHERE (kind = 'daily' OR (kind = 'monthly' AND first)) AND day >= w.cs AND day < w.ce) AS new_members,
            (SELECT count(*) FROM v_registrations, w
              WHERE (kind = 'daily' OR (kind = 'monthly' AND first)) AND day >= w.ps AND day < w.pe) AS new_members_prev,
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
    .fetch_one(&mut *db)
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
    .fetch_all(&mut *db)
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
    .fetch_all(&mut *db)
    .await?;

    let income_summary: IncomeSummary = sqlx::query_as(
        r#"
        SELECT
            COALESCE(sum(amount) FILTER (WHERE issued_on = current_date), 0)::float8 AS today,
            COALESCE(sum(amount) FILTER (WHERE issued_on >= $1 AND issued_on <= current_date), 0)::float8 AS month,
            COALESCE(sum(amount) FILTER (WHERE issued_on >= $2 AND issued_on <= current_date), 0)::float8 AS year,
            COALESCE(sum(amount), 0)::float8 AS all_time
        FROM receipts
        WHERE NOT voided AND deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'
        "#,
    )
    .bind(w.month_from)
    .bind(w.year_from)
    .fetch_one(&mut *db)
    .await?;

    let members_attention: Vec<MemberDue> = sqlx::query_as(
        "SELECT member_no, name, end_date, days_left FROM v_member_status \
         WHERE days_left BETWEEN -$1 AND $2 ORDER BY days_left, member_no LIMIT 8",
    )
    .bind(MEMBER_EXPIRED_DAYS)
    .bind(MEMBER_DUE_DAYS)
    .fetch_all(&mut *db)
    .await?;

    let (members_due_soon, members_expired): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE days_left BETWEEN 0 AND $2), \
                count(*) FILTER (WHERE days_left BETWEEN -$1 AND -1) FROM v_member_status",
    )
    .bind(MEMBER_EXPIRED_DAYS)
    .bind(MEMBER_DUE_DAYS)
    .fetch_one(&mut *db)
    .await?;

    let books_attention: Vec<LoanDue> = sqlx::query_as(
        "SELECT book_title, card_no, member_name, due_on, days_left FROM v_open_loans \
         WHERE days_left <= $1 ORDER BY days_left, due_on LIMIT 3",
    )
    .bind(BOOK_DUE_DAYS)
    .fetch_all(&mut *db)
    .await?;

    let (books_due_soon, books_overdue): (i64, i64) = sqlx::query_as(
        "SELECT count(*) FILTER (WHERE days_left BETWEEN 0 AND $1), count(*) FILTER (WHERE days_left < 0) FROM v_open_loans",
    )
    .bind(BOOK_DUE_DAYS)
    .fetch_one(&mut *db)
    .await?;

    Ok(Dashboard {
        period,
        kpis,
        trend,
        income_by_category,
        income_summary,
        members_attention,
        members_due_soon,
        members_expired,
        books_attention,
        books_due_soon,
        books_overdue,
    })
}
