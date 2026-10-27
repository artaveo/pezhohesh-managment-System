//! The people in the books (partners, manager, Shams, PEC staff), and joining two names that
//! are one person: a sign-in account typed in English and the same partner from the Excel book.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::AppState;

#[derive(Serialize, FromRow)]
pub struct Person {
    id: Uuid,
    full_name: String,
    title: Option<String>,
    /// The sign-in names of this person's accounts.
    usernames: Vec<String>,
    withdrawals: i64,
    withdrawn: f64,
}

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

/// GET /api/v1/people (partners)
pub async fn list(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Person>>, ApiError> {
    partner(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows = sqlx::query_as(
        "SELECT p.id, p.full_name, p.title, \
                ARRAY(SELECT u.username FROM app_users u WHERE u.staff_id = p.id AND u.deleted_at IS NULL ORDER BY u.username) AS usernames, \
                (SELECT count(*) FROM withdrawals w WHERE w.staff_id = p.id AND w.deleted_at IS NULL) AS withdrawals, \
                (SELECT COALESCE(sum(amount), 0)::float8 FROM withdrawals w WHERE w.staff_id = p.id AND w.deleted_at IS NULL AND w.currency = 'AFN') AS withdrawn \
         FROM staff p WHERE p.deleted_at IS NULL ORDER BY (p.title = 'شریک') DESC NULLS LAST, p.full_name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct Merge {
    /// This name goes away...
    from: Uuid,
    /// ...into this one, which keeps its name.
    into: Uuid,
}

/// POST /api/v1/people/merge: everything of `from` (sign-in accounts, withdrawals, salary
/// months, partner share) moves to `into`, and `from` is removed (kept in the audit log).
pub async fn merge(State(s): State<AppState>, user: CurrentUser, Json(m): Json<Merge>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if m.from == m.into {
        return Err(ApiError::bad("same_person"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let found: Vec<Uuid> = sqlx::query_scalar("SELECT id FROM staff WHERE id = ANY($1) AND deleted_at IS NULL FOR UPDATE")
        .bind(vec![m.from, m.into])
        .fetch_all(&mut *tx)
        .await?;
    if found.len() != 2 {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    // A month of salary can be posted once per person.
    let clash: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM salary_accruals a JOIN salary_accruals b \
           ON b.solar_year = a.solar_year AND b.solar_month = a.solar_month AND b.staff_id = $2 WHERE a.staff_id = $1)",
    )
    .bind(m.from)
    .bind(m.into)
    .fetch_one(&mut *tx)
    .await?;
    if clash {
        return Err(ApiError(StatusCode::CONFLICT, "merge_salary_clash"));
    }
    for table in ["app_users", "withdrawals", "salary_accruals", "partner_shares"] {
        sqlx::query(&format!("UPDATE {table} SET staff_id = $2 WHERE staff_id = $1"))
            .bind(m.from)
            .bind(m.into)
            .execute(&mut *tx)
            .await?;
    }
    sqlx::query("UPDATE staff SET salary_charged_to = $2 WHERE salary_charged_to = $1")
        .bind(m.from)
        .bind(m.into)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE staff i SET title = COALESCE(i.title, f.title), \
            department = CASE WHEN i.department IS NULL THEN f.department WHEN f.department IS NULL THEN i.department \
                              WHEN i.department = f.department THEN i.department END, \
            aliases = i.aliases || f.full_name || f.aliases \
         FROM staff f WHERE i.id = $2 AND f.id = $1",
    )
    .bind(m.from)
    .bind(m.into)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE staff SET deleted_at = now(), active = false WHERE id = $1")
        .bind(m.from)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}
