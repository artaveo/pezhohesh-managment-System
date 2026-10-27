//! Sign-in, sessions and per-role database access.
//!
//! Passwords are stored as argon2id hashes. A session token is 32 random bytes sent
//! as `Authorization: Bearer <hex>`; the database keeps only its SHA-256. Every request
//! that touches business data runs in a transaction that has switched to the person's
//! database role (see db/migrations/0002_auth.sql), so the database itself enforces
//! who may see which department.

use argon2::password_hash::rand_core::{OsRng, RngCore};
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::extract::{FromRequestParts, Path, State};
use axum::http::{request::Parts, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::AppState;

/// Idle time after which a session ends and the person signs in again.
const SESSION_IDLE_HOURS: i32 = 12;
const MAX_FAILED_LOGINS: i32 = 5;
const LOCK_MINUTES: i32 = 5;
const MIN_PASSWORD_LEN: usize = 8;

// ---------------------------------------------------------------------------
// Errors

pub struct ApiError(pub StatusCode, pub &'static str);

impl ApiError {
    pub const UNAUTHORIZED: ApiError = ApiError(StatusCode::UNAUTHORIZED, "unauthorized");
    pub const FORBIDDEN: ApiError = ApiError(StatusCode::FORBIDDEN, "forbidden");
    pub fn bad(code: &'static str) -> ApiError {
        ApiError(StatusCode::BAD_REQUEST, code)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.0, Json(json!({ "error": self.1 }))).into_response()
    }
}

impl From<sqlx::Error> for ApiError {
    fn from(e: sqlx::Error) -> Self {
        tracing::error!("database: {e}");
        if is_unreachable(&e) {
            return ApiError(StatusCode::SERVICE_UNAVAILABLE, "postgres_down");
        }
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "database")
    }
}

/// PostgreSQL is not answering at all (its service is stopped), as opposed to answering with an error.
pub fn is_unreachable(e: &sqlx::Error) -> bool {
    matches!(e, sqlx::Error::Io(_) | sqlx::Error::PoolTimedOut | sqlx::Error::PoolClosed)
}

// ---------------------------------------------------------------------------
// The signed-in person

#[derive(Clone, Serialize, FromRow)]
pub struct CurrentUser {
    pub id: Uuid,
    pub staff_id: Uuid,
    pub full_name: String,
    pub username: String,
    pub role: String,
    pub can_see_pec_finance: bool,
    pub theme_color: Option<String>,
    pub theme_mode: String,
    pub must_change_password: bool,
}

const USER_COLUMNS: &str = "u.id, u.staff_id, s.full_name, u.username, u.role::text AS role, \
     u.can_see_pec_finance, u.theme_color, u.theme_mode, u.must_change_password";

impl CurrentUser {
    pub fn is_partner(&self) -> bool {
        self.role == "partner"
    }
    pub fn sees_hall(&self) -> bool {
        self.role == "partner" || self.role == "manager"
    }
}

#[axum::async_trait]
impl FromRequestParts<AppState> for CurrentUser {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, ApiError> {
        let token = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or(ApiError::UNAUTHORIZED)?;
        let hash = token_hash(token);
        let user: Option<CurrentUser> = sqlx::query_as(&format!(
            "UPDATE user_sessions x SET last_seen_at = now(), \
                 expires_at = now() + make_interval(hours => {SESSION_IDLE_HOURS}) \
             FROM app_users u JOIN staff s ON s.id = u.staff_id \
             WHERE x.token_hash = $1 AND x.user_id = u.id AND x.revoked_at IS NULL \
               AND x.expires_at > now() AND u.active AND u.deleted_at IS NULL \
             RETURNING {USER_COLUMNS}"
        ))
        .bind(&hash)
        .fetch_optional(&state.db)
        .await?;
        user.ok_or(ApiError::UNAUTHORIZED)
    }
}

/// Starts a transaction that acts as `user`: their database role, and their id for the audit log.
pub async fn begin_as(db: &PgPool, user: &CurrentUser) -> Result<Transaction<'static, Postgres>, ApiError> {
    let role = match user.role.as_str() {
        "partner" => "pz_partner",
        "manager" => "pz_manager",
        "pec_staff" => "pz_pec",
        _ => return Err(ApiError::FORBIDDEN),
    };
    let mut tx = db.begin().await?;
    sqlx::query(&format!("SET LOCAL ROLE {role}")).execute(&mut *tx).await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)")
        .bind(user.id.to_string())
        .execute(&mut *tx)
        .await?;
    Ok(tx)
}

// ---------------------------------------------------------------------------
// Helpers

fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

