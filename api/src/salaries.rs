//! Staff salaries (the admin manager, the communications manager, Shams...). Each person has
//! a fixed monthly salary and the statement line it is paid under. Every Solar month, from
//! the month it starts, the salary is written to that month's expenses by itself, so the
//! monthly profit and the partners' shares count it as in the Excel book. What the person
//! takes from the till is a withdrawal; the page shows what they are owed, or have been paid
//! ahead, month by month.

use std::collections::HashMap;
use std::time::Duration;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{clean, hall_only, today};
use crate::solar;
use crate::AppState;

/// Who can be on the payroll: not a partner (their pay is their share), not education staff.
const PAYROLL: &str = "s.deleted_at IS NULL AND s.title IS DISTINCT FROM 'شریک' AND s.department IS DISTINCT FROM 'pec' \
    AND NOT EXISTS (SELECT 1 FROM app_users u WHERE u.staff_id = s.id AND u.role = 'partner')";

#[derive(Serialize, FromRow)]
pub struct Category {
    id: Uuid,
    name: String,
}

#[derive(FromRow)]
struct StaffRow {
    id: Uuid,
    full_name: String,
    title: Option<String>,
    monthly_salary: f64,
    category_id: Option<Uuid>,
    category: Option<String>,
    salary_from: Option<NaiveDate>,
    active: bool,
}

#[derive(Serialize, Default, Clone, Copy)]
pub struct Month {
    accrued: f64,
    taken: f64,
}

#[derive(Serialize)]
pub struct Person {
    id: Uuid,
    full_name: String,
    title: Option<String>,
    monthly_salary: f64,
    category_id: Option<Uuid>,
    category: Option<String>,
    /// First day of the Solar month the salary starts.
    salary_from: Option<NaiveDate>,
    active: bool,
    /// Hamal..Hut of the year asked for.
    months: Vec<Month>,
    /// Salary minus what was taken, before the year starts (positive: owed to the person).
    before: f64,
    /// The same up to today.
    balance: f64,
}

#[derive(Serialize)]
pub struct Page {
    year: i32,
    /// The month today is in, when `year` is this year (months after it are not posted yet).
    this_month: Option<u32>,
    people: Vec<Person>,
    /// Statement lines a salary can be paid under (partners set them).
    categories: Vec<Category>,
}

#[derive(Deserialize)]
pub struct Params {
    year: Option<i32>,
}

