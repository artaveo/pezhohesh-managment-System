//! «چه کسی چه کرد»: the audit log written by the database itself (write_audit, migration
//! 0001) shown as plain lines: who, when, what kind of thing, and which fields changed from
//! what to what. Partners only. Also the hand-made month estimates (month_summaries), which
//! partners correct from the yearly statement.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::AppState;

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

const PAGE: i64 = 100;

/// Fields that say nothing to a person reading the log, or must never be shown.
const HIDDEN: [&str; 9] =
    ["updated_at", "created_at", "device_id", "delete_batch", "password_hash", "token_hash", "import_batch_id", "sha256", "file_path"];

#[derive(Deserialize)]
pub struct Params {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    table: Option<String>,
    user: Option<Uuid>,
    q: Option<String>,
    /// Lines written by the Excel import are many thousands; left out unless asked for.
    #[serde(default)]
    import: bool,
    /// Older than this line (the id of the last line shown), for «نمایش بیشتر».
    before: Option<i64>,
}

#[derive(FromRow)]
struct Raw {
    id: i64,
    at: DateTime<Utc>,
    user_name: Option<String>,
    table_name: String,
    row_id: Option<Uuid>,
    action: String,
    before: Option<Value>,
    after: Option<Value>,
    /// The row is removed now (so it can be brought back from here).
    removed_now: Option<bool>,
}

#[derive(Serialize)]
pub struct Change {
    field: String,
    before: Value,
    after: Value,
}

#[derive(Serialize)]
pub struct Line {
    id: i64,
    at: DateTime<Utc>,
    user: Option<String>,
    table: String,
    row_id: Option<Uuid>,
    /// insert, update, remove, restore, void
    kind: &'static str,
    label: String,
    amount: Option<Value>,
    reason: Option<String>,
    member_id: Option<Uuid>,
    changes: Vec<Change>,
    /// A removal that can still be undone from this page.
    restorable: bool,
}

#[derive(Serialize, FromRow)]
pub struct Who {
    id: Uuid,
    name: String,
}

#[derive(Serialize)]
pub struct Page {
    lines: Vec<Line>,
    more: bool,
    users: Vec<Who>,
}