fn new_token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn hash_password(password: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| ApiError(StatusCode::INTERNAL_SERVER_ERROR, "hash"))
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|h| Argon2::default().verify_password(password.as_bytes(), &h).is_ok())
        .unwrap_or(false)
}

fn check_new_password(password: &str) -> Result<(), ApiError> {
    if password.chars().count() < MIN_PASSWORD_LEN {
        return Err(ApiError::bad("password_too_short"));
    }
    Ok(())
}

fn clean_username(username: &str) -> Result<String, ApiError> {
    let u = username.trim().to_lowercase();
    let ok = (3..=32).contains(&u.len()) && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-');
    if ok { Ok(u) } else { Err(ApiError::bad("bad_username")) }
}

fn check_role(role: &str) -> Result<(), ApiError> {
    match role {
        "partner" | "manager" | "pec_staff" => Ok(()),
        _ => Err(ApiError::bad("bad_role")),
    }
}

async fn load_user(db: impl sqlx::PgExecutor<'_>, id: Uuid) -> Result<CurrentUser, ApiError> {
    Ok(sqlx::query_as(&format!(
        "SELECT {USER_COLUMNS} FROM app_users u JOIN staff s ON s.id = u.staff_id WHERE u.id = $1"
    ))
    .bind(id)
    .fetch_one(db)
    .await?)
}

async fn open_session(db: &PgPool, user_id: Uuid) -> Result<String, ApiError> {
    let token = new_token();
    sqlx::query(&format!(
        "INSERT INTO user_sessions (token_hash, user_id, expires_at) \
         VALUES ($1, $2, now() + make_interval(hours => {SESSION_IDLE_HOURS}))"
    ))
    .bind(token_hash(&token))
    .bind(user_id)
    .execute(db)
    .await?;
    Ok(token)
}

#[derive(Serialize)]
pub struct LoginResponse {
    token: String,
    user: CurrentUser,
}

// ---------------------------------------------------------------------------
// First run: the very first account is a partner, created from the app.

#[derive(Serialize)]
pub struct SetupStatus {
    needs_setup: bool,
}

pub async fn setup_status(State(s): State<AppState>) -> Result<Json<SetupStatus>, ApiError> {
    let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_users)").fetch_one(&s.db).await?;
    Ok(Json(SetupStatus { needs_setup: !any }))
}

#[derive(Deserialize)]
pub struct NewAccount {
    full_name: String,
    username: String,
    password: String,
}

pub async fn setup(State(s): State<AppState>, Json(b): Json<NewAccount>) -> Result<Json<LoginResponse>, ApiError> {
    let username = clean_username(&b.username)?;
    check_new_password(&b.password)?;
    let full_name = b.full_name.trim();
    if full_name.is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    let hash = hash_password(&b.password)?;

    let mut tx = s.db.begin().await?;
    // Serialize concurrent first-run attempts, then make sure nobody beat us to it.
    sqlx::query("LOCK TABLE app_users IN EXCLUSIVE MODE").execute(&mut *tx).await?;
    let any: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_users)").fetch_one(&mut *tx).await?;
    if any {
        return Err(ApiError(StatusCode::CONFLICT, "already_set_up"));
    }
    let staff_id = Uuid::new_v4();
    let user_id = Uuid::new_v4();
    // No app.user_id yet: the audit log records the first account as created by the system.
    sqlx::query("INSERT INTO staff (id, full_name, title) VALUES ($1, $2, 'شریک')")
        .bind(staff_id)
        .bind(full_name)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO app_users (id, staff_id, username, password_hash, role, can_see_pec_finance) \
         VALUES ($1, $2, $3, $4, 'partner', true)",
    )
    .bind(user_id)
    .bind(staff_id)
    .bind(&username)
    .bind(&hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO login_state (user_id, last_login_at) VALUES ($1, now())")
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    let token = open_session(&s.db, user_id).await?;
    Ok(Json(LoginResponse { token, user: load_user(&s.db, user_id).await? }))
}

// ---------------------------------------------------------------------------
// Sign in / out

#[derive(Deserialize)]
pub struct LoginBody {
    username: String,
    password: String,
}

#[derive(FromRow)]
struct LoginRow {
    id: Uuid,
    password_hash: String,
    active: bool,
    locked_seconds: Option<f64>,
}

