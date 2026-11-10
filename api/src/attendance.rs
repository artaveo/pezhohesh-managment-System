//! Who came on a day and who did not, from the device's punches kept in `attendance`. The
//! device's own memory is cleared monthly; this stays. A day is the office's day (Kabul),
//! whatever the database's clock is, and a person counts once however many times they pressed.

use axum::extract::{Query, State};
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{hall_only, today};
use crate::AppState;

#[derive(Deserialize)]
pub struct DayQuery {
    on: Option<NaiveDate>,
}

#[derive(Serialize, FromRow)]
pub struct Came {
    member_id: Option<Uuid>,
    member_no: i32,
    name: Option<String>,
    phone: Option<String>,
    first_at: DateTime<Utc>,
    last_at: DateTime<Utc>,
    punches: i64,
}

#[derive(Serialize, FromRow)]
pub struct Stayed {
    member_id: Uuid,
    member_no: i32,
    name: String,
    phone: Option<String>,
    end_date: NaiveDate,
    last_seen: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct Day {
    on: NaiveDate,
    came: Vec<Came>,
    /// Members whose seat covers that day and who did not press.
    absent: Vec<Stayed>,
    /// The newest punch the app holds at all: an old one means reading has stopped.
    newest: Option<DateTime<Utc>>,
}

/// GET /api/v1/attendance/day?on=
pub async fn day(State(s): State<AppState>, user: CurrentUser, Query(p): Query<DayQuery>) -> Result<Json<Day>, ApiError> {
    hall_only(&user)?;
    let on = p.on.unwrap_or_else(today);
    let mut tx = begin_as(&s.db, &user).await?;
    let came: Vec<Came> = sqlx::query_as(
        "SELECT max(m.id::text)::uuid AS member_id, a.device_user_no AS member_no, \
                max(trim(concat_ws(' ', m.first_name, m.last_name))) AS name, max(m.phone) AS phone, \
                min(a.punched_at) AS first_at, max(a.punched_at) AS last_at, count(*) AS punches \
         FROM attendance a LEFT JOIN members m ON m.member_no = a.device_user_no AND m.no_freed_at IS NULL \
         WHERE a.punched_at >= ($1::timestamp AT TIME ZONE 'Asia/Kabul') AND a.punched_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kabul') \
         GROUP BY a.device_user_no ORDER BY min(a.punched_at)",
    )
    .bind(on)
    .fetch_all(&mut *tx)
    .await?;
    let nos: Vec<i32> = came.iter().map(|c| c.member_no).collect();
    let absent: Vec<Stayed> = sqlx::query_as(
        "SELECT m.id AS member_id, m.member_no, trim(concat_ws(' ', m.first_name, m.last_name)) AS name, m.phone, \
                max(ms.end_date) AS end_date, \
                (SELECT max(a.punched_at) FROM attendance a WHERE a.device_user_no = m.member_no) AS last_seen \
         FROM members m JOIN memberships ms ON ms.member_id = m.id AND ms.deleted_at IS NULL JOIN plans p ON p.id = ms.plan_id \
         WHERE m.deleted_at IS NULL AND p.kind = 'monthly' AND $1 BETWEEN ms.start_date AND ms.end_date AND NOT (m.member_no = ANY($2)) \
         GROUP BY m.id ORDER BY m.member_no",
    )
    .bind(on)
    .bind(&nos)
    .fetch_all(&mut *tx)
    .await?;
    let newest: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT max(punched_at) FROM attendance").fetch_one(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(Day { on, came, absent, newest }))
}