fn text(v: Option<&Value>) -> Option<String> {
    match v? {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_string()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// A few words naming the row: a person's name, a bill number, an expense's description...
fn label(row: &Map<String, Value>) -> String {
    let name = match (text(row.get("first_name")), text(row.get("last_name"))) {
        (Some(f), Some(l)) => Some(format!("{f} {l}")),
        (f, _) => f,
    };
    let no = text(row.get("member_no")).map(|n| format!("شماره {n}"));
    let doc = row.get("sha256").and(text(row.get("kind"))).map(|k| match k.as_str() {
        "photo" => "عکس".to_string(),
        "tazkira_front" => "روی تذکره".to_string(),
        "tazkira_back" => "پشت تذکره".to_string(),
        _ => "مدرک".to_string(),
    });
    [
        name,
        no,
        doc,
        text(row.get("full_name")),
        text(row.get("receipt_no")).map(|n| format!("بل {n}")),
        text(row.get("guest_name")),
        text(row.get("name")),
        text(row.get("book_title")),
        text(row.get("description")),
        text(row.get("note")),
        text(row.get("start_date")).map(|d| format!("از {d}")),
        text(row.get("end_date")).map(|d| format!("تا {d}")),
    ]
    .into_iter()
    .flatten()
    .take(3)
    .collect::<Vec<_>>()
    .join(" · ")
}

fn shape(r: Raw) -> Line {
    let empty = Map::new();
    let before = r.before.as_ref().and_then(Value::as_object).unwrap_or(&empty);
    let after = r.after.as_ref().and_then(Value::as_object).unwrap_or(&empty);
    let gone = |m: &Map<String, Value>| m.get("deleted_at").is_some_and(|v| !v.is_null());
    let kind = match r.action.as_str() {
        "insert" => "insert",
        "delete" => "remove",
        _ if !gone(before) && gone(after) => "remove",
        _ if gone(before) && !gone(after) => "restore",
        _ if before.get("voided") == Some(&Value::Bool(false)) && after.get("voided") == Some(&Value::Bool(true)) => "void",
        _ => "update",
    };
    let row = if after.is_empty() { before } else { after };
    let changes = if kind == "update" {
        let mut keys: Vec<&String> = after.keys().collect();
        keys.sort();
        keys.into_iter()
            .filter(|k| !HIDDEN.contains(&k.as_str()) && before.get(*k) != after.get(*k))
            .map(|k| Change { field: k.clone(), before: before.get(k).cloned().unwrap_or(Value::Null), after: after[k].clone() })
            .collect()
    } else {
        Vec::new()
    };
    let member_id = if r.table_name == "members" { r.row_id } else { text(row.get("member_id")).and_then(|s| s.parse().ok()) };
    let reason = text(row.get("deleted_reason")).or_else(|| text(row.get("void_reason")));
    let restorable = kind == "remove"
        && r.action == "update"
        && r.removed_now == Some(true)
        && matches!(r.table_name.as_str(), "members" | "expenses" | "withdrawals");
    Line {
        id: r.id,
        at: r.at,
        user: r.user_name,
        label: label(row),
        amount: row.get("amount").or_else(|| row.get("net_balance")).filter(|v| !v.is_null()).cloned(),
        table: r.table_name,
        row_id: r.row_id,
        kind,
        reason,
        member_id,
        changes,
        restorable,
    }
}

/// GET /api/v1/audit (partners), newest first, 100 lines a page.
pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Page>, ApiError> {
    partner(&user)?;
    let q = p.q.as_deref().map(str::trim).filter(|q| !q.is_empty()).map(|q| format!("%{q}%"));
    let mut tx = begin_as(&s.db, &user).await?;
    let raw: Vec<Raw> = sqlx::query_as(
        "SELECT a.id, a.at, st.full_name AS user_name, a.table_name, a.row_id, a.action, a.before, a.after, \
                CASE a.table_name \
                    WHEN 'members' THEN (SELECT x.deleted_at IS NOT NULL FROM members x WHERE x.id = a.row_id) \
                    WHEN 'expenses' THEN (SELECT x.deleted_at IS NOT NULL FROM expenses x WHERE x.id = a.row_id) \
                    WHEN 'withdrawals' THEN (SELECT x.deleted_at IS NOT NULL FROM withdrawals x WHERE x.id = a.row_id) \
                END AS removed_now \
         FROM audit_log a \
         LEFT JOIN app_users u ON u.id = a.user_id LEFT JOIN staff st ON st.id = u.staff_id \
         WHERE a.table_name NOT IN ('user_sessions', 'login_state') \
           AND ($1::date IS NULL OR a.at >= $1::date) AND ($2::date IS NULL OR a.at < $2::date + 1) \
           AND ($3::text IS NULL OR a.table_name = $3) AND ($4::uuid IS NULL OR a.user_id = $4) \
           AND ($5::text IS NULL OR a.before::text ILIKE $5 OR a.after::text ILIKE $5) \
           AND ($6 OR a.action <> 'insert' OR a.after->>'import_batch_id' IS NULL) \
           AND ($7::bigint IS NULL OR a.id < $7) \
         ORDER BY a.id DESC LIMIT $8",
    )
    .bind(p.from)
    .bind(p.to)
    .bind(p.table.as_deref().filter(|t| !t.is_empty()))
    .bind(p.user)
    .bind(q)
    .bind(p.import)
    .bind(p.before)
    .bind(PAGE + 1)
    .fetch_all(&mut *tx)
    .await?;
    let users: Vec<Who> = sqlx::query_as(
        "SELECT u.id, COALESCE(s.full_name, u.username) AS name FROM app_users u LEFT JOIN staff s ON s.id = u.staff_id ORDER BY 2",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let more = raw.len() as i64 > PAGE;
    let lines = raw.into_iter().take(PAGE as usize).map(shape).collect();
    Ok(Json(Page { lines, more, users }))
}

// ---------------------------------------------------------------------------
// Hand-made month estimates

#[derive(Serialize, FromRow)]
pub struct Summary {
    id: Uuid,
    solar_year: i32,
    solar_month: i32,
    starts_on: NaiveDate,
    net_balance: f64,
    note: Option<String>,
}

#[derive(Deserialize)]
pub struct Year {
    year: Option<i32>,
}

/// GET /api/v1/month-summaries?year=1404
pub async fn summaries(State(s): State<AppState>, user: CurrentUser, Query(y): Query<Year>) -> Result<Json<Vec<Summary>>, ApiError> {
    if !user.sees_hall() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        "SELECT id, solar_year, solar_month, starts_on, net_balance::float8 AS net_balance, note FROM month_summaries \
         WHERE deleted_at IS NULL AND department = 'hall' AND ($1::int IS NULL OR solar_year = $1) ORDER BY starts_on",
    )
    .bind(y.year)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct SummaryInput {
    net_balance: f64,
    note: Option<String>,
}

/// PUT /api/v1/month-summaries/:id (partners): correcting an estimate.
pub async fn update_summary(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<SummaryInput>,
) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if !b.net_balance.is_finite() {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE month_summaries SET net_balance = $2, note = $3 WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .bind(b.net_balance)
        .bind(b.note.as_deref().map(str::trim).filter(|n| !n.is_empty()))
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
