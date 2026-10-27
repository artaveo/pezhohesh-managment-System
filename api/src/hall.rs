//! Study-hall desk work: registering a member, renewing, daily seats, and the bills they
//! print. Every paid period gets one bill; a wrong bill is voided (with its period), never deleted.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::{solar, AppState};

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

pub fn hall_only(user: &CurrentUser) -> Result<(), ApiError> {
    if user.sees_hall() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

pub fn today() -> NaiveDate {
    chrono::Local::now().date_naive()
}

/// Whether a row was typed in today, by this computer's clock (the database may run in UTC).
pub fn typed_today(created: chrono::DateTime<chrono::Utc>) -> bool {
    created.with_timezone(&chrono::Local).date_naive() == today()
}

pub fn clean(s: &Option<String>) -> Option<String> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty()).map(String::from)
}

// ---------------------------------------------------------------------------
// Members

#[derive(Deserialize)]
pub struct MemberInput {
    member_no: Option<i32>,
    first_name: String,
    last_name: Option<String>,
    father_name: Option<String>,
    phone: Option<String>,
    field_of_study: Option<String>,
    tazkira_no: Option<String>,
    notes: Option<String>,
}

/// A paid period (or, with `record_only`, the dates of one already paid in the Excel book).
#[derive(Deserialize)]
pub struct PeriodInput {
    plan_id: Uuid,
    /// Default: the day after the previous period ended (even when that was weeks ago,
    /// so the missed days are charged), or today for a first period.
    start_date: Option<NaiveDate>,
    /// Default: the plan's price.
    fee: Option<f64>,
    #[serde(default)]
    discount: f64,
    #[serde(default)]
    record_only: bool,
}

#[derive(Deserialize)]
pub struct NewMember {
    member: MemberInput,
    period: Option<PeriodInput>,
}

#[derive(Serialize)]
pub struct Saved {
    member_id: Option<Uuid>,
    member_no: Option<i32>,
    membership_id: Option<Uuid>,
    receipt_id: Option<Uuid>,
}

#[derive(Serialize, FromRow)]
pub struct Member {
    id: Uuid,
    member_no: i32,
    first_name: String,
    last_name: Option<String>,
    father_name: Option<String>,
    phone: Option<String>,
    field_of_study: Option<String>,
    tazkira_no: Option<String>,
    joined_on: NaiveDate,
    notes: Option<String>,
}

#[derive(Serialize, FromRow)]
pub struct Period {
    id: Uuid,
    plan_name: String,
    kind: String,
    start_date: NaiveDate,
    end_date: NaiveDate,
    fee: f64,
    discount: f64,
    note: Option<String>,
    receipt_id: Option<Uuid>,
    receipt_no: Option<String>,
    #[serde(skip)]
    created_at: chrono::DateTime<chrono::Utc>,
    /// May this person remove it (only periods without a bill)?
    #[sqlx(skip)]
    removable: bool,
}

/// The seat and the internet plan run separately; each renews after its own last day.
#[derive(Serialize)]
pub struct Timeline {
    kind: &'static str,
    end_date: Option<NaiveDate>,
    days_left: Option<i32>,
    /// Where a renewal of this kind starts by default.
    next_start: NaiveDate,
}

#[derive(Serialize)]
pub struct MemberDetail {
    member: Member,
    periods: Vec<Period>,
    timelines: Vec<Timeline>,
}

fn check_member(m: &MemberInput) -> Result<(), ApiError> {
    if m.first_name.trim().is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    if m.member_no.is_some_and(|n| n <= 0) {
        return Err(ApiError::bad("bad_member_no"));
    }
    Ok(())
}

fn member_no_taken(e: sqlx::Error) -> ApiError {
    match &e {
        sqlx::Error::Database(d) if d.constraint() == Some("members_member_no_key") => {
            ApiError(StatusCode::CONFLICT, "member_no_taken")
        }
        _ => e.into(),
    }
}

/// The number the next new member gets unless another is typed: one more than the highest.
pub async fn next_member_no(State(s): State<AppState>, user: CurrentUser) -> Result<Json<i32>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let n: i32 = sqlx::query_scalar("SELECT COALESCE(max(member_no), 0) + 1 FROM members").fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(n))
}