/// GET /api/v1/salaries?year=1405
pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Page>, ApiError> {
    hall_only(&user)?;
    let now = today();
    let (this_year, (this_m, _)) = (solar::year_of(now), solar::month_day(now));
    let year = p.year.unwrap_or(this_year);

    let mut tx = begin_as(&s.db, &user).await?;
    let staff: Vec<StaffRow> = sqlx::query_as(&format!(
        "SELECT s.id, s.full_name, s.title, s.monthly_salary::float8 AS monthly_salary, \
                s.salary_category_id AS category_id, c.name AS category, s.salary_from, s.active \
         FROM staff s LEFT JOIN expense_categories c ON c.id = s.salary_category_id \
         WHERE {PAYROLL} ORDER BY s.active DESC, s.full_name"
    ))
    .fetch_all(&mut *tx)
    .await?;
    let ids: Vec<Uuid> = staff.iter().map(|r| r.id).collect();
    // Posted months whose expense line is still there (a line removed by hand no longer counts).
    let accrued: Vec<(Uuid, i32, i32, f64)> = sqlx::query_as(
        "SELECT a.staff_id, a.solar_year, a.solar_month, a.amount::float8 FROM salary_accruals a \
         LEFT JOIN expenses e ON e.id = a.expense_id \
         WHERE a.staff_id = ANY($1) AND (a.expense_id IS NULL OR e.deleted_at IS NULL)",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    let taken: Vec<(Uuid, NaiveDate, f64)> = sqlx::query_as(
        "SELECT w.staff_id, w.taken_on, w.amount::float8 FROM withdrawals w JOIN staff s ON s.id = w.staff_id \
         WHERE w.staff_id = ANY($1) AND w.deleted_at IS NULL AND w.currency = 'AFN' \
           AND s.salary_from IS NOT NULL AND w.taken_on >= s.salary_from",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    let categories = sqlx::query_as("SELECT id, name FROM expense_categories WHERE department = 'hall' ORDER BY sort_order, name")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;

    // (person, year, month) -> totals
    let mut by: HashMap<(Uuid, i32, u32), Month> = HashMap::new();
    for (id, y, m, a) in accrued {
        by.entry((id, y, m as u32)).or_default().accrued += a;
    }
    for (id, day, a) in taken {
        by.entry((id, solar::year_of(day), solar::month_day(day).0)).or_default().taken += a;
    }
    let people = staff
        .into_iter()
        .map(|r| {
            let months = (1..=12).map(|m| by.get(&(r.id, year, m)).copied().unwrap_or_default()).collect();
            let (mut before, mut balance) = (0.0, 0.0);
            for (&(id, y, m), v) in &by {
                // "Up to today": a withdrawal typed with a later date waits for its month.
                if id == r.id && (y, m) <= (this_year, this_m) {
                    balance += v.accrued - v.taken;
                    if y < year {
                        before += v.accrued - v.taken;
                    }
                }
            }
            Person {
                id: r.id,
                full_name: r.full_name,
                title: r.title,
                monthly_salary: r.monthly_salary,
                category_id: r.category_id,
                category: r.category,
                salary_from: r.salary_from,
                active: r.active,
                months,
                before,
                balance,
            }
        })
        .collect();
    Ok(Json(Page { year, this_month: (year == this_year).then_some(this_m), people, categories }))
}

#[derive(Deserialize)]
pub struct Input {
    full_name: Option<String>,
    title: Option<String>,
    monthly_salary: f64,
    category_id: Uuid,
    /// Any day of the first Solar month that counts.
    from: NaiveDate,
    #[serde(default = "yes")]
    active: bool,
}
fn yes() -> bool {
    true
}

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

fn month_start(day: NaiveDate) -> NaiveDate {
    solar::to_gregorian(solar::year_of(day), solar::month_day(day).0, 1).unwrap_or(day)
}

async fn check(tx: &mut sqlx::PgConnection, i: &Input) -> Result<(), ApiError> {
    if !(i.monthly_salary.is_finite() && (0.0..=10_000_000.0).contains(&i.monthly_salary)) {
        return Err(ApiError::bad("bad_amount"));
    }
    // Every month from the start to today is written as an expense: keep it to real dates.
    if solar::year_of(i.from) < 1400 || i.from > today() + chrono::Days::new(366) {
        return Err(ApiError::bad("bad_date"));
    }
    let hall: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM expense_categories WHERE id = $1 AND department = 'hall')")
        .bind(i.category_id)
        .fetch_one(&mut *tx)
        .await?;
    if !hall {
        return Err(ApiError::bad("bad_salary_line"));
    }
    Ok(())
}

/// POST /api/v1/salaries (partners): a new person on the payroll.
pub async fn create(State(s): State<AppState>, user: CurrentUser, Json(i): Json<Input>) -> Result<Json<Uuid>, ApiError> {
    partner(&user)?;
    let name = clean(&i.full_name).ok_or(ApiError::bad("name_required"))?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    check(&mut tx, &i).await?;
    sqlx::query(
        "INSERT INTO staff (id, full_name, title, department, monthly_salary, salary_category_id, salary_from, active) \
         VALUES ($1, $2, $3, 'hall', $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(&name)
    .bind(clean(&i.title))
    .bind(i.monthly_salary)
    .bind(i.category_id)
    .bind(month_start(i.from))
    .bind(i.active)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if let Err(e) = post_due(&s.db).await {
        tracing::warn!("salary posting: {e:#}");
    }
    Ok(Json(id))
}

/// PUT /api/v1/salaries/:id (partners). A new amount counts from this month on (this month's
/// line is corrected); a later start removes the months before it; months while the person
/// was not working are not charged when they come back.
pub async fn update(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Json(i): Json<Input>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let from = month_start(i.from);
    let now = today();
    let (y, (m, _)) = (solar::year_of(now), solar::month_day(now));
    let mut tx = begin_as(&s.db, &user).await?;
    check(&mut tx, &i).await?;
    let was_active: Option<bool> = sqlx::query_scalar(&format!("SELECT s.active FROM staff s WHERE s.id = $1 AND {PAYROLL} FOR UPDATE"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let Some(was_active) = was_active else {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    };
    sqlx::query(
        "UPDATE staff SET full_name = COALESCE($2, full_name), title = $3, monthly_salary = $4, \
                salary_category_id = $5, salary_from = $6, active = $7, updated_at = now() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(clean(&i.full_name))
    .bind(clean(&i.title))
    .bind(i.monthly_salary)
    .bind(i.category_id)
    .bind(from)
    .bind(i.active)
    .execute(&mut *tx)
    .await?;
    if i.active && !was_active {
        // Back at work: the months off are marked as paid nothing, so they are not posted.
        let (mut fy, (mut fm, _)) = (solar::year_of(from), solar::month_day(from));
        while (fy, fm) < (y, m) {
            sqlx::query(
                "INSERT INTO salary_accruals (id, staff_id, solar_year, solar_month, amount) VALUES ($1, $2, $3, $4, 0) \
                 ON CONFLICT (staff_id, solar_year, solar_month) DO NOTHING",
            )
            .bind(Uuid::new_v4())
            .bind(id)
            .bind(fy)
            .bind(fm as i32)
            .execute(&mut *tx)
            .await?;
            (fy, fm) = if fm == 12 { (fy + 1, 1) } else { (fy, fm + 1) };
        }
    }
    // This month's line follows the new amount and statement line.
    sqlx::query(
        "UPDATE expenses e SET amount = $4, category_id = $5, updated_at = now() FROM salary_accruals a \
         WHERE a.expense_id = e.id AND a.staff_id = $1 AND a.solar_year = $2 AND a.solar_month = $3 AND e.deleted_at IS NULL",
    )
    .bind(id)
    .bind(y)
    .bind(m as i32)
    .bind(i.monthly_salary)
    .bind(i.category_id)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE salary_accruals SET amount = $4 WHERE staff_id = $1 AND solar_year = $2 AND solar_month = $3")
        .bind(id)
        .bind(y)
        .bind(m as i32)
        .bind(i.monthly_salary)
        .execute(&mut *tx)
        .await?;
    // Months before a later start are taken back.
    sqlx::query(
        "UPDATE expenses e SET deleted_at = now() FROM salary_accruals a \
         WHERE a.expense_id = e.id AND a.staff_id = $1 AND e.spent_on < $2 AND e.deleted_at IS NULL",
    )
    .bind(id)
    .bind(from)
    .execute(&mut *tx)
    .await?;
    let (fy, (fm, _)) = (solar::year_of(from), solar::month_day(from));
    sqlx::query("DELETE FROM salary_accruals WHERE staff_id = $1 AND (solar_year, solar_month) < ($2, $3)")
        .bind(id)
        .bind(fy)
        .bind(fm as i32)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    if let Err(e) = post_due(&s.db).await {
        tracing::warn!("salary posting: {e:#}");
    }
    Ok(StatusCode::NO_CONTENT)
}

/// Writes every salary month that is due and not written yet: from each person's first month
/// up to the month today is in. Safe to run any number of times.
pub async fn post_due(db: &PgPool) -> anyhow::Result<usize> {
    let now = today();
    let (ty, (tm, _)) = (solar::year_of(now), solar::month_day(now));
    let staff: Vec<(Uuid, String, f64, Uuid, NaiveDate)> = sqlx::query_as(&format!(
        "SELECT s.id, s.full_name, s.monthly_salary::float8, s.salary_category_id, s.salary_from FROM staff s \
         WHERE {PAYROLL} AND s.active AND s.monthly_salary > 0 \
           AND s.salary_category_id IS NOT NULL AND s.salary_from IS NOT NULL AND s.salary_from <= $1"
    ))
    .bind(now)
    .fetch_all(db)
    .await?;
    let done: Vec<(Uuid, i32, i32)> = sqlx::query_as("SELECT staff_id, solar_year, solar_month FROM salary_accruals")
        .fetch_all(db)
        .await?;
    let done: std::collections::HashSet<(Uuid, i32, i32)> = done.into_iter().collect();
    let mut written = 0;
    for (id, name, amount, category, from) in staff {
        let (mut y, (mut m, _)) = (solar::year_of(from), solar::month_day(from));
        while (y, m) <= (ty, tm) {
            if !done.contains(&(id, y, m as i32)) {
                let day = solar::to_gregorian(y, m, 1).expect("first of a Solar month");
                let expense = Uuid::new_v4();
                let mut tx = db.begin().await?;
                sqlx::query(
                    "INSERT INTO expenses (id, department, category_id, spent_on, description, amount) \
                     VALUES ($1, 'hall', $2, $3, $4, $5)",
                )
                .bind(expense)
                .bind(category)
                .bind(day)
                .bind(format!("معاش {name}، {} {y}", solar::MONTHS[m as usize - 1]))
                .bind(amount)
                .execute(&mut *tx)
                .await?;
                let posted = sqlx::query(
                    "INSERT INTO salary_accruals (id, staff_id, solar_year, solar_month, amount, expense_id) \
                     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (staff_id, solar_year, solar_month) DO NOTHING",
                )
                .bind(Uuid::new_v4())
                .bind(id)
                .bind(y)
                .bind(m as i32)
                .bind(amount)
                .bind(expense)
                .execute(&mut *tx)
                .await?
                .rows_affected();
                // Another run wrote this month first: drop ours.
                if posted == 1 {
                    tx.commit().await?;
                    written += 1;
                }
            }
            (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        }
    }
    Ok(written)
}

/// Posts due months right after start, then every 10 minutes (a new month begins at
/// midnight while the app may be running for days).
pub async fn schedule(db: PgPool) {
    let mut wait = Duration::from_secs(5);
    loop {
        tokio::time::sleep(wait).await;
        wait = Duration::from_secs(600);
        match post_due(&db).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("salary months posted: {n}"),
            Err(e) => tracing::warn!("salary posting: {e:#}"),
        }
    }
}
