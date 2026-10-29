//! Lending books, as in the Excel book's two lending sheets. A borrower leaves a guarantee
//! first (cash, books, or a person who vouches); the guarantee is their lending card. A
//! study-hall member may borrow on their membership instead. The weekly fee and the late
//! fine are paid when the book comes back, on a bill; a guarantee is money held, never income.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{clean, hall_only, issue, today, typed_today};
use crate::lists::pattern;
use crate::AppState;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

fn money_ok(a: f64) -> Result<(), ApiError> {
    if a.is_finite() && a >= 0.0 { Ok(()) } else { Err(ApiError::bad("bad_amount")) }
}

/// A date typed for something that already happened: not in the future.
fn past(d: Option<NaiveDate>) -> Result<NaiveDate, ApiError> {
    let d = d.unwrap_or_else(today);
    if d > today() { Err(ApiError::bad("future_date")) } else { Ok(d) }
}

/// Partners may remove anything; the manager only what was typed today.
fn removable(user: &CurrentUser, created: DateTime<Utc>) -> bool {
    user.is_partner() || typed_today(created)
}

// ---------------------------------------------------------------------------
// Lending rules

#[derive(Serialize, Deserialize, FromRow, Clone, Copy)]
pub struct Rules {
    loan_days: i32,
    weekly_fee: f64,
    fine_per_day: f64,
}

async fn rules_of(tx: &mut PgConnection) -> Result<Rules, ApiError> {
    Ok(sqlx::query_as(
        "SELECT COALESCE((SELECT (value #>> '{}')::int FROM settings WHERE key = 'book_loan_days'), 14) AS loan_days, \
                COALESCE((SELECT (value #>> '{}')::float8 FROM settings WHERE key = 'book_weekly_fee'), 0) AS weekly_fee, \
                COALESCE((SELECT (value #>> '{}')::float8 FROM settings WHERE key = 'book_fine_per_day'), 0) AS fine_per_day",
    )
    .fetch_one(&mut *tx)
    .await?)
}

pub async fn rules(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Rules>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let r = rules_of(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(r))
}