pub async fn create_member(State(s): State<AppState>, user: CurrentUser, Json(b): Json<NewMember>) -> Result<Json<Saved>, ApiError> {
    hall_only(&user)?;
    check_member(&b.member)?;
    let m = &b.member;
    let mut tx = begin_as(&s.db, &user).await?;
    let no: i32 = match m.member_no {
        Some(n) => n,
        None => sqlx::query_scalar("SELECT COALESCE(max(member_no), 0) + 1 FROM members").fetch_one(&mut *tx).await?,
    };
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO members (id, member_no, first_name, last_name, father_name, phone, field_of_study, tazkira_no, joined_on, notes) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
    )
    .bind(id)
    .bind(no)
    .bind(m.first_name.trim())
    .bind(clean(&m.last_name))
    .bind(clean(&m.father_name))
    .bind(clean(&m.phone))
    .bind(clean(&m.field_of_study))
    .bind(clean(&m.tazkira_no))
    .bind(today())
    .bind(clean(&m.notes))
    .execute(&mut *tx)
    .await
    .map_err(member_no_taken)?;
    let (membership_id, receipt_id) = match &b.period {
        Some(p) => add_period(&mut tx, &user, Some(id), None, p).await.map(|(m, r)| (Some(m), r))?,
        None => (None, None),
    };
    tx.commit().await?;
    Ok(Json(Saved { member_id: Some(id), member_no: Some(no), membership_id, receipt_id }))
}