pub async fn login(State(s): State<AppState>, Json(b): Json<LoginBody>) -> Result<Response, ApiError> {
    let username = b.username.trim().to_lowercase();
    let row: Option<LoginRow> = sqlx::query_as(
        "SELECT u.id, u.password_hash, u.active AND u.deleted_at IS NULL AS active, \
                extract(epoch FROM l.locked_until - now())::float8 AS locked_seconds \
         FROM app_users u LEFT JOIN login_state l ON l.user_id = u.id WHERE u.username = $1",
    )
    .bind(&username)
    .fetch_optional(&s.db)
    .await?;

    let Some(row) = row else {
        // Same work and same answer as a wrong password, so usernames cannot be probed.
        let _ = verify_password(&b.password, "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid_login"));
    };
    if let Some(secs) = row.locked_seconds.filter(|s| *s > 0.0) {
        return Ok((
            StatusCode::LOCKED,
            Json(json!({ "error": "locked", "retry_after_seconds": secs.ceil() as i64 })),
        )
            .into_response());
    }
    if !verify_password(&b.password, &row.password_hash) || !row.active {
        sqlx::query(&format!(
            "INSERT INTO login_state (user_id, failed_logins) VALUES ($1, 1) \
             ON CONFLICT (user_id) DO UPDATE SET \
               failed_logins = CASE WHEN login_state.failed_logins + 1 >= {MAX_FAILED_LOGINS} THEN 0 ELSE login_state.failed_logins + 1 END, \
               locked_until  = CASE WHEN login_state.failed_logins + 1 >= {MAX_FAILED_LOGINS} \
                                    THEN now() + make_interval(mins => {LOCK_MINUTES}) ELSE login_state.locked_until END"
        ))
        .bind(row.id)
        .execute(&s.db)
        .await?;
        return Err(ApiError(StatusCode::UNAUTHORIZED, "invalid_login"));
    }
    sqlx::query(
        "INSERT INTO login_state (user_id, last_login_at) VALUES ($1, now()) \
         ON CONFLICT (user_id) DO UPDATE SET failed_logins = 0, locked_until = NULL, last_login_at = now()",
    )
    .bind(row.id)
    .execute(&s.db)
    .await?;

    let token = open_session(&s.db, row.id).await?;
    Ok(Json(LoginResponse { token, user: load_user(&s.db, row.id).await? }).into_response())
}

pub async fn logout(State(s): State<AppState>, parts: axum::http::HeaderMap) -> Result<StatusCode, ApiError> {
    if let Some(token) = parts.get(axum::http::header::AUTHORIZATION).and_then(|v| v.to_str().ok()).and_then(|v| v.strip_prefix("Bearer ")) {
        sqlx::query("UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1")
            .bind(token_hash(token))
            .execute(&s.db)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}

pub async fn me(user: CurrentUser) -> Json<CurrentUser> {
    Json(user)
}

// ---------------------------------------------------------------------------
// Own account: password and personal color

#[derive(Deserialize)]
pub struct PasswordBody {
    current: String,
    new: String,
}

pub async fn change_password(
    State(s): State<AppState>,
    user: CurrentUser,
    Json(b): Json<PasswordBody>,
) -> Result<StatusCode, ApiError> {
    check_new_password(&b.new)?;
    let hash: String = sqlx::query_scalar("SELECT password_hash FROM app_users WHERE id = $1")
        .bind(user.id)
        .fetch_one(&s.db)
        .await?;
    if !verify_password(&b.current, &hash) {
        return Err(ApiError(StatusCode::UNAUTHORIZED, "wrong_password"));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)").bind(user.id.to_string()).execute(&mut *tx).await?;
    sqlx::query("UPDATE app_users SET password_hash = $2, must_change_password = false WHERE id = $1")
        .bind(user.id)
        .bind(hash_password(&b.new)?)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ThemeBody {
    /// `#rrggbb`, or null to go back to the official green.
    color: Option<String>,
}

pub async fn set_theme(State(s): State<AppState>, user: CurrentUser, Json(b): Json<ThemeBody>) -> Result<StatusCode, ApiError> {
    let color = b.color.map(|c| c.trim().to_lowercase());
    if let Some(c) = &color {
        let ok = c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|x| x.is_ascii_hexdigit());
        if !ok {
            return Err(ApiError::bad("bad_color"));
        }
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)").bind(user.id.to_string()).execute(&mut *tx).await?;
    sqlx::query("UPDATE app_users SET theme_color = $2 WHERE id = $1")
        .bind(user.id)
        .bind(color)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct ThemeModeBody {
    /// system | light | dark
    mode: String,
}

pub async fn set_theme_mode(State(s): State<AppState>, user: CurrentUser, Json(b): Json<ThemeModeBody>) -> Result<StatusCode, ApiError> {
    if !matches!(b.mode.as_str(), "system" | "light" | "dark") {
        return Err(ApiError::bad("bad_mode"));
    }
    let mut tx = s.db.begin().await?;
    sqlx::query("SELECT set_config('app.user_id', $1, true)").bind(user.id.to_string()).execute(&mut *tx).await?;
    sqlx::query("UPDATE app_users SET theme_mode = $2 WHERE id = $1")
        .bind(user.id)
        .bind(&b.mode)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// User accounts (partners only)

#[derive(Serialize, FromRow)]
pub struct UserRow {
    id: Uuid,
    full_name: String,
    username: String,
    role: String,
    can_see_pec_finance: bool,
    active: bool,
    must_change_password: bool,
    last_login_at: Option<chrono::DateTime<chrono::Utc>>,
}

pub async fn list_users(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<UserRow>>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let rows: Vec<UserRow> = sqlx::query_as(
        "SELECT u.id, s.full_name, u.username, u.role::text AS role, u.can_see_pec_finance, u.active, \
                u.must_change_password, \
                (SELECT last_login_at FROM login_state l WHERE l.user_id = u.id) AS last_login_at \
         FROM app_users u JOIN staff s ON s.id = u.staff_id \
         WHERE u.deleted_at IS NULL ORDER BY u.active DESC, u.role, s.full_name",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct CreateUser {
    full_name: String,
    username: String,
    password: String,
    role: String,
    #[serde(default)]
    can_see_pec_finance: bool,
}

pub async fn create_user(
    State(s): State<AppState>,
    user: CurrentUser,
    Json(b): Json<CreateUser>,
) -> Result<(StatusCode, Json<serde_json::Value>), ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let username = clean_username(&b.username)?;
    check_new_password(&b.password)?;
    check_role(&b.role)?;
    let full_name = b.full_name.trim();
    if full_name.is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    let hash = hash_password(&b.password)?;

    let mut tx = begin_as(&s.db, &user).await?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM app_users WHERE username = $1)")
        .bind(&username)
        .fetch_one(&mut *tx)
        .await?;
    if taken {
        return Err(ApiError(StatusCode::CONFLICT, "username_taken"));
    }
    let staff_id = Uuid::new_v4();
    let id = Uuid::new_v4();
    let department = match b.role.as_str() {
        "manager" => Some("hall"),
        "pec_staff" => Some("pec"),
        _ => None,
    };
    sqlx::query("INSERT INTO staff (id, full_name, department) VALUES ($1, $2, $3::department)")
        .bind(staff_id)
        .bind(full_name)
        .bind(department)
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "INSERT INTO app_users (id, staff_id, username, password_hash, role, can_see_pec_finance, must_change_password) \
         VALUES ($1, $2, $3, $4, $5::app_role, $6, true)",
    )
    .bind(id)
    .bind(staff_id)
    .bind(&username)
    .bind(&hash)
    .bind(&b.role)
    .bind(b.role == "partner" || b.can_see_pec_finance)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(json!({ "id": id }))))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    role: Option<String>,
    active: Option<bool>,
    can_see_pec_finance: Option<bool>,
    /// A new temporary password; the person must change it at next sign-in.
    reset_password: Option<String>,
}

