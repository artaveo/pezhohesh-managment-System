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
    /// Paid now; the rest is owed and paid later with a second bill. Default: all of it.
    paid: Option<f64>,
    #[serde(default)]
    record_only: bool,
    /// A renewal while more than a few days are still left (paying ahead): asked for on
    /// purpose, so a second click or a repeat does not add another month.
    #[serde(default)]
    ahead: bool,
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
    /// What its bills paid, and what is still owed.
    paid: f64,
    owed: f64,
    /// A period with no bill (its money is in the Excel import): the Excel fee of its month.
    excel_fee: Option<f64>,
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
    /// The fee cells of the member's row in the Excel book.
    excel_months: Vec<ExcelMonth>,
    timelines: Vec<Timeline>,
    /// Photo and tazkira scans.
    documents: Vec<crate::documents::Document>,
}

#[derive(Serialize, FromRow)]
pub struct ExcelMonth {
    kind: String,
    year: i32,
    month: i32,
    amount: f64,
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

/// One more than the highest member number in this computer's range (or outside every other
/// computer's range), stepping over numbers the fingerprint device already gives someone
/// (people added in ZKAccess who are not in the app). See next_member_no() in 0018_sync.sql.
pub const NEXT_NO: &str = "SELECT next_member_no()";

/// The number the next new member gets unless another is typed (see NEXT_NO).
pub async fn next_member_no(State(s): State<AppState>, user: CurrentUser) -> Result<Json<i32>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let n: i32 = sqlx::query_scalar(NEXT_NO).fetch_one(&mut *tx).await?;
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
        None => sqlx::query_scalar(NEXT_NO).fetch_one(&mut *tx).await?,
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
    crate::k50::poke();
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
    crate::k50::poke();
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
                ms.fee::float8 AS fee, ms.discount::float8 AS discount, pp.paid, \
                CASE WHEN pp.receipt_id IS NOT NULL THEN pp.owed ELSE 0 END AS owed, \
                CASE WHEN pp.receipt_id IS NULL THEN (SELECT sum(x.amount) FROM v_excel_months x \
                    WHERE x.member_id = ms.member_id AND x.kind = p.kind::text \
                      AND ms.start_date BETWEEN x.month_start AND x.month_end) END AS excel_fee, \
                ms.note, pp.receipt_id, pp.receipt_no, ms.created_at \
         FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         JOIN v_period_paid pp ON pp.membership_id = ms.id \
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
    let excel_months: Vec<ExcelMonth> = sqlx::query_as(
        "SELECT kind, year, month, sum(amount)::float8 AS amount FROM v_excel_months WHERE member_id = $1 \
         GROUP BY kind, year, month ORDER BY year, month, kind",
    )
    .bind(id)
    .fetch_all(&mut *tx)
    .await?;
    let documents = crate::documents::of_member(&mut tx, id).await?;
    tx.commit().await?;
    Ok(Json(MemberDetail { member, periods, excel_months, timelines, documents }))
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
    crate::k50::poke();
    Ok(Json(Saved { member_id: Some(id), member_no: None, membership_id: Some(membership_id), receipt_id }))
}

#[derive(Deserialize)]
pub struct RestInput {
    amount: f64,
}

