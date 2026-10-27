//! Who signed up when: every period sold (or recorded) at the desk, by the day it was
//! written, for a day, a month or any range: daily seats, monthly seats, internet.

use axum::extract::{Query, State};
use axum::Json;
use chrono::NaiveDate;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::hall_only;
use crate::lists::pattern;
use crate::AppState;

#[derive(Deserialize)]
pub struct Params {
    /// [from, to] inclusive, by the day of its bill (a period recorded without a bill:
    /// the day it started). Left out: no limit on that side.
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    /// monthly | daily | internet; left out: all.
    kind: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

#[derive(Serialize, FromRow)]
pub struct Row {
    id: Uuid,
    day: NaiveDate,
    kind: String,
    plan_name: String,
    member_id: Option<Uuid>,
    member_no: Option<i32>,
    name: String,
    phone: Option<String>,
    start_date: NaiveDate,
    end_date: NaiveDate,
    amount: f64,
    receipt_id: Option<Uuid>,
    receipt_no: Option<String>,
    /// The member's first period of this kind: a new sign-up, not a renewal.
    first: bool,
    /// Dates recorded for a month paid in the Excel book (no bill).
    record_only: bool,
}

#[derive(Serialize, FromRow, Default)]
pub struct Summary {
    daily: i64,
    monthly_new: i64,
    monthly_renewed: i64,
    internet: i64,
    amount: f64,
}

#[derive(Serialize)]
pub struct Page {
    summary: Summary,
    total: i64,
    rows: Vec<Row>,
}

// $1 from, $2 to, $3 kind, $4 search pattern.
const BASE: &str = "SELECT * FROM v_registrations \
    WHERE ($1::date IS NULL OR day >= $1) AND ($2::date IS NULL OR day <= $2) AND ($3::text IS NULL OR kind = $3) \
      AND ($4::text IS NULL OR name ILIKE $4 OR phone ILIKE $4 OR member_no::text LIKE $4)";

pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Page>, ApiError> {
    hall_only(&user)?;
    if p.from.zip(p.to).is_some_and(|(from, to)| to < from) {
        return Err(ApiError::bad("bad_range"));
    }
    let kind = p.kind.filter(|k| ["monthly", "daily", "internet"].contains(&k.as_str()));
    let q = pattern(&p.q);
    let (limit, offset) = (p.limit.unwrap_or(100).clamp(1, 500), p.offset.unwrap_or(0).max(0));
    let mut tx = begin_as(&s.db, &user).await?;
    let summary: Summary = sqlx::query_as(&format!(
        "SELECT count(*) FILTER (WHERE kind = 'daily') AS daily, \
                count(*) FILTER (WHERE kind = 'monthly' AND first) AS monthly_new, \
                count(*) FILTER (WHERE kind = 'monthly' AND NOT first) AS monthly_renewed, \
                count(*) FILTER (WHERE kind = 'internet') AS internet, \
                COALESCE(sum(amount), 0)::float8 AS amount \
         FROM ({BASE}) x"
    ))
    .bind(p.from)
    .bind(p.to)
    // The tiles count every kind, whichever one the list shows.
    .bind(None::<String>)
    .bind(&q)
    .fetch_one(&mut *tx)
    .await?;
    let total = match kind.as_deref() {
        Some("daily") => summary.daily,
        Some("monthly") => summary.monthly_new + summary.monthly_renewed,
        Some(_) => summary.internet,
        None => summary.daily + summary.monthly_new + summary.monthly_renewed + summary.internet,
    };
    let rows: Vec<Row> = sqlx::query_as(&format!("{BASE} ORDER BY day DESC, receipt_no DESC NULLS LAST, name LIMIT $5 OFFSET $6"))
        .bind(p.from)
        .bind(p.to)
        .bind(&kind)
        .bind(&q)
        .bind(limit)
        .bind(offset)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(Page { summary, total, rows }))
}
