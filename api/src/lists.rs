//! The members and books pages: who is close to (or past) their end date, or everyone,
//! with a search box. Same windows as the dashboard lists.

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::dashboard::{BOOK_DUE_DAYS, MEMBER_DUE_DAYS, MEMBER_EXPIRED_DAYS};
use crate::AppState;

#[derive(Deserialize)]
pub struct ListParams {
    /// attention (default) | all
    scope: Option<String>,
    /// Name, father's name, phone or member number (books: also the title).
    q: Option<String>,
    /// Members page, all: daily seats of guests (no member record) are listed too.
    #[serde(default)]
    guests: bool,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize)]
pub struct Page<T> {
    total: i64,
    rows: Vec<T>,
}

#[derive(Serialize, FromRow)]
pub struct MemberRow {
    /// None for a guest's daily seat.
    member_id: Option<uuid::Uuid>,
    member_no: Option<i32>,
    name: String,
    father_name: Option<String>,
    phone: Option<String>,
    plan_name: Option<String>,
    end_date: Option<chrono::NaiveDate>,
    days_left: Option<i32>,
    /// The start of the latest period of any kind (daily too).
    last_start: Option<chrono::NaiveDate>,
    /// A guest's daily seat: its bill.
    receipt_id: Option<uuid::Uuid>,
}

pub fn pattern(q: &Option<String>) -> Option<String> {
    q.as_deref()
        .map(str::trim)
        .filter(|q| !q.is_empty())
        .map(|q| format!("%{}%", q.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")))
}

fn paging(p: &ListParams) -> (i64, i64) {
    (p.limit.unwrap_or(100).clamp(1, 500), p.offset.unwrap_or(0).max(0))
}

pub async fn members(State(s): State<AppState>, user: CurrentUser, Query(p): Query<ListParams>) -> Result<Json<Page<MemberRow>>, ApiError> {
    if !user.sees_hall() {
        return Err(ApiError::FORBIDDEN);
    }
    let attention = p.scope.as_deref() != Some("all");
    let q = pattern(&p.q);
    let (limit, offset) = paging(&p);
    // $1 attention?, $2 pattern, $3/$4 window, $5 with guests
    let filter = "($1 = false OR days_left BETWEEN -$3 AND $4) \
        AND ($2::text IS NULL OR name ILIKE $2 OR father_name ILIKE $2 OR phone ILIKE $2 OR member_no::text LIKE $2)";
    // Guests who bought a daily seat have no member record; on the full list they show
    // as their own row, so a sign-up at the desk is always on top of the list.
    let rows_sql = format!(
        "SELECT member_id, member_no, name, father_name, phone, plan_name, end_date, days_left, \
                last_start, last_at, NULL::uuid AS receipt_id \
         FROM v_member_status WHERE {filter} \
         UNION ALL \
         SELECT NULL, NULL, ms.guest_name, NULL, NULL, p.name, ms.end_date, ms.end_date - current_date, \
                ms.start_date, ms.created_at, r.id \
         FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         LEFT JOIN LATERAL (SELECT r.id FROM receipts r WHERE r.membership_id = ms.id AND NOT r.voided \
                            AND r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT 1) r ON true \
         WHERE $5 AND NOT $1 AND ms.member_id IS NULL AND ms.deleted_at IS NULL \
           AND ($2::text IS NULL OR ms.guest_name ILIKE $2)"
    );
    let order = if attention {
        "days_left NULLS LAST, member_no"
    } else {
        "last_start DESC NULLS LAST, last_at DESC, member_no DESC NULLS LAST"
    };

    let mut tx = begin_as(&s.db, &user).await?;
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM ({rows_sql}) t"))
        .bind(attention)
        .bind(&q)
        .bind(MEMBER_EXPIRED_DAYS)
        .bind(MEMBER_DUE_DAYS)
        .bind(p.guests)
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<MemberRow> = sqlx::query_as(&format!(
        "SELECT member_id, member_no, name, father_name, phone, plan_name, end_date, days_left, last_start, receipt_id \
         FROM ({rows_sql}) t ORDER BY {order} LIMIT $6 OFFSET $7"
    ))
    .bind(attention)
    .bind(&q)
    .bind(MEMBER_EXPIRED_DAYS)
    .bind(MEMBER_DUE_DAYS)
    .bind(p.guests)
    .bind(limit)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(Page { total, rows }))
}

#[derive(Serialize, FromRow)]
pub struct LoanRow {
    loan_id: uuid::Uuid,
    book_title: String,
    /// Member number, or the lending card (p-105) of a guarantee.
    card_no: String,
    member_name: String,
    phone: Option<String>,
    loaned_on: chrono::NaiveDate,
    due_on: chrono::NaiveDate,
    days_left: i32,
}

pub async fn loans(State(s): State<AppState>, user: CurrentUser, Query(p): Query<ListParams>) -> Result<Json<Page<LoanRow>>, ApiError> {
    if !user.sees_hall() {
        return Err(ApiError::FORBIDDEN);
    }
    let attention = p.scope.as_deref() != Some("all");
    let q = pattern(&p.q);
    let (limit, offset) = paging(&p);
    let filter = "($1 = false OR days_left <= $3) \
        AND ($2::text IS NULL OR book_title ILIKE $2 OR member_name ILIKE $2 OR phone ILIKE $2 OR card_no ILIKE $2)";

    let mut tx = begin_as(&s.db, &user).await?;
    let total: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM v_open_loans WHERE {filter}"))
        .bind(attention)
        .bind(&q)
        .bind(BOOK_DUE_DAYS)
        .fetch_one(&mut *tx)
        .await?;
    let rows: Vec<LoanRow> = sqlx::query_as(&format!(
        "SELECT loan_id, book_title, card_no, member_name, phone, loaned_on, due_on, days_left \
         FROM v_open_loans WHERE {filter} ORDER BY days_left, due_on LIMIT $4 OFFSET $5"
    ))
    .bind(attention)
    .bind(&q)
    .bind(BOOK_DUE_DAYS)
    .bind(limit)
    .bind(offset)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(Page { total, rows }))
}
