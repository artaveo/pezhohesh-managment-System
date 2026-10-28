//! Staff salaries (the admin manager, the communications manager, Shams...). Each person has
//! a fixed monthly salary and the statement line they are paid under (اجوره مدیر اداری...).
//! The fixed salary is only a figure to compare with: the statement counts what was really
//! paid, the lines of that person's statement line, as in the Excel book (and so does the
//! partners' share formula). Each Solar month from the start the fixed amount is noted, and
//! the page shows, month by month, salary against what was paid: owed, or paid ahead.

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
    year: i32,
    month: u32,
    accrued: f64,
    taken: f64,
}

/// One payment to the person: a line of their statement line, or a withdrawal in their name.
#[derive(Serialize, FromRow)]
pub struct Payment {
    id: Uuid,
    day: NaiveDate,
    amount: f64,
    note: Option<String>,
    /// "expense" or "withdrawal".
    source: String,
    #[serde(skip)]
    staff_id: Uuid,
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
    /// Every month of the range asked for, from the first salary month up to this month, oldest first.
    months: Vec<Month>,
    /// The payments of the range, oldest first.
    payments: Vec<Payment>,
    /// Salary minus what was paid before the range (positive: owed to the person).
    opening: f64,
    /// The same up to today, whatever the range.
    balance: f64,
    last_paid: Option<NaiveDate>,
}

#[derive(Serialize)]
pub struct Page {
    this_year: i32,
    this_month: u32,
    people: Vec<Person>,
    /// Statement lines a salary can be paid under (partners set them).
    categories: Vec<Category>,
}

