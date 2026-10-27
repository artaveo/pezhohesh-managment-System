//! Money going out (expenses, partners' withdrawals) and the price list.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::typed_today;
use crate::AppState;

fn hall_only(user: &CurrentUser) -> Result<(), ApiError> {
    if user.sees_hall() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

fn amount_ok(a: f64) -> Result<(), ApiError> {
    if a.is_finite() && a > 0.0 { Ok(()) } else { Err(ApiError::bad("bad_amount")) }
}

fn note(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

/// Partners may remove any line; the manager only lines typed in the program today
/// (not lines from the Excel import).
fn removable(user: &CurrentUser, created: DateTime<Utc>, from_excel: bool) -> bool {
    user.is_partner() || (!from_excel && typed_today(created))
}

async fn may_remove(tx: &mut sqlx::PgConnection, user: &CurrentUser, table: &str, id: Uuid) -> Result<(), ApiError> {
    may_change(tx, user, table, id, false).await
}

/// The same rule for changing a line, removing it, and bringing a removed one back.
async fn may_change(tx: &mut sqlx::PgConnection, user: &CurrentUser, table: &str, id: Uuid, removed: bool) -> Result<(), ApiError> {
    let row: Option<(DateTime<Utc>, bool)> = sqlx::query_as(&format!(
        "SELECT created_at, import_batch_id IS NOT NULL FROM {table} WHERE id = $1 AND (deleted_at IS NOT NULL) = $2 FOR UPDATE"
    ))
    .bind(id)
    .bind(removed)
    .fetch_optional(&mut *tx)
    .await?;
    match row {
        None => Err(ApiError(StatusCode::NOT_FOUND, "not_found")),
        Some((created, excel)) if !removable(user, created, excel) => Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only")),
        Some(_) => Ok(()),
    }
}

/// Lists show the newest lines; the count and sum cover the whole range.
const SHOWN: i64 = 500;

#[derive(Deserialize)]
pub struct Reason {
    reason: Option<String>,
}

#[derive(Deserialize)]
pub struct Range {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

// ---------------------------------------------------------------------------
// Price list

#[derive(Serialize, FromRow)]
pub struct Plan {
    id: Uuid,
    kind: String,
    name: String,
    price: f64,
    duration_days: i32,
    active: bool,
    sort_order: i32,
}

pub async fn plans(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Plan>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        "SELECT id, kind::text AS kind, name, price::float8 AS price, duration_days, active, sort_order \
         FROM plans WHERE deleted_at IS NULL ORDER BY sort_order, name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct PlanInput {
    kind: String,
    name: String,
    price: f64,
    duration_days: i32,
    active: bool,
    sort_order: Option<i32>,
}

fn check_plan(p: &PlanInput) -> Result<(), ApiError> {
    if !matches!(p.kind.as_str(), "monthly" | "daily" | "internet") {
        return Err(ApiError::bad("bad_kind"));
    }
    if p.name.trim().is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    if !p.price.is_finite() || p.price < 0.0 || !(1..=366).contains(&p.duration_days) {
        return Err(ApiError::bad("bad_amount"));
    }
    Ok(())
}

pub async fn create_plan(State(s): State<AppState>, user: CurrentUser, Json(p): Json<PlanInput>) -> Result<Json<Uuid>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    check_plan(&p)?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO plans (id, kind, name, price, duration_days, active, sort_order) \
         VALUES ($1, $2::plan_kind, $3, $4, $5, $6, COALESCE($7, (SELECT COALESCE(max(sort_order), 0) + 1 FROM plans)))",
    )
    .bind(id)
    .bind(&p.kind)
    .bind(p.name.trim())
    .bind(p.price)
    .bind(p.duration_days)
    .bind(p.active)
    .bind(p.sort_order)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

/// A new price applies to bills from now on; bills already issued keep their amount.
pub async fn update_plan(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(p): Json<PlanInput>,
) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    check_plan(&p)?;
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "UPDATE plans SET kind = $2::plan_kind, name = $3, price = $4, duration_days = $5, active = $6, \
             sort_order = COALESCE($7, sort_order) WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(&p.kind)
    .bind(p.name.trim())
    .bind(p.price)
    .bind(p.duration_days)
    .bind(p.active)
    .bind(p.sort_order)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Expenses

#[derive(Serialize, FromRow)]
pub struct Category {
    id: Uuid,
    name: String,
}

pub async fn categories(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Category>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as("SELECT id, name FROM expense_categories WHERE department = 'hall' ORDER BY sort_order, name")
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CategoryInput {
    name: String,
}

pub async fn create_category(State(s): State<AppState>, user: CurrentUser, Json(c): Json<CategoryInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let name = c.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO expense_categories (id, department, name, sort_order) \
         VALUES (gen_random_uuid(), 'hall', $1, (SELECT COALESCE(max(sort_order), 0) + 1 FROM expense_categories WHERE department = 'hall')) \
         ON CONFLICT (department, name) DO UPDATE SET name = EXCLUDED.name RETURNING id",
    )
    .bind(name)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

#[derive(Serialize, FromRow)]
pub struct Expense {
    id: Uuid,
    spent_on: NaiveDate,
    category_id: Uuid,
    category: String,
    description: Option<String>,
    amount: f64,
    created_by: Option<String>,
    from_excel: bool,
    #[serde(skip)]
    created_at: DateTime<Utc>,
    #[sqlx(skip)]
    removable: bool,
}

#[derive(Serialize)]
pub struct Lines<T> {
    total: i64,
    sum: f64,
    rows: Vec<T>,
}

pub async fn expenses(State(s): State<AppState>, user: CurrentUser, Query(r): Query<Range>) -> Result<Json<Lines<Expense>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let filter = "e.deleted_at IS NULL AND e.department = 'hall' AND e.currency = 'AFN' \
        AND ($1::date IS NULL OR e.spent_on >= $1) AND ($2::date IS NULL OR e.spent_on <= $2)";
    let (total, sum): (i64, f64) = sqlx::query_as(&format!("SELECT count(*), COALESCE(sum(e.amount), 0)::float8 FROM expenses e WHERE {filter}"))
        .bind(r.from)
        .bind(r.to)
        .fetch_one(&mut *tx)
        .await?;
    let mut rows: Vec<Expense> = sqlx::query_as(&format!(
        "SELECT e.id, e.spent_on, e.category_id, c.name AS category, e.description, e.amount::float8 AS amount, \
                s.full_name AS created_by, e.import_batch_id IS NOT NULL AS from_excel, e.created_at \
         FROM expenses e JOIN expense_categories c ON c.id = e.category_id \
         LEFT JOIN app_users u ON u.id = e.created_by LEFT JOIN staff s ON s.id = u.staff_id \
         WHERE {filter} ORDER BY e.spent_on DESC, e.created_at DESC LIMIT {SHOWN}"
    ))
    .bind(r.from)
    .bind(r.to)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    rows.iter_mut().for_each(|e| e.removable = removable(&user, e.created_at, e.from_excel));
    Ok(Json(Lines { total, sum, rows }))
}

#[derive(Deserialize)]
pub struct ExpenseInput {
    category_id: Uuid,
    spent_on: Option<NaiveDate>,
    amount: f64,
    description: Option<String>,
}

pub async fn create_expense(State(s): State<AppState>, user: CurrentUser, Json(e): Json<ExpenseInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    amount_ok(e.amount)?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO expenses (id, department, category_id, spent_on, description, amount, created_by) \
         VALUES ($1, 'hall', $2, $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(e.category_id)
    .bind(e.spent_on.unwrap_or_else(today))
    .bind(note(&e.description))
    .bind(e.amount)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

pub async fn update_expense(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(e): Json<ExpenseInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    amount_ok(e.amount)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_remove(&mut tx, &user, "expenses", id).await?;
    sqlx::query("UPDATE expenses SET category_id = $2, spent_on = COALESCE($3, spent_on), description = $4, amount = $5 WHERE id = $1")
        .bind(id)
        .bind(e.category_id)
        .bind(e.spent_on)
        .bind(note(&e.description))
        .bind(e.amount)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_expense(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Query(r): Query<Reason>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_remove(&mut tx, &user, "expenses", id).await?;
    sqlx::query("UPDATE expenses SET deleted_at = now(), deleted_reason = $2 WHERE id = $1")
        .bind(id)
        .bind(note(&r.reason))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_expense(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_change(&mut tx, &user, "expenses", id, true).await?;
    sqlx::query("UPDATE expenses SET deleted_at = NULL, deleted_reason = NULL WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Withdrawals: cash a partner takes out of the profit. Staff are paid from their salary
// line (an expense), so the profit is not counted twice.

/// A partner: on the books as «شریک», or signed in with a partner's account.
const IS_PARTNER: &str = "(p.title = 'شریک' OR EXISTS (SELECT 1 FROM app_users u WHERE u.staff_id = p.id AND u.role = 'partner'))";

async fn partner_only(tx: &mut sqlx::PgConnection, staff_id: Uuid) -> Result<(), ApiError> {
    let ok: bool = sqlx::query_scalar(&format!("SELECT EXISTS (SELECT 1 FROM staff p WHERE p.id = $1 AND p.deleted_at IS NULL AND {IS_PARTNER})"))
        .bind(staff_id)
        .fetch_one(&mut *tx)
        .await?;
    if ok { Ok(()) } else { Err(ApiError::bad("partners_only")) }
}

#[derive(Serialize, FromRow)]
pub struct Person {
    id: Uuid,
    full_name: String,
    title: Option<String>,
}

pub async fn staff(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Person>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        &format!("SELECT id, full_name, title FROM staff p WHERE active AND deleted_at IS NULL AND {IS_PARTNER} ORDER BY full_name"),
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Serialize, FromRow)]
pub struct Withdrawal {
    id: Uuid,
    taken_on: NaiveDate,
    staff_id: Uuid,
    person: String,
    amount: f64,
    note: Option<String>,
    paid_by: Option<String>,
    from_excel: bool,
    #[serde(skip)]
    created_at: DateTime<Utc>,
    #[sqlx(skip)]
    removable: bool,
}

pub async fn withdrawals(State(s): State<AppState>, user: CurrentUser, Query(r): Query<Range>) -> Result<Json<Lines<Withdrawal>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let filter = "w.deleted_at IS NULL AND w.department = 'hall' AND w.currency = 'AFN' \
        AND ($1::date IS NULL OR w.taken_on >= $1) AND ($2::date IS NULL OR w.taken_on <= $2)";
    let (total, sum): (i64, f64) = sqlx::query_as(&format!("SELECT count(*), COALESCE(sum(w.amount), 0)::float8 FROM withdrawals w WHERE {filter}"))
        .bind(r.from)
        .bind(r.to)
        .fetch_one(&mut *tx)
        .await?;
    let mut rows: Vec<Withdrawal> = sqlx::query_as(&format!(
        "SELECT w.id, w.taken_on, w.staff_id, p.full_name AS person, w.amount::float8 AS amount, w.note, \
                s.full_name AS paid_by, w.import_batch_id IS NOT NULL AS from_excel, w.created_at \
         FROM withdrawals w JOIN staff p ON p.id = w.staff_id \
         LEFT JOIN app_users u ON u.id = w.paid_by LEFT JOIN staff s ON s.id = u.staff_id \
         WHERE {filter} ORDER BY w.taken_on DESC, w.created_at DESC LIMIT {SHOWN}"
    ))
    .bind(r.from)
    .bind(r.to)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    rows.iter_mut().for_each(|w| w.removable = removable(&user, w.created_at, w.from_excel));
    Ok(Json(Lines { total, sum, rows }))
}

#[derive(Deserialize)]
pub struct WithdrawalInput {
    staff_id: Uuid,
    taken_on: Option<NaiveDate>,
    amount: f64,
    note: Option<String>,
}

pub async fn create_withdrawal(State(s): State<AppState>, user: CurrentUser, Json(w): Json<WithdrawalInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    amount_ok(w.amount)?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    partner_only(&mut tx, w.staff_id).await?;
    sqlx::query(
        "INSERT INTO withdrawals (id, staff_id, department, taken_on, amount, note, paid_by) VALUES ($1, $2, 'hall', $3, $4, $5, $6)",
    )
    .bind(id)
    .bind(w.staff_id)
    .bind(w.taken_on.unwrap_or_else(today))
    .bind(w.amount)
    .bind(note(&w.note))
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

pub async fn update_withdrawal(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(w): Json<WithdrawalInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    amount_ok(w.amount)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_remove(&mut tx, &user, "withdrawals", id).await?;
    partner_only(&mut tx, w.staff_id).await?;
    sqlx::query("UPDATE withdrawals SET staff_id = $2, taken_on = COALESCE($3, taken_on), amount = $4, note = $5 WHERE id = $1")
        .bind(id)
        .bind(w.staff_id)
        .bind(w.taken_on)
        .bind(w.amount)
        .bind(note(&w.note))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn delete_withdrawal(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Query(r): Query<Reason>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_remove(&mut tx, &user, "withdrawals", id).await?;
    sqlx::query("UPDATE withdrawals SET deleted_at = now(), deleted_reason = $2 WHERE id = $1")
        .bind(id)
        .bind(note(&r.reason))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn restore_withdrawal(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    may_change(&mut tx, &user, "withdrawals", id, true).await?;
    sqlx::query("UPDATE withdrawals SET deleted_at = NULL, deleted_reason = NULL WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