/// The rest of a period paid in parts: a second bill for (some of) what is still owed.
pub async fn pay_rest(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<RestInput>,
) -> Result<Json<Saved>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    // Locks the period, so the same rest is not paid twice from two clicks.
    let row: Option<(Option<Uuid>, String, String)> = sqlx::query_as(
        "SELECT ms.member_id, p.kind::text, p.name FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         WHERE ms.id = $1 AND ms.deleted_at IS NULL FOR UPDATE OF ms",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (member, kind, plan) = row.ok_or(NOT_FOUND)?;
    let (owed, billed): (f64, bool) = sqlx::query_as("SELECT owed, receipt_id IS NOT NULL FROM v_period_paid WHERE membership_id = $1")
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
    if !billed || owed <= 0.0 {
        return Err(ApiError::bad("nothing_owed"));
    }
    if !b.amount.is_finite() || b.amount <= 0.0 || b.amount > owed + 0.001 {
        return Err(ApiError::bad("bad_paid"));
    }
    let who: String = match member {
        Some(m) => sqlx::query_scalar("SELECT trim(first_name || ' ' || COALESCE(last_name, '')) FROM members WHERE id = $1")
            .bind(m)
            .fetch_one(&mut *tx)
            .await?,
        None => sqlx::query_scalar("SELECT COALESCE(guest_name, '') FROM memberships WHERE id = $1").bind(id).fetch_one(&mut *tx).await?,
    };
    let receipt = issue(&mut tx, &user, &kind, b.amount, &format!("باقی {plan} · {who}"), Some(id), None).await?;
    sqlx::query("UPDATE receipts SET pays_rest = true WHERE id = $1").bind(receipt).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(Saved { member_id: member, member_no: None, membership_id: Some(id), receipt_id: Some(receipt) }))
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
    crate::k50::poke();
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
        // Locks the member, so two renewals sent at once are checked one after the other.
        let exists: Option<i32> = sqlx::query_scalar("SELECT 1 FROM members WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
            .bind(m)
            .fetch_optional(&mut *tx)
            .await?;
        if exists.is_none() {
            return Err(NOT_FOUND);
        }
    }
    let fee = if p.record_only { 0.0 } else { p.fee.unwrap_or(plan.price) };
    let discount = if p.record_only { 0.0 } else { p.discount };
    if !fee.is_finite() || fee < 0.0 || !discount.is_finite() || discount < 0.0 || discount > fee {
        return Err(ApiError::bad("bad_amount"));
    }
    let due = fee - discount;
    let paid = p.paid.unwrap_or(due);
    // Something is paid at the desk (the bill is for it); a free period's bill is 0.
    if !paid.is_finite() || paid > due || paid < 0.0 || (paid == 0.0 && due > 0.0) {
        return Err(ApiError::bad("bad_paid"));
    }
    let start = match (p.start_date, member) {
        (Some(d), _) => d,
        (None, Some(m)) if plan.kind != "daily" => next_start(tx, m, &plan.kind).await?,
        _ => today(),
    };
    if let (Some(m), false) = (member, plan.kind == "daily") {
        let last_end: Option<NaiveDate> = sqlx::query_scalar(
            "SELECT max(ms.end_date) FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
             WHERE ms.member_id = $1 AND ms.deleted_at IS NULL AND p.kind::text = $2",
        )
        .bind(m)
        .bind(&plan.kind)
        .fetch_one(&mut *tx)
        .await?;
        if let Some(end) = last_end {
            if start <= end {
                return Err(ApiError::bad("period_overlap"));
            }
            if (end - today()).num_days() > crate::dashboard::MEMBER_DUE_DAYS as i64 && !p.ahead {
                return Err(ApiError(StatusCode::CONFLICT, "still_active"));
            }
        }
    }
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
    let receipt = issue(tx, user, plan.kind.as_str(), paid, &format!("{} · {who}", plan.name), Some(membership), None).await?;
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
    let device: Uuid = sqlx::query_scalar::<_, Option<Uuid>>("SELECT current_device()")
        .fetch_one(&mut *tx)
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
/// Hotspot cards are not here: their count moves stock (hotspot.rs).
const OTHER_INCOME: [&str; 3] = ["misc", "services", "books"];

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
    /// A bill for the rest of a period paid in parts.
    pays_rest: bool,
    /// For a period: what was paid by this bill and the ones before it, and what is left after it.
    paid_so_far: Option<f64>,
    remaining: Option<f64>,
}