pub async fn update_user(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<UpdateUser>,
) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    if let Some(r) = &b.role {
        check_role(r)?;
    }
    let hash = match &b.reset_password {
        Some(p) => {
            check_new_password(p)?;
            Some(hash_password(p)?)
        }
        None => None,
    };

    let mut tx = begin_as(&s.db, &user).await?;
    // Never leave the system without an active partner who can manage accounts.
    let removes_partner = b.active == Some(false) || b.role.as_deref().is_some_and(|r| r != "partner");
    if removes_partner {
        let others: i64 = sqlx::query_scalar(
            "SELECT count(*) FROM app_users WHERE role = 'partner' AND active AND deleted_at IS NULL AND id <> $1",
        )
        .bind(id)
        .fetch_one(&mut *tx)
        .await?;
        if others == 0 {
            return Err(ApiError(StatusCode::CONFLICT, "last_partner"));
        }
    }
    let updated = sqlx::query(
        "UPDATE app_users SET \
            role = COALESCE($2::app_role, role), \
            active = COALESCE($3, active), \
            can_see_pec_finance = CASE WHEN COALESCE($2::app_role, role) = 'partner' THEN true \
                                       ELSE COALESCE($4, can_see_pec_finance) END, \
            password_hash = COALESCE($5, password_hash), \
            must_change_password = must_change_password OR $5 IS NOT NULL \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(&b.role)
    .bind(b.active)
    .bind(b.can_see_pec_finance)
    .bind(&hash)
    .execute(&mut *tx)
    .await?
    .rows_affected();
    if updated == 0 {
        return Err(ApiError(StatusCode::NOT_FOUND, "not_found"));
    }
    tx.commit().await?;

    // Deactivating someone or resetting their password signs them out everywhere.
    if b.active == Some(false) || hash.is_some() {
        sqlx::query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL")
            .bind(id)
            .execute(&s.db)
            .await?;
    }
    Ok(StatusCode::NO_CONTENT)
}