pub async fn set_rules(State(s): State<AppState>, user: CurrentUser, Json(r): Json<Rules>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    money_ok(r.weekly_fee)?;
    money_ok(r.fine_per_day)?;
    if !(1..=366).contains(&r.loan_days) {
        return Err(ApiError::bad("bad_days"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    for (key, value) in [
        ("book_loan_days", serde_json::json!(r.loan_days)),
        ("book_weekly_fee", serde_json::json!(r.weekly_fee)),
        ("book_fine_per_day", serde_json::json!(r.fine_per_day)),
    ] {
        sqlx::query(
            "INSERT INTO settings (key, value) VALUES ($1, $2) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(key)
        .bind(value)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Guarantees (the lending cards)

const KINDS: [(&str, &str); 3] = [("cash", "p-"), ("book", "k-"), ("person", "z-")];

fn prefix(kind: &str) -> Result<&'static str, ApiError> {
    KINDS.iter().find(|(k, _)| *k == kind).map(|(_, p)| *p).ok_or(ApiError::bad("bad_kind"))
}

#[derive(Serialize, FromRow)]
pub struct Deposit {
    id: Uuid,
    code: String,
    kind: String,
    name: String,
    father_name: Option<String>,
    phone: Option<String>,
    member_id: Option<Uuid>,
    member_no: Option<i32>,
    amount: Option<f64>,
    deposit_book: Option<String>,
    guarantor: Option<String>,
    note: Option<String>,
    received_on: NaiveDate,
    returned_on: Option<NaiveDate>,
    open_loans: i64,
    #[serde(skip)]
    created_at: DateTime<Utc>,
    #[sqlx(skip)]
    removable: bool,
}

#[derive(Serialize)]
pub struct DepositPage {
    total: i64,
    /// Cash guarantees not given back yet: money that belongs to borrowers.
    cash_held: f64,
    rows: Vec<Deposit>,
}

#[derive(Deserialize)]
pub struct DepositQuery {
    /// open (default) | all
    scope: Option<String>,
    q: Option<String>,
}

const DEPOSIT_SELECT: &str = "SELECT d.id, d.code, d.kind::text AS kind, d.name, d.father_name, d.phone, \
        d.member_id, m.member_no, d.amount::float8 AS amount, d.deposit_book, d.guarantor, d.note, \
        d.received_on, d.returned_on, d.created_at, \
        (SELECT count(*) FROM book_loans l WHERE l.deposit_id = d.id AND l.returned_on IS NULL AND l.deleted_at IS NULL) AS open_loans \
    FROM loan_deposits d LEFT JOIN members m ON m.id = d.member_id";

pub async fn deposits(State(s): State<AppState>, user: CurrentUser, Query(p): Query<DepositQuery>) -> Result<Json<DepositPage>, ApiError> {
    hall_only(&user)?;
    let open = p.scope.as_deref() != Some("all");
    let filter = "d.deleted_at IS NULL AND ($1 = false OR d.returned_on IS NULL) \
        AND ($2::text IS NULL OR d.code ILIKE $2 OR d.name ILIKE $2 OR d.father_name ILIKE $2 OR d.phone ILIKE $2 \
             OR d.deposit_book ILIKE $2 OR d.guarantor ILIKE $2)";
    let q = pattern(&p.q);
    let mut tx = begin_as(&s.db, &user).await?;
    let (total, cash_held): (i64, f64) = sqlx::query_as(&format!(
        "SELECT count(*), COALESCE(sum(d.amount) FILTER (WHERE d.kind = 'cash' AND d.returned_on IS NULL), 0)::float8 \
         FROM loan_deposits d WHERE {filter}"
    ))
    .bind(open)
    .bind(&q)
    .fetch_one(&mut *tx)
    .await?;
    let mut rows: Vec<Deposit> = sqlx::query_as(&format!(
        "{DEPOSIT_SELECT} WHERE {filter} ORDER BY d.returned_on IS NOT NULL, d.received_on DESC, d.created_at DESC LIMIT 500"
    ))
    .bind(open)
    .bind(&q)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    for d in &mut rows {
        d.removable = removable(&user, d.created_at);
    }
    Ok(Json(DepositPage { total, cash_held, rows }))
}

#[derive(Deserialize)]
pub struct KindQuery {
    kind: String,
}

async fn next_code_of(tx: &mut PgConnection, kind: &str) -> Result<String, ApiError> {
    let prefix = prefix(kind)?;
    // Cards are numbered from 101 like the Excel book, one series per kind.
    let last: Option<i32> = sqlx::query_scalar(
        "SELECT max(substring(code FROM 3)::int) FROM loan_deposits WHERE lower(left(code, 2)) = $1 AND substring(code FROM 3) ~ '^[0-9]{1,6}$'",
    )
    .bind(prefix)
    .fetch_one(&mut *tx)
    .await?;
    Ok(format!("{prefix}{}", last.map_or(101, |n| n + 1)))
}

pub async fn next_code(State(s): State<AppState>, user: CurrentUser, Query(k): Query<KindQuery>) -> Result<Json<String>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let code = next_code_of(&mut tx, &k.kind).await?;
    tx.commit().await?;
    Ok(Json(code))
}

#[derive(Deserialize)]
pub struct DepositInput {
    kind: String,
    /// Default: the next card number of its kind. Typed when an old paper card is entered.
    code: Option<String>,
    name: String,
    father_name: Option<String>,
    phone: Option<String>,
    member_id: Option<Uuid>,
    amount: Option<f64>,
    deposit_book: Option<String>,
    guarantor: Option<String>,
    note: Option<String>,
    received_on: Option<NaiveDate>,
}

#[derive(Serialize)]
pub struct SavedDeposit {
    id: Uuid,
    code: String,
}

pub async fn create_deposit(State(s): State<AppState>, user: CurrentUser, Json(d): Json<DepositInput>) -> Result<Json<SavedDeposit>, ApiError> {
    hall_only(&user)?;
    prefix(&d.kind)?;
    let name = d.name.trim();
    if name.is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    let (amount, book, guarantor) = (d.amount, clean(&d.deposit_book), clean(&d.guarantor));
    match d.kind.as_str() {
        "cash" if !amount.is_some_and(|a| a.is_finite() && a > 0.0) => return Err(ApiError::bad("bad_amount")),
        "book" if book.is_none() => return Err(ApiError::bad("deposit_book_required")),
        "person" if guarantor.is_none() => return Err(ApiError::bad("guarantor_required")),
        _ => {}
    }
    let received_on = past(d.received_on)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let code = match clean(&d.code) {
        Some(c) if c.chars().count() <= 20 => c,
        Some(_) => return Err(ApiError::bad("bad_code")),
        None => {
            // Two desks saving at once must not both take the next number.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext('loan_deposits.code'))").execute(&mut *tx).await?;
            next_code_of(&mut tx, &d.kind).await?
        }
    };
    let id = Uuid::new_v4();
    let inserted = sqlx::query(
        "INSERT INTO loan_deposits (id, code, kind, name, father_name, phone, member_id, amount, deposit_book, guarantor, note, received_on) \
         VALUES ($1, $2, $3::deposit_kind, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
    )
    .bind(id)
    .bind(&code)
    .bind(&d.kind)
    .bind(name)
    .bind(clean(&d.father_name))
    .bind(clean(&d.phone))
    .bind(d.member_id)
    .bind(if d.kind == "cash" { amount } else { None })
    .bind(if d.kind == "book" { book } else { None })
    .bind(if d.kind == "person" { guarantor } else { None })
    .bind(clean(&d.note))
    .bind(received_on)
    .execute(&mut *tx)
    .await;
    match inserted {
        Err(sqlx::Error::Database(e)) if e.constraint() == Some("loan_deposits_code_key") => {
            return Err(ApiError(StatusCode::CONFLICT, "code_taken"))
        }
        r => r?,
    };
    tx.commit().await?;
    Ok(Json(SavedDeposit { id, code }))
}

#[derive(Deserialize)]
pub struct ReturnDeposit {
    returned_on: Option<NaiveDate>,
}

/// The guarantee goes back to the borrower; only once every book of the card is back.
pub async fn return_deposit(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<ReturnDeposit>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let on = past(r.returned_on)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(NaiveDate, Option<NaiveDate>, i64)> = sqlx::query_as(
        "SELECT d.received_on, d.returned_on, \
                (SELECT count(*) FROM book_loans l WHERE l.deposit_id = d.id AND l.returned_on IS NULL AND l.deleted_at IS NULL) \
         FROM loan_deposits d WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (received, returned, open) = row.ok_or(NOT_FOUND)?;
    if returned.is_some() {
        return Err(ApiError::bad("already_returned"));
    }
    if open > 0 {
        return Err(ApiError(StatusCode::CONFLICT, "has_open_loans"));
    }
    if on < received {
        return Err(ApiError::bad("before_start"));
    }
    sqlx::query("UPDATE loan_deposits SET returned_on = $2, returned_by = $3 WHERE id = $1")
        .bind(id)
        .bind(on)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A card typed in by mistake, before any book was lent on it.
pub async fn delete_deposit(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(DateTime<Utc>, bool)> = sqlx::query_as(
        "SELECT d.created_at, EXISTS (SELECT 1 FROM book_loans l WHERE l.deposit_id = d.id AND l.deleted_at IS NULL) \
         FROM loan_deposits d WHERE d.id = $1 AND d.deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (created, has_loans) = row.ok_or(NOT_FOUND)?;
    if has_loans {
        return Err(ApiError(StatusCode::CONFLICT, "has_loans"));
    }
    if !removable(&user, created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    sqlx::query("UPDATE loan_deposits SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Who may borrow: an open guarantee, or a study-hall member

#[derive(Serialize, FromRow)]
pub struct Borrower {
    /// deposit | member
    kind: String,
    id: Uuid,
    card_no: String,
    name: String,
    father_name: Option<String>,
    phone: Option<String>,
    /// What the guarantee is (500 افغانی, 3 جلد, a person's name); members have none.
    guarantee: Option<String>,
    open_loans: i64,
    /// Members: whether their seat or internet membership is running today.
    active: bool,
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
}

pub async fn borrowers(State(s): State<AppState>, user: CurrentUser, Query(p): Query<SearchQuery>) -> Result<Json<Vec<Borrower>>, ApiError> {
    hall_only(&user)?;
    let Some(q) = pattern(&p.q) else { return Ok(Json(vec![])) };
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        "(SELECT 'deposit' AS kind, d.id, d.code AS card_no, d.name, d.father_name, d.phone, \
                 CASE d.kind WHEN 'cash' THEN rtrim(rtrim(d.amount::text, '0'), '.') || ' افغانی' \
                             WHEN 'book' THEN d.deposit_book ELSE 'ضمانت ' || d.guarantor END AS guarantee, \
                 (SELECT count(*) FROM book_loans l WHERE l.deposit_id = d.id AND l.returned_on IS NULL AND l.deleted_at IS NULL) AS open_loans, \
                 true AS active \
          FROM loan_deposits d \
          WHERE d.deleted_at IS NULL AND d.returned_on IS NULL \
            AND (d.code ILIKE $1 OR d.name ILIKE $1 OR d.father_name ILIKE $1 OR d.phone ILIKE $1) \
          ORDER BY lower(d.code) = lower($2) DESC, d.name LIMIT 15) \
         UNION ALL \
         (SELECT 'member', m.id, m.member_no::text, trim(m.first_name || ' ' || COALESCE(m.last_name, '')), m.father_name, m.phone, NULL, \
                 (SELECT count(*) FROM book_loans l WHERE l.member_id = m.id AND l.returned_on IS NULL AND l.deleted_at IS NULL), \
                 EXISTS (SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
                         WHERE ms.member_id = m.id AND ms.deleted_at IS NULL AND p.kind <> 'daily' AND ms.end_date >= current_date) \
          FROM members m \
          WHERE m.deleted_at IS NULL \
            AND (m.member_no::text LIKE $1 OR m.first_name ILIKE $1 OR m.last_name ILIKE $1 OR m.father_name ILIKE $1 OR m.phone ILIKE $1) \
          ORDER BY m.member_no::text = $2 DESC, m.first_name LIMIT 15)",
    )
    .bind(&q)
    .bind(p.q.as_deref().unwrap_or("").trim())
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

/// Titles lent before, so the form can suggest them while typing.
pub async fn titles(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<String>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_scalar(
        "SELECT book_title FROM book_loans WHERE deleted_at IS NULL AND book_title IS NOT NULL \
         GROUP BY book_title ORDER BY max(loaned_on) DESC LIMIT 1000",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

// ---------------------------------------------------------------------------
// Loans

#[derive(Deserialize)]
pub struct LoanInput {
    deposit_id: Option<Uuid>,
    member_id: Option<Uuid>,
    /// The catalogue book, when it was picked from the list; its title is kept on the loan too.
    book_id: Option<Uuid>,
    #[serde(default)]
    book_title: String,
    /// Default: today.
    loaned_on: Option<NaiveDate>,
    /// Default: the lending days of the rules after `loaned_on`.
    due_on: Option<NaiveDate>,
    /// Default: the weekly fee of the rules (0 lends for free).
    weekly_fee: Option<f64>,
    note: Option<String>,
}

pub async fn lend(State(s): State<AppState>, user: CurrentUser, Json(l): Json<LoanInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let loaned_on = past(l.loaned_on)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let title = match l.book_id {
        Some(b) => sqlx::query_scalar::<_, String>("SELECT title FROM books WHERE id = $1 AND deleted_at IS NULL")
            .bind(b)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(NOT_FOUND)?,
        None => l.book_title.trim().to_string(),
    };
    if title.is_empty() {
        return Err(ApiError::bad("title_required"));
    }
    match (l.deposit_id, l.member_id) {
        (Some(d), None) => {
            let open: Option<bool> =
                sqlx::query_scalar("SELECT returned_on IS NULL FROM loan_deposits WHERE id = $1 AND deleted_at IS NULL FOR SHARE")
                    .bind(d)
                    .fetch_optional(&mut *tx)
                    .await?;
            match open {
                None => return Err(NOT_FOUND),
                Some(false) => return Err(ApiError::bad("deposit_returned")),
                Some(true) => {}
            }
        }
        (None, Some(m)) => {
            let found: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE id = $1 AND deleted_at IS NULL)")
                .bind(m)
                .fetch_one(&mut *tx)
                .await?;
            if !found {
                return Err(NOT_FOUND);
            }
        }
        _ => return Err(ApiError::bad("borrower_required")),
    }
    let rules = rules_of(&mut tx).await?;
    let due_on = l.due_on.unwrap_or(loaned_on + chrono::Days::new(rules.loan_days as u64));
    if due_on < loaned_on {
        return Err(ApiError::bad("before_start"));
    }
    let weekly_fee = l.weekly_fee.unwrap_or(rules.weekly_fee);
    money_ok(weekly_fee)?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO book_loans (id, member_id, deposit_id, book_id, book_title, loaned_on, due_on, weekly_fee, note) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(id)
    .bind(l.member_id)
    .bind(l.deposit_id)
    .bind(l.book_id)
    .bind(&title)
    .bind(loaned_on)
    .bind(due_on)
    .bind(weekly_fee)
    .bind(clean(&l.note))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

#[derive(Serialize, FromRow)]
pub struct Loan {
    id: Uuid,
    book_title: String,
    card_no: String,
    borrower: String,
    phone: Option<String>,
    loaned_on: NaiveDate,
    due_on: NaiveDate,
    returned_on: Option<NaiveDate>,
    weekly_fee: f64,
    fee_paid: f64,
    fine: f64,
    note: Option<String>,
    receipt_id: Option<Uuid>,
    #[serde(skip)]
    created_at: DateTime<Utc>,
    #[sqlx(skip)]
    removable: bool,
    /// What returning it on `on` costs (the return form starts from these).
    #[sqlx(skip)]
    charge: Option<Charge>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Debug)]
pub struct Charge {
    weeks: i64,
    days_late: i64,
    fee: f64,
    fine: f64,
}

/// Every started week costs the weekly fee (at least one week); every day past the due
/// date costs the fine.
fn charge(loaned_on: NaiveDate, due_on: NaiveDate, on: NaiveDate, weekly_fee: f64, fine_per_day: f64) -> Charge {
    let days = (on - loaned_on).num_days().max(0);
    let weeks = ((days + 6) / 7).max(1);
    let days_late = (on - due_on).num_days().max(0);
    Charge { weeks, days_late, fee: weeks as f64 * weekly_fee, fine: days_late as f64 * fine_per_day }
}

#[derive(Deserialize)]
pub struct OnQuery {
    on: Option<NaiveDate>,
}

pub async fn loan(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Query(q): Query<OnQuery>) -> Result<Json<Loan>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let mut l: Loan = sqlx::query_as(
        "SELECT l.id, COALESCE(b.title, l.book_title, '—') AS book_title, \
                COALESCE(d.code, m.member_no::text) AS card_no, \
                COALESCE(d.name, trim(m.first_name || ' ' || COALESCE(m.last_name, ''))) AS borrower, \
                COALESCE(d.phone, m.phone) AS phone, l.loaned_on, l.due_on, l.returned_on, \
                l.weekly_fee::float8 AS weekly_fee, l.fee_paid::float8 AS fee_paid, l.fine::float8 AS fine, l.note, l.created_at, \
                (SELECT r.id FROM receipts r WHERE r.book_loan_id = l.id AND NOT r.voided AND r.deleted_at IS NULL LIMIT 1) AS receipt_id \
         FROM book_loans l LEFT JOIN members m ON m.id = l.member_id LEFT JOIN loan_deposits d ON d.id = l.deposit_id \
         LEFT JOIN books b ON b.id = l.book_id \
         WHERE l.id = $1 AND l.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(NOT_FOUND)?;
    let rules = rules_of(&mut tx).await?;
    tx.commit().await?;
    l.removable = l.returned_on.is_none() && removable(&user, l.created_at);
    if l.returned_on.is_none() {
        l.charge = Some(charge(l.loaned_on, l.due_on, q.on.unwrap_or_else(today), l.weekly_fee, rules.fine_per_day));
    }
    Ok(Json(l))
}

#[derive(Deserialize)]
pub struct ReturnLoan {
    returned_on: Option<NaiveDate>,
    /// What was taken; the form fills in the computed charge and the desk may change it.
    fee: f64,
    fine: f64,
}

#[derive(Serialize)]
pub struct Returned {
    receipt_id: Option<Uuid>,
}

#[derive(FromRow)]
struct OutLoan {
    loaned_on: NaiveDate,
    due_on: NaiveDate,
    returned_on: Option<NaiveDate>,
    book_title: Option<String>,
    weekly_fee: f64,
    who: String,
}

/// The book is back: its fee and fine (when not zero) get one bill.
pub async fn return_loan(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(r): Json<ReturnLoan>,
) -> Result<Json<Returned>, ApiError> {
    hall_only(&user)?;
    money_ok(r.fee)?;
    money_ok(r.fine)?;
    let on = past(r.returned_on)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<OutLoan> = sqlx::query_as(
        "SELECT l.loaned_on, l.due_on, l.returned_on, COALESCE(b.title, l.book_title) AS book_title, l.weekly_fee::float8 AS weekly_fee, \
                COALESCE(d.name, trim(m.first_name || ' ' || COALESCE(m.last_name, ''))) AS who \
         FROM book_loans l LEFT JOIN members m ON m.id = l.member_id LEFT JOIN loan_deposits d ON d.id = l.deposit_id \
         LEFT JOIN books b ON b.id = l.book_id \
         WHERE l.id = $1 AND l.deleted_at IS NULL FOR UPDATE OF l",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let OutLoan { loaned_on, due_on, returned_on, book_title: title, weekly_fee, who } = row.ok_or(NOT_FOUND)?;
    if returned_on.is_some() {
        return Err(ApiError::bad("already_returned"));
    }
    if on < loaned_on {
        return Err(ApiError::bad("before_start"));
    }
    sqlx::query("UPDATE book_loans SET returned_on = $2, returned_by = $3, fee_paid = $4, fine = $5 WHERE id = $1")
        .bind(id)
        .bind(on)
        .bind(user.id)
        .bind(r.fee)
        .bind(r.fine)
        .execute(&mut *tx)
        .await?;
    let total = r.fee + r.fine;
    let receipt_id = if total > 0.0 {
        let c = charge(loaned_on, due_on, on, weekly_fee, 0.0);
        let mut what = format!("«{}»", title.as_deref().unwrap_or("—"));
        if r.fee > 0.0 {
            what += &if weekly_fee > 0.0 { format!("، فیس {} هفته", c.weeks) } else { "، فیس".into() };
        }
        if r.fine > 0.0 {
            what += &if c.days_late > 0 { format!("، جریمهٔ {} روز دیرکرد", c.days_late) } else { "، جریمه".into() };
        }
        what += &format!(" · {who}");
        Some(issue(&mut tx, &user, "books", total, &what, None, Some(id)).await?)
    } else {
        None
    };
    tx.commit().await?;
    Ok(Json(Returned { receipt_id }))
}

/// A loan typed in by mistake (the book is still out): partners any time, the manager the same day.
pub async fn delete_loan(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(DateTime<Utc>, bool)> =
        sqlx::query_as("SELECT created_at, returned_on IS NOT NULL FROM book_loans WHERE id = $1 AND deleted_at IS NULL")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let (created, returned) = row.ok_or(NOT_FOUND)?;
    if returned {
        return Err(ApiError(StatusCode::CONFLICT, "already_returned"));
    }
    if !removable(&user, created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    sqlx::query("UPDATE book_loans SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn charges() {
        let d = |m, dd| NaiveDate::from_ymd_opt(2026, m, dd).unwrap();
        // Same day: one week.
        assert_eq!(charge(d(10, 1), d(10, 15), d(10, 1), 20.0, 5.0), Charge { weeks: 1, days_late: 0, fee: 20.0, fine: 0.0 });
        // 14 days: two weeks, on time.
        assert_eq!(charge(d(10, 1), d(10, 15), d(10, 15), 20.0, 5.0), Charge { weeks: 2, days_late: 0, fee: 40.0, fine: 0.0 });
        // 15 days: a third week started, one day late.
        assert_eq!(charge(d(10, 1), d(10, 15), d(10, 16), 20.0, 5.0), Charge { weeks: 3, days_late: 1, fee: 60.0, fine: 5.0 });
    }
}