const BILL_SELECT: &str = "SELECT r.id, r.receipt_no, r.issued_on, r.amount::float8 AS amount, r.currency::text AS currency, \
        r.income_category, r.description, r.voided, r.void_reason, r.printed_count, s.full_name AS issued_by, \
        m.id AS member_id, m.member_no, \
        COALESCE(trim(m.first_name || ' ' || COALESCE(m.last_name, '')), ms.guest_name, d.name) AS customer, \
        COALESCE(m.father_name, d.father_name) AS father_name, COALESCE(m.phone, d.phone) AS phone, d.code AS card_no, \
        p.name AS plan_name, r.book_loan_id, \
        COALESCE(ms.start_date, bl.loaned_on) AS start_date, COALESCE(ms.end_date, bl.returned_on) AS end_date, \
        ms.fee::float8 AS fee, ms.discount::float8 AS discount, r.pays_rest, \
        so_far.paid AS paid_so_far, GREATEST(ms.fee - ms.discount - so_far.paid, 0)::float8 AS remaining \
    FROM receipts r \
    LEFT JOIN app_users u ON u.id = r.issued_by LEFT JOIN staff s ON s.id = u.staff_id \
    LEFT JOIN memberships ms ON ms.id = r.membership_id \
    LEFT JOIN book_loans bl ON bl.id = r.book_loan_id \
    LEFT JOIN loan_deposits d ON d.id = bl.deposit_id \
    LEFT JOIN members m ON m.id = COALESCE(ms.member_id, bl.member_id) \
    LEFT JOIN plans p ON p.id = ms.plan_id \
    LEFT JOIN LATERAL (SELECT sum(o.amount)::float8 AS paid FROM receipts o WHERE ms.id IS NOT NULL AND o.membership_id = ms.id \
        AND NOT o.voided AND o.deleted_at IS NULL AND (o.created_at, o.id) <= (r.created_at, r.id)) so_far ON true";

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
    let row: Option<(NaiveDate, bool, Option<Uuid>, Option<Uuid>, bool)> = sqlx::query_as(
        "SELECT issued_on, voided, membership_id, book_loan_id, pays_rest FROM receipts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (issued_on, voided, membership, loan, pays_rest) = row.ok_or(NOT_FOUND)?;
    if voided {
        return Err(ApiError::bad("already_voided"));
    }
    // The first bill of a period paid in parts goes last: voiding it withdraws the period.
    if let (Some(m), false) = (membership, pays_rest) {
        let later: bool = sqlx::query_scalar(
            "SELECT EXISTS (SELECT 1 FROM receipts WHERE membership_id = $1 AND pays_rest AND NOT voided AND deleted_at IS NULL)",
        )
        .bind(m)
        .fetch_one(&mut *tx)
        .await?;
        if later {
            return Err(ApiError::bad("rest_bills_first"));
        }
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
    if let (Some(m), false) = (membership, pays_rest) {
        sqlx::query("UPDATE memberships SET deleted_at = now() WHERE id = $1").bind(m).execute(&mut *tx).await?;
    }
    // The cards of a wrong hotspot count go back into stock.
    sqlx::query("UPDATE hotspot_sales SET deleted_at = now() WHERE receipt_id = $1 AND deleted_at IS NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
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
    crate::k50::poke();
    Ok(StatusCode::NO_CONTENT)
}

/// A period typed in by mistake without a bill (record_only) can be removed again: by a
/// partner at any time, by the manager on the day it was typed.
pub async fn delete_period(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Query(r): Query<Reason>,
) -> Result<StatusCode, ApiError> {
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
    sqlx::query("UPDATE memberships SET deleted_at = now(), deleted_reason = $2 WHERE id = $1")
        .bind(id)
        .bind(clean(&r.reason))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::k50::poke();
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct Reason {
    reason: Option<String>,
}

#[derive(Deserialize)]
pub struct PeriodDates {
    start_date: NaiveDate,
    end_date: NaiveDate,
    note: Option<String>,
}

/// Correcting the dates of a period typed wrong. The bill keeps its amount; the audit log
/// keeps the old dates. Same rule as removing: a partner at any time, the manager on the day.
pub async fn update_period(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<PeriodDates>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    if b.end_date < b.start_date {
        return Err(ApiError::bad("bad_range"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let created: chrono::DateTime<chrono::Utc> =
        sqlx::query_scalar("SELECT created_at FROM memberships WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(NOT_FOUND)?;
    if !user.is_partner() && !typed_today(created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    sqlx::query("UPDATE memberships SET start_date = $2, end_date = $3, note = $4 WHERE id = $1")
        .bind(id)
        .bind(b.start_date)
        .bind(b.end_date)
        .bind(clean(&b.note))
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    crate::k50::poke();
    Ok(StatusCode::NO_CONTENT)
}

/// Removing a member (partners only). Their periods and documents go with them (by trigger,
/// see migration 0013); their bills stay, because the money was received. Blocked while
/// they still have a book or a guarantee out.
pub async fn delete_member(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Query(r): Query<Reason>,
) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE members SET deleted_at = now(), deleted_reason = $2 WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .bind(clean(&r.reason))
        .execute(&mut *tx)
        .await
        .map_err(|e| match &e {
            sqlx::Error::Database(d) if d.message() == "member_has_open_loans" => ApiError::bad("member_has_open_loans"),
            _ => e.into(),
        })?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    crate::k50::poke();
    Ok(StatusCode::NO_CONTENT)
}

/// Bringing a removed member back, with the periods and documents removed together with them.
pub async fn restore_member(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE members SET deleted_at = NULL WHERE id = $1 AND deleted_at IS NOT NULL")
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    crate::k50::poke();
    Ok(StatusCode::NO_CONTENT)
}
