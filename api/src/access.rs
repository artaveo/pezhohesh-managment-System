//! Which sections of the app each role sees. Partners always see everything. For the
//! manager and the education staff the partners tick the sections on the users page; the
//! choice is kept in the `role_access` setting. Every request is checked against it here,
//! on top of what the database itself allows each role.

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::AppState;

/// The sections a partner can hand out, in menu order.
pub const SECTIONS: &[&str] = &[
    "dashboard", "memberships", "members", "registrations", "books", "hotspot", "inbox", "receipts", "expenses",
    "salaries", "shares", "reports", "pec",
];
/// Study-hall sections: the manager's database rights cover these, not the education records.
const HALL: &[&str] = &[
    "dashboard", "memberships", "members", "registrations", "books", "hotspot", "inbox", "receipts", "expenses",
    "salaries", "shares", "reports",
];

/// What each role may be given at all (its database rights).
fn possible(role: &str) -> &'static [&'static str] {
    match role {
        "partner" => SECTIONS,
        "manager" => HALL,
        "pec_staff" => &["pec"],
        _ => &[],
    }
}

/// Before anything was ticked: what each role saw in earlier versions.
fn default_for(role: &str) -> Vec<String> {
    let list: &[&str] = match role {
        "manager" => &["dashboard", "memberships", "members", "registrations", "books", "hotspot", "inbox", "receipts", "expenses", "salaries", "reports"],
        "pec_staff" => &["pec"],
        _ => &[],
    };
    list.iter().map(|s| s.to_string()).collect()
}

#[derive(Serialize, Deserialize, Default, Clone)]
pub struct RoleAccess {
    #[serde(default)]
    manager: Option<Vec<String>>,
    #[serde(default)]
    pec_staff: Option<Vec<String>>,
}

impl RoleAccess {
    fn of(&self, role: &str) -> Vec<String> {
        let chosen = match role {
            "partner" => return SECTIONS.iter().map(|s| s.to_string()).collect(),
            "manager" => self.manager.clone(),
            "pec_staff" => self.pec_staff.clone(),
            _ => None,
        };
        let allowed = possible(role);
        chosen.unwrap_or_else(|| default_for(role)).into_iter().filter(|s| allowed.contains(&s.as_str())).collect()
    }
}

async fn load(db: &PgPool) -> RoleAccess {
    let v: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT value FROM settings WHERE key = 'role_access'").fetch_optional(db).await.ok().flatten();
    v.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// The sections this role sees now.
pub async fn sections_for(db: &PgPool, role: &str) -> Vec<String> {
    load(db).await.of(role)
}

/// The sections a path belongs to; a request is let through when the person has any of them.
/// Paths not listed (sign-in, own settings, prices for the desk) are for everyone the
/// database lets in.
fn needs(path: &str) -> Option<&'static [&'static str]> {
    let rest = path.strip_prefix("/api/v1/")?;
    let first = rest.split('/').next().unwrap_or("");
    Some(match first {
        "dashboard" => &["dashboard"],
        "registrations" => &["registrations"],
        "members" | "periods" | "documents" => &["members", "memberships", "registrations", "books", "inbox"],
        "daily-seats" => &["memberships"],
        "bills" if rest == "bills" => &["receipts", "memberships", "hotspot"],
        "bills" => &["receipts", "memberships", "members", "registrations", "hotspot"],
        "expenses" | "withdrawals" => &["expenses", "salaries"],
        "expense-categories" | "staff" => &["expenses", "salaries"],
        "salaries" => &["salaries"],
        "book-rules" | "book-titles" | "borrowers" | "deposits" | "book-loans" => &["books"],
        "loans" => &["books", "members", "dashboard"],
        "hotspot" => &["hotspot"],
        "inbox" | "phone-upload" | "qr" => &["inbox"],
        "reports" | "month-summaries" => &["reports", "shares", "dashboard"],
        _ => return None,
    })
}

/// Refuses a request for a section this person was not given.
pub fn check(path: &str, user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() {
        return Ok(());
    }
    match needs(path) {
        Some(any) if !any.iter().any(|s| user.sections.iter().any(|m| m == s)) => Err(ApiError(StatusCode::FORBIDDEN, "section_closed")),
        _ => Ok(()),
    }
}

#[derive(Serialize)]
pub struct Editor {
    /// For each role: what it may be given, and what it has now.
    roles: Vec<RoleRow>,
}

#[derive(Serialize)]
pub struct RoleRow {
    role: &'static str,
    possible: &'static [&'static str],
    sections: Vec<String>,
}

/// GET /api/v1/role-access (partners)
pub async fn get(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Editor>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let a = load(&s.db).await;
    let roles = ["manager", "pec_staff"].into_iter().map(|r| RoleRow { role: r, possible: possible(r), sections: a.of(r) }).collect();
    Ok(Json(Editor { roles }))
}

#[derive(Deserialize)]
pub struct SetRole {
    role: String,
    sections: Vec<String>,
}

/// PUT /api/v1/role-access (partners): the ticked sections of one role. Takes effect on
/// the next request of everyone with that role; they see the new menu when they sign in again
/// or the app checks who they are.
pub async fn set(State(s): State<AppState>, user: CurrentUser, Json(b): Json<SetRole>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let allowed = possible(&b.role);
    if !matches!(b.role.as_str(), "manager" | "pec_staff") || b.sections.iter().any(|x| !allowed.contains(&x.as_str())) {
        return Err(ApiError::bad("bad_section"));
    }
    let mut a = load(&s.db).await;
    let mut list: Vec<String> = SECTIONS.iter().filter(|x| b.sections.iter().any(|y| y == *x)).map(|x| x.to_string()).collect();
    list.dedup();
    if b.role == "manager" {
        a.manager = Some(list);
    } else {
        a.pec_staff = Some(list);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('role_access', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::to_value(&a).unwrap_or_default())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manager_defaults_and_limits() {
        let a = RoleAccess::default();
        assert!(!a.of("manager").contains(&"shares".to_string()));
        assert!(a.of("manager").contains(&"memberships".to_string()));
        assert_eq!(a.of("pec_staff"), vec!["pec".to_string()]);
        // A section outside the role's database rights is dropped even if stored.
        let a = RoleAccess { manager: Some(vec!["pec".into(), "books".into()]), pec_staff: None };
        assert_eq!(a.of("manager"), vec!["books".to_string()]);
    }

    #[test]
    fn paths() {
        assert_eq!(needs("/api/v1/me"), None);
        assert_eq!(needs("/api/v1/plans"), None);
        assert!(needs("/api/v1/salaries/x/month").unwrap().contains(&"salaries"));
        assert!(needs("/api/v1/bills").unwrap().contains(&"receipts"));
        assert!(!needs("/api/v1/bills").unwrap().contains(&"members"));
    }
}