#[derive(Deserialize)]
pub struct Params {
    /// Inclusive days; left out = no limit. Months count whole.
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

const PAID: &str = "SELECT e.id, e.spent_on AS day, e.amount::float8 AS amount, e.description AS note, 'expense' AS source, s.id AS staff_id \
     FROM staff s JOIN expenses e ON e.category_id = s.salary_category_id AND e.department = 'hall' \
     WHERE s.id = ANY($1) AND e.deleted_at IS NULL AND e.currency = 'AFN' AND e.spent_on >= s.salary_from \
     UNION ALL \
     SELECT w.id, w.taken_on, w.amount::float8, w.note, 'withdrawal', w.staff_id FROM withdrawals w JOIN staff s ON s.id = w.staff_id \
     WHERE w.staff_id = ANY($1) AND w.deleted_at IS NULL AND w.currency = 'AFN' \
       AND s.salary_from IS NOT NULL AND w.taken_on >= s.salary_from \
     ORDER BY day, amount";

fn next((y, m): (i32, u32)) -> (i32, u32) {
    if m == 12 { (y + 1, 1) } else { (y, m + 1) }
}

/// GET /api/v1/salaries?from=&to=: everyone on the payroll, and each one's account over the range.
pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Page>, ApiError> {
    hall_only(&user)?;
    if p.from.zip(p.to).is_some_and(|(f, t)| t < f) {
        return Err(ApiError::bad("bad_range"));
    }
    let now = today();
    let this = (solar::year_of(now), solar::month_day(now).0);
    let ym = |d: NaiveDate| (solar::year_of(d), solar::month_day(d).0);
    let lo = p.from.map(ym);
    let hi = p.to.map(ym).map_or(this, |h| h.min(this));

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
    let accrued: Vec<(Uuid, i32, i32, f64)> = sqlx::query_as(
        "SELECT staff_id, solar_year, solar_month, amount::float8 FROM salary_accruals WHERE staff_id = ANY($1)",
    )
    .bind(&ids)
    .fetch_all(&mut *tx)
    .await?;
    // Paid: the lines of the person's statement line (from the Excel book or typed since),
    // and any withdrawal written under their name, from their first salary month on.
    let paid: Vec<Payment> = sqlx::query_as(PAID).bind(&ids).fetch_all(&mut *tx).await?;
    let categories = sqlx::query_as("SELECT id, name FROM expense_categories WHERE department = 'hall' ORDER BY sort_order, name")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;

    // (person, year, month) -> totals
    let mut by: HashMap<(Uuid, i32, u32), (f64, f64)> = HashMap::new();
    for (id, y, m, a) in accrued {
        by.entry((id, y, m as u32)).or_default().0 += a;
    }
    for pay in &paid {
        let (y, m) = ym(pay.day);
        by.entry((pay.staff_id, y, m)).or_default().1 += pay.amount;
    }
    let mut paid_by: HashMap<Uuid, Vec<Payment>> = HashMap::new();
    for pay in paid {
        paid_by.entry(pay.staff_id).or_default().push(pay);
    }
    let people = staff
        .into_iter()
        .map(|r| {
            let (mut opening, mut balance) = (0.0, 0.0);
            let mut first: Option<(i32, u32)> = r.salary_from.map(ym);
            for (&(id, y, m), (a, t)) in &by {
                // "Up to today": a payment typed with a later date waits for its month.
                if id == r.id && (y, m) <= this {
                    balance += a - t;
                    if lo.is_some_and(|lo| (y, m) < lo) {
                        opening += a - t;
                    }
                    first = Some(first.map_or((y, m), |f| f.min((y, m))));
                }
            }
            let mut months = Vec::new();
            if let Some(first) = first {
                let mut at = lo.map_or(first, |lo| lo.max(first));
                while at <= hi {
                    let (a, t) = by.get(&(r.id, at.0, at.1)).copied().unwrap_or_default();
                    months.push(Month { year: at.0, month: at.1, accrued: a, taken: t });
                    at = next(at);
                }
            }
            let all = paid_by.remove(&r.id).unwrap_or_default();
            let last_paid = all.iter().map(|p| p.day).filter(|d| *d <= now).max();
            let payments = all
                .into_iter()
                .filter(|p| lo.is_none_or(|lo| ym(p.day) >= lo) && ym(p.day) <= hi)
                .collect();
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
                payments,
                opening,
                balance,
                last_paid,
            }
        })
        .collect();
    Ok(Json(Page { this_year: this.0, this_month: this.1, people, categories }))
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
    /// On a change: any day of the first month the new amount counts from (this month if left out).
    #[serde(default)]
    amount_from: Option<NaiveDate>,
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

async fn check(tx: &mut sqlx::PgConnection, i: &Input, id: Option<Uuid>) -> Result<(), ApiError> {
    if !(i.monthly_salary.is_finite() && (0.0..=10_000_000.0).contains(&i.monthly_salary)) {
        return Err(ApiError::bad("bad_amount"));
    }
    // Every month from the start to today gets its salary noted: keep it to real dates.
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
    // What a person was paid is read from their line, so two people cannot share one.
    let shared: bool = sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM staff s WHERE {PAYROLL} AND s.salary_category_id = $1 AND s.id IS DISTINCT FROM $2)"
    ))
    .bind(i.category_id)
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if shared {
        return Err(ApiError(StatusCode::CONFLICT, "salary_line_taken"));
    }
    Ok(())
}