pub async fn update_member(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(m): Json<MemberInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    check_member(&m)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query(
        "UPDATE members SET member_no = COALESCE($2, member_no), first_name = $3, last_name = $4, father_name = $5, \
             phone = $6, field_of_study = $7, tazkira_no = $8, notes = $9 \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(m.member_no)
    .bind(m.first_name.trim())
    .bind(clean(&m.last_name))
    .bind(clean(&m.father_name))
    .bind(clean(&m.phone))
    .bind(clean(&m.field_of_study))
    .bind(clean(&m.tazkira_no))
    .bind(clean(&m.notes))
    .execute(&mut *tx)
    .await
    .map_err(member_no_taken)?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn member(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Json<MemberDetail>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let member: Member = sqlx::query_as(
        "SELECT id, member_no, first_name, last_name, father_name, phone, field_of_study, tazkira_no, joined_on, notes \
         FROM members WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(NOT_FOUND)?;
    let mut periods: Vec<Period> = sqlx::query_as(
        "SELECT ms.id, p.name AS plan_name, p.kind::text AS kind, ms.start_date, ms.end_date, \
                ms.fee::float8 AS fee, ms.discount::float8 AS discount, ms.note, r.id AS receipt_id, r.receipt_no, ms.created_at \
         FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         LEFT JOIN receipts r ON r.membership_id = ms.id AND NOT r.voided AND r.deleted_at IS NULL \
         WHERE ms.member_id = $1 AND ms.deleted_at IS NULL \
         ORDER BY ms.end_date DESC, ms.created_at DESC",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    for p in &mut periods {
        p.removable = p.receipt_id.is_none() && (user.is_partner() || typed_today(p.created_at));
    }
    let mut timelines = Vec::new();
    for kind in ["monthly", "internet"] {
        let end_date = periods.iter().filter(|p| p.kind == kind).map(|p| p.end_date).max();
        timelines.push(Timeline {
            kind,
            end_date,
            days_left: end_date.map(|e| (e - today()).num_days() as i32),
            next_start: next_start(&mut tx, id, kind).await?,
        });
    }
    tx.commit().await?;
    Ok(Json(MemberDetail { member, periods, timelines }))
}

/// The day after the member's last period of this kind (seat or internet), or today.
async fn next_start(tx: &mut PgConnection, member: Uuid, kind: &str) -> Result<NaiveDate, ApiError> {
    let last: Option<NaiveDate> = sqlx::query_scalar(
        "SELECT max(ms.end_date) FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         WHERE ms.member_id = $1 AND ms.deleted_at IS NULL AND p.kind::text = $2",
    )
    .bind(member)
    .bind(kind)
    .fetch_one(&mut *tx)
    .await?;
    Ok(last.and_then(|d| d.succ_opt()).unwrap_or_else(today))
}

pub async fn add_member_period(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(p): Json<PeriodInput>,
) -> Result<Json<Saved>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let (membership_id, receipt_id) = add_period(&mut tx, &user, Some(id), None, &p).await?;
    tx.commit().await?;
    Ok(Json(Saved { member_id: Some(id), member_no: None, membership_id: Some(membership_id), receipt_id }))
}

#[derive(Deserialize)]
pub struct DailySeat {
    /// A member, or a guest who only has a name.
    member_id: Option<Uuid>,
    guest_name: Option<String>,
    #[serde(flatten)]
    period: PeriodInput,
}

pub async fn daily_seat(State(s): State<AppState>, user: CurrentUser, Json(b): Json<DailySeat>) -> Result<Json<Saved>, ApiError> {
    hall_only(&user)?;
    let guest = clean(&b.guest_name);
    if b.member_id.is_none() && guest.is_none() {
        return Err(ApiError::bad("name_required"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let daily: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM plans WHERE id = $1 AND kind = 'daily')")
        .bind(b.period.plan_id)
        .fetch_one(&mut *tx)
        .await?;
    if !daily {
        return Err(ApiError::bad("bad_plan"));
    }
    let (membership_id, receipt_id) = add_period(&mut tx, &user, b.member_id, guest, &b.period).await?;
    tx.commit().await?;
    Ok(Json(Saved { member_id: b.member_id, member_no: None, membership_id: Some(membership_id), receipt_id }))
}

#[derive(FromRow)]
struct Plan {
    name: String,
    kind: String,
    price: f64,
    active: bool,
}

/// Inserts the period and, unless it is `record_only`, its bill. Returns (membership, bill).
async fn add_period(
    tx: &mut PgConnection,
    user: &CurrentUser,
    member: Option<Uuid>,
    guest: Option<String>,
    p: &PeriodInput,
) -> Result<(Uuid, Option<Uuid>), ApiError> {
    let plan: Plan = sqlx::query_as("SELECT name, kind::text AS kind, price::float8 AS price, active FROM plans WHERE id = $1 AND deleted_at IS NULL")
        .bind(p.plan_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError::bad("bad_plan"))?;
    if !plan.active {
        return Err(ApiError::bad("bad_plan"));
    }
    if let Some(m) = member {
        let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM members WHERE id = $1 AND deleted_at IS NULL)")
            .bind(m)
            .fetch_one(&mut *tx)
            .await?;
        if !exists {
            return Err(NOT_FOUND);
        }
    }
    let fee = if p.record_only { 0.0 } else { p.fee.unwrap_or(plan.price) };
    let discount = if p.record_only { 0.0 } else { p.discount };
    if !fee.is_finite() || fee < 0.0 || !discount.is_finite() || discount < 0.0 || discount > fee {
        return Err(ApiError::bad("bad_amount"));
    }
    let start = match (p.start_date, member) {
        (Some(d), _) => d,
        (None, Some(m)) if plan.kind != "daily" => next_start(tx, m, &plan.kind).await?,
        _ => today(),
    };
    let membership = Uuid::new_v4();
    // The end date comes from the plan's length (trigger membership_end_date).
    sqlx::query(
        "INSERT INTO memberships (id, member_id, guest_name, plan_id, start_date, fee, discount, note, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    )
    .bind(membership)
    .bind(member)
    .bind(&guest)
    .bind(p.plan_id)
    .bind(start)
    .bind(fee)
    .bind(discount)
    .bind(p.record_only.then_some("تاریخ عضویتی که پولش پیش از برنامه گرفته شده"))
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    if p.record_only {
        return Ok((membership, None));
    }
    let who = match member {
        Some(m) => sqlx::query_scalar("SELECT trim(first_name || ' ' || COALESCE(last_name, '')) FROM members WHERE id = $1")
            .bind(m)
            .fetch_one(&mut *tx)
            .await?,
        None => guest.unwrap_or_default(),
    };
    let receipt = issue(tx, user, plan.kind.as_str(), fee - discount, &format!("{} · {who}", plan.name), Some(membership), None).await?;
    Ok((membership, Some(receipt)))
}

/// Issues a bill dated today, numbered with this computer's next number for the Solar
/// year, e.g. H-1405-000124.
pub async fn issue(
    tx: &mut PgConnection,
    user: &CurrentUser,
    category: &str,
    amount: f64,
    description: &str,
    membership: Option<Uuid>,
    book_loan: Option<Uuid>,
) -> Result<Uuid, ApiError> {
    let day = today();
    let device: Uuid = sqlx::query_scalar("SELECT (value #>> '{}')::uuid FROM settings WHERE key = 'this_device_id'")
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::INTERNAL_SERVER_ERROR, "no_device"))?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO receipts (id, receipt_no, department, issued_on, amount, membership_id, book_loan_id, income_category, description, issued_by, device_id) \
         VALUES ($1, next_receipt_no($2, $3), 'hall', $4, $5, $6, $10, $7, $8, $9, $2)",
    )
    .bind(id)
    .bind(device)
    .bind(solar::year_of(day))
    .bind(day)
    .bind(amount)
    .bind(membership)
    .bind(category)
    .bind(description)
    .bind(user.id)
    .bind(book_loan)
    .execute(&mut *tx)
    .await?;
    Ok(id)
}

// ---------------------------------------------------------------------------
// Bills that are not a membership: other income typed at the desk

/// Income lines a desk bill may be for (the same names as the year statement).
const OTHER_INCOME: [&str; 4] = ["misc", "services", "hotspot", "books"];

#[derive(Deserialize)]
pub struct OtherBill {
    income_category: String,
    amount: f64,
    description: Option<String>,
}

pub async fn other_bill(State(s): State<AppState>, user: CurrentUser, Json(b): Json<OtherBill>) -> Result<Json<Saved>, ApiError> {
    hall_only(&user)?;
    if !OTHER_INCOME.contains(&b.income_category.as_str()) {
        return Err(ApiError::bad("bad_category"));
    }
    if !b.amount.is_finite() || b.amount <= 0.0 {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let id = issue(&mut tx, &user, &b.income_category, b.amount, clean(&b.description).as_deref().unwrap_or(""), None, None).await?;
    tx.commit().await?;
    Ok(Json(Saved { member_id: None, member_no: None, membership_id: None, receipt_id: Some(id) }))
}

// ---------------------------------------------------------------------------
// Bills: list, one bill for printing, void

#[derive(Deserialize)]
pub struct BillQuery {
    q: Option<String>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct Bill {
    id: Uuid,
    receipt_no: String,
    issued_on: NaiveDate,
    amount: f64,
    currency: String,
    income_category: String,
    description: Option<String>,
    voided: bool,
    void_reason: Option<String>,
    printed_count: i32,
    issued_by: Option<String>,
    member_id: Option<Uuid>,
    member_no: Option<i32>,
    customer: Option<String>,
    father_name: Option<String>,
    phone: Option<String>,
    /// Lending card of a book bill (p-105).
    card_no: Option<String>,
    /// A book bill: start and end are the days the book went out and came back.
    book_loan_id: Option<Uuid>,
    plan_name: Option<String>,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    fee: Option<f64>,
    discount: Option<f64>,
}

const BILL_SELECT: &str = "SELECT r.id, r.receipt_no, r.issued_on, r.amount::float8 AS amount, r.currency::text AS currency, \
        r.income_category, r.description, r.voided, r.void_reason, r.printed_count, s.full_name AS issued_by, \
        m.id AS member_id, m.member_no, \
        COALESCE(trim(m.first_name || ' ' || COALESCE(m.last_name, '')), ms.guest_name, d.name) AS customer, \
        COALESCE(m.father_name, d.father_name) AS father_name, COALESCE(m.phone, d.phone) AS phone, d.code AS card_no, \
        p.name AS plan_name, r.book_loan_id, \
        COALESCE(ms.start_date, bl.loaned_on) AS start_date, COALESCE(ms.end_date, bl.returned_on) AS end_date, \
        ms.fee::float8 AS fee, ms.discount::float8 AS discount \
    FROM receipts r \
    LEFT JOIN app_users u ON u.id = r.issued_by LEFT JOIN staff s ON s.id = u.staff_id \
    LEFT JOIN memberships ms ON ms.id = r.membership_id \
    LEFT JOIN book_loans bl ON bl.id = r.book_loan_id \
    LEFT JOIN loan_deposits d ON d.id = bl.deposit_id \
    LEFT JOIN members m ON m.id = COALESCE(ms.member_id, bl.member_id) \
    LEFT JOIN plans p ON p.id = ms.plan_id";

#[derive(Serialize)]
pub struct BillPage {
    total: i64,
    sum: f64,
    rows: Vec<Bill>,
}

/// Bills issued in the app, newest first (the Excel import's month totals are not bills).
pub async fn bills(State(s): State<AppState>, user: CurrentUser, Query(p): Query<BillQuery>) -> Result<Json<BillPage>, ApiError> {
    hall_only(&user)?;
    let q = clean(&p.q).map(|q| format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")));
    let filter = "r.deleted_at IS NULL AND r.department = 'hall' AND r.import_batch_id IS NULL \
        AND ($1::date IS NULL OR r.issued_on >= $1) AND ($2::date IS NULL OR r.issued_on <= $2) \
        AND ($3::text IS NULL OR r.receipt_no ILIKE $3 OR r.description ILIKE $3 OR m.phone ILIKE $3 \
             OR m.member_no::text LIKE $3 OR ms.guest_name ILIKE $3 OR d.name ILIKE $3 OR d.code ILIKE $3)";
    let joins = "FROM receipts r LEFT JOIN memberships ms ON ms.id = r.membership_id \
        LEFT JOIN book_loans bl ON bl.id = r.book_loan_id LEFT JOIN loan_deposits d ON d.id = bl.deposit_id \
        LEFT JOIN members m ON m.id = COALESCE(ms.member_id, bl.member_id)";
    let mut tx = begin_as(&s.db, &user).await?;
    let (total, sum): (i64, f64) = sqlx::query_as(&format!(
        "SELECT count(*), COALESCE(sum(r.amount) FILTER (WHERE NOT r.voided), 0)::float8 {joins} WHERE {filter}"
    ))
    .bind(p.from)
    .bind(p.to)
    .bind(&q)
    .fetch_one(&mut *tx)
    .await?;
    let rows: Vec<Bill> = sqlx::query_as(&format!(
        "{BILL_SELECT} WHERE {filter} ORDER BY r.issued_on DESC, r.created_at DESC LIMIT $4 OFFSET $5"
    ))
    .bind(p.from)
    .bind(p.to)
    .bind(&q)
    .bind(p.limit.unwrap_or(100).clamp(1, 500))
    .bind(p.offset.unwrap_or(0).max(0))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(BillPage { total, sum, rows }))
}

pub async fn bill(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Json<Bill>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let b: Bill = sqlx::query_as(&format!("{BILL_SELECT} WHERE r.id = $1 AND r.deleted_at IS NULL"))
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(NOT_FOUND)?;
    tx.commit().await?;
    Ok(Json(b))
}

/// Counts prints, so a reprint shows "copy" (نسخهٔ دوم) on the paper.
pub async fn bill_printed(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query("UPDATE receipts SET printed_count = printed_count + 1 WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct VoidInput {
    reason: String,
}

/// Partners may void any bill; the manager only bills issued today (a mistake at the desk).
/// The membership it paid for is withdrawn too, so the member's end date goes back.
pub async fn void_bill(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<VoidInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let reason = b.reason.trim();
    if reason.is_empty() {
        return Err(ApiError::bad("reason_required"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(NaiveDate, bool, Option<Uuid>, Option<Uuid>)> = sqlx::query_as(
        "SELECT issued_on, voided, membership_id, book_loan_id FROM receipts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    let (issued_on, voided, membership, loan) = row.ok_or(NOT_FOUND)?;
    if voided {
        return Err(ApiError::bad("already_voided"));
    }
    if !user.is_partner() && issued_on != today() {
        return Err(ApiError(StatusCode::FORBIDDEN, "void_today_only"));
    }
    sqlx::query("UPDATE receipts SET voided = true, void_reason = $2, voided_by = $3, voided_at = now() WHERE id = $1")
        .bind(id)
        .bind(reason)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    if let Some(m) = membership {
        sqlx::query("UPDATE memberships SET deleted_at = now() WHERE id = $1").bind(m).execute(&mut *tx).await?;
    }
    // A wrong return bill puts the book back out, so it can be returned again with the right
    // amount; not when its guarantee has been given back meanwhile (nothing is held for it).
    if let Some(l) = loan {
        sqlx::query(
            "UPDATE book_loans l SET returned_on = NULL, returned_by = NULL, fee_paid = 0, fine = 0 \
             WHERE l.id = $1 AND NOT EXISTS (SELECT 1 FROM loan_deposits d WHERE d.id = l.deposit_id AND d.returned_on IS NOT NULL)",
        )
        .bind(l)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A period typed in by mistake without a bill (record_only) can be removed again: by a
/// partner at any time, by the manager on the day it was typed.
pub async fn delete_period(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(bool, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT EXISTS (SELECT 1 FROM receipts r WHERE r.membership_id = ms.id AND NOT r.voided AND r.deleted_at IS NULL), ms.created_at \
         FROM memberships ms WHERE ms.id = $1 AND ms.deleted_at IS NULL",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (has_bill, created) = row.ok_or(NOT_FOUND)?;
    if has_bill {
        return Err(ApiError::bad("void_the_bill"));
    }
    if !user.is_partner() && !typed_today(created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    sqlx::query("UPDATE memberships SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
