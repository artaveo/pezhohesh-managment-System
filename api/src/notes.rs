//! «یادداشت‌ها»: reckonings kept apart from the books. No report, total or import reads
//! the notes table, so nothing written here changes income, expenses or the till.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::AppState;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

fn allowed(user: &CurrentUser) -> Result<(), ApiError> {
    if user.may("notes") { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

#[derive(Serialize, Deserialize, Clone)]
pub struct NoteLine {
    label: String,
    amount: f64,
    /// Money going out (shown and counted as minus).
    #[serde(default)]
    out: bool,
}

#[derive(Serialize, FromRow)]
pub struct Note {
    id: Uuid,
    title: String,
    body: Option<String>,
    lines: sqlx::types::Json<Vec<NoteLine>>,
    currency: String,
    noted_on: NaiveDate,
    pinned: bool,
    created_by: Option<String>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct NoteInput {
    title: String,
    body: Option<String>,
    #[serde(default)]
    lines: Vec<NoteLine>,
    currency: Option<String>,
    noted_on: Option<NaiveDate>,
    #[serde(default)]
    pinned: bool,
}

/// Trimmed and checked: a title, lines with a label or an amount, sane amounts.
fn checked(mut i: NoteInput) -> Result<NoteInput, ApiError> {
    i.title = i.title.trim().to_string();
    if i.title.is_empty() || i.title.chars().count() > 200 {
        return Err(ApiError::bad("title_required"));
    }
    i.body = i.body.map(|b| b.trim().to_string()).filter(|b| !b.is_empty());
    i.lines.retain(|l| !l.label.trim().is_empty() || l.amount != 0.0);
    for l in &mut i.lines {
        l.label = l.label.trim().to_string();
        if !l.amount.is_finite() || l.amount < 0.0 || l.amount > 1e12 {
            return Err(ApiError::bad("bad_amount"));
        }
        l.amount = (l.amount * 100.0).round() / 100.0;
    }
    if i.lines.len() > 200 {
        return Err(ApiError::bad("too_many_lines"));
    }
    if !matches!(i.currency.as_deref().unwrap_or("AFN"), "AFN" | "USD") {
        return Err(ApiError::bad("bad_currency"));
    }
    Ok(i)
}

pub async fn list(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Note>>, ApiError> {
    allowed(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        "SELECT n.id, n.title, n.body, n.lines, n.currency, n.noted_on, n.pinned, st.full_name AS created_by, n.updated_at \
         FROM notes n LEFT JOIN app_users u ON u.id = n.created_by LEFT JOIN staff st ON st.id = u.staff_id \
         WHERE n.deleted_at IS NULL ORDER BY n.pinned DESC, n.noted_on DESC, n.updated_at DESC LIMIT 1000",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

pub async fn create(State(s): State<AppState>, user: CurrentUser, Json(i): Json<NoteInput>) -> Result<Json<Uuid>, ApiError> {
    allowed(&user)?;
    let i = checked(i)?;
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO notes (id, title, body, lines, currency, noted_on, pinned, created_by) \
         VALUES ($1, $2, $3, $4, $5, COALESCE($6, CURRENT_DATE), $7, $8)",
    )
    .bind(id)
    .bind(&i.title)
    .bind(&i.body)
    .bind(sqlx::types::Json(&i.lines))
    .bind(i.currency.as_deref().unwrap_or("AFN"))
    .bind(i.noted_on)
    .bind(i.pinned)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

pub async fn update(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, Json(i): Json<NoteInput>) -> Result<StatusCode, ApiError> {
    allowed(&user)?;
    let i = checked(i)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query(
        "UPDATE notes SET title = $2, body = $3, lines = $4, currency = $5, noted_on = COALESCE($6, noted_on), pinned = $7 \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(&i.title)
    .bind(&i.body)
    .bind(sqlx::types::Json(&i.lines))
    .bind(i.currency.as_deref().unwrap_or("AFN"))
    .bind(i.noted_on)
    .bind(i.pinned)
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Taken off the list; the row stays (nothing is hard-deleted) and the log keeps it.
pub async fn remove(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    allowed(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE notes SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL").bind(id).execute(&mut *tx).await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