/// POST /api/v1/salaries (partners): a new person on the payroll.
pub async fn create(State(s): State<AppState>, user: CurrentUser, Json(i): Json<Input>) -> Result<Json<Uuid>, ApiError> {
    partner(&user)?;
    let name = clean(&i.full_name).ok_or(ApiError::bad("name_required"))?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    check(&mut tx, &i, None).await?;
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

/// PUT /api/v1/salaries/:id (partners). A new amount counts from this month on; a later start
/// removes the months before it; months while the person was not working are not counted
/// when they come back.
pub async fn update(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Json(i): Json<Input>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let from = month_start(i.from);
    let now = today();
    let (y, (m, _)) = (solar::year_of(now), solar::month_day(now));
    let mut tx = begin_as(&s.db, &user).await?;
    check(&mut tx, &i, Some(id)).await?;
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
        // Back at work: the months off are noted with no salary.
        let (mut fy, (mut fm, _)) = (solar::year_of(from), solar::month_day(from));
        while (fy, fm) < (y, m) {
            sqlx::query(
                "INSERT INTO salary_accruals (id, staff_id, solar_year, solar_month, amount) VALUES ($1, $2, $3, $4, 0) \
                 ON CONFLICT (staff_id, solar_year, solar_month) DO NOTHING",
            )
            .bind(accrual_id(id, fy, fm))
            .bind(id)
            .bind(fy)
            .bind(fm as i32)
            .execute(&mut *tx)
            .await?;
            (fy, fm) = if fm == 12 { (fy + 1, 1) } else { (fy, fm + 1) };
        }
    }
    // The new amount counts from the month asked for (this month by default); earlier months
    // keep the salary they had, as a raise does not change what was due before.
    let (ay, am) = i.amount_from.map_or((y, m), |d| (solar::year_of(d), solar::month_day(d).0));
    sqlx::query(
        "UPDATE salary_accruals SET amount = $4 WHERE staff_id = $1 AND (solar_year, solar_month) >= ($2, $3) AND amount <> 0",
    )
    .bind(id)
    .bind(ay)
    .bind(am as i32)
    .bind(i.monthly_salary)
    .execute(&mut *tx)
    .await?;
    // Months before a later start are taken back.
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

#[derive(Deserialize)]
pub struct MonthInput {
    year: i32,
    month: u32,
    amount: f64,
}

/// PUT /api/v1/salaries/:id/month (partners): corrects the salary of one month already noted.
pub async fn set_month(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Json(i): Json<MonthInput>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if !(i.amount.is_finite() && (0.0..=10_000_000.0).contains(&i.amount)) {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let n = sqlx::query(&format!(
        "UPDATE salary_accruals a SET amount = $4 FROM staff s \
         WHERE a.staff_id = s.id AND s.id = $1 AND {PAYROLL} AND a.solar_year = $2 AND a.solar_month = $3"
    ))
    .bind(id)
    .bind(i.year)
    .bind(i.month as i32)
    .bind(i.amount)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if n == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// One person's month always gets the same id, on every computer: two computers that both
/// note the same month offline then hold the same row, and sync merges them into one.
fn accrual_id(staff: Uuid, year: i32, month: u32) -> Uuid {
    Uuid::new_v5(&staff, format!("salary-{year}-{month}").as_bytes())
}

/// Notes the fixed salary of every month that is due and not noted yet: from each person's
/// first month up to the month today is in. Safe to run any number of times.
pub async fn post_due(db: &PgPool) -> anyhow::Result<usize> {
    let now = today();
    let (ty, (tm, _)) = (solar::year_of(now), solar::month_day(now));
    let staff: Vec<(Uuid, f64, NaiveDate)> = sqlx::query_as(&format!(
        "SELECT s.id, s.monthly_salary::float8, s.salary_from FROM staff s \
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
    for (id, amount, from) in staff {
        let (mut y, (mut m, _)) = (solar::year_of(from), solar::month_day(from));
        while (y, m) <= (ty, tm) {
            if !done.contains(&(id, y, m as i32)) {
                written += sqlx::query(
                    "INSERT INTO salary_accruals (id, staff_id, solar_year, solar_month, amount) \
                     VALUES ($1, $2, $3, $4, $5) ON CONFLICT (staff_id, solar_year, solar_month) DO NOTHING",
                )
                .bind(accrual_id(id, y, m))
                .bind(id)
                .bind(y)
                .bind(m as i32)
                .bind(amount)
                .execute(db)
                .await?
                .rows_affected() as usize;
            }
            (y, m) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
        }
    }
    Ok(written)
}

/// Notes due months right after start, then every 10 minutes (a new month begins at
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
