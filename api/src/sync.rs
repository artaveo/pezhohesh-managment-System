//! Sharing the data between computers through the central database in Neon (the "hub").
//!
//! An offline computer (a "node", like the manager's laptop in the hall) keeps its own
//! PostgreSQL. Every change it makes waits in sync_log (see 0018_sync.sql); when there is
//! internet this module sends those changes to the hub and then takes the changes the
//! other computers made, in the order the hub numbered them. Without internet the node
//! works as before and catches up later.
//!
//! A computer that is always online (a partner's laptop) has no database of its own: its
//! API works on the hub directly, and names itself in `online-device.txt`, so its
//! changes, bills and member numbers are its own.
//!
//! The hub's address (with its password) is the one the online copy used:
//! `%APPDATA%\Pezhohesh\online-url.txt`.

use std::path::PathBuf;
use std::sync::RwLock;
use std::time::Duration;

use axum::extract::State;
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::postgres::{PgPool, PgPoolOptions};
use sqlx::Connection;
use uuid::Uuid;

use crate::auth::{ApiError, CurrentUser};
use crate::backup::{pg_command, run};
use crate::AppState;

fn app_file(name: &str) -> Option<PathBuf> {
    std::env::var("APPDATA").ok().map(|d| PathBuf::from(d).join("Pezhohesh").join(name))
}

/// The hub's address.
pub fn hub_url() -> Option<String> {
    crate::online::target_url()
}

/// Set on a computer that works on the hub directly: its id in the devices table.
pub fn online_device() -> Option<Uuid> {
    device_in("online-device.txt")
}

/// Set while such a computer works on its own database for a while (no internet). What
/// is entered then stays on this computer only.
fn paused_device() -> Option<Uuid> {
    device_in("online-device-paused.txt")
}

fn device_in(name: &str) -> Option<Uuid> {
    let text = std::fs::read_to_string(app_file(name)?).ok()?;
    text.lines().next()?.trim().parse().ok()
}

/// Changes sent or taken in one go.
const BATCH: i64 = 300;

#[derive(Serialize, Clone, Default)]
pub struct Live {
    /// Last time a round got through to the hub.
    ok_at: Option<DateTime<Utc>>,
    tried_at: Option<DateTime<Utc>>,
    error: Option<String>,
    sent: u64,
    taken: u64,
    /// This computer's clock against the server's, when they differ by more than 5 minutes
    /// (dates of bills and periods come from this clock).
    clock_off_minutes: Option<i64>,
}

static LIVE: RwLock<Live> = RwLock::new(Live { ok_at: None, tried_at: None, error: None, sent: 0, taken: 0, clock_off_minutes: None });
pub(crate) static RUNNING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();

async fn mode(db: &PgPool) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT sync_mode()").fetch_one(db).await
}

fn hub_pool(url: &str) -> Result<PgPool, String> {
    PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(30))
        .idle_timeout(Duration::from_secs(120))
        .connect_lazy(url)
        .map_err(|e| e.to_string())
}

/// Sends this computer's waiting changes; returns how many.
async fn push(db: &PgPool, hub: &PgPool) -> Result<u64, String> {
    let mut sent = 0;
    loop {
        let entries: Value = sqlx::query_scalar(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object('seq', seq, 'origin', origin, 'tbl', tbl, 'pk', pk, 'op', op, \
                    'row', row, 'user_id', user_id, 'made_at', made_at) ORDER BY seq), '[]') \
             FROM (SELECT * FROM sync_log WHERE hub_seq IS NULL ORDER BY seq LIMIT $1) l",
        )
        .bind(BATCH)
        .fetch_one(db)
        .await
        .map_err(|e| e.to_string())?;
        let n = entries.as_array().map_or(0, |a| a.len());
        if n == 0 {
            return Ok(sent);
        }
        let done: Value = sqlx::query_scalar("SELECT sync_push($1)").bind(&entries).fetch_one(hub).await.map_err(hub_error)?;
        // If this fails after the hub took them, the next round sends them again and the
        // hub, which knows them by (origin, seq), only answers with their numbers.
        sqlx::query(
            "WITH d AS (SELECT (x ->> 'origin_seq')::BIGINT AS seq, (x ->> 'hub_seq')::BIGINT AS hub_seq FROM jsonb_array_elements($1) x), \
                  u AS (UPDATE sync_log l SET hub_seq = d.hub_seq FROM d WHERE l.seq = d.seq RETURNING l.*) \
             INSERT INTO sync_problems (entry, error) SELECT to_jsonb(u), 'hub_refused' FROM u WHERE u.hub_seq = 0",
        )
        .bind(&done)
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
        sent += n as u64;
        if (n as i64) < BATCH {
            return Ok(sent);
        }
    }
}

/// Takes the other computers' changes; returns how many.
async fn pull(db: &PgPool, hub: &PgPool) -> Result<u64, String> {
    let mut taken = 0;
    loop {
        let last: i64 = sqlx::query_scalar("SELECT COALESCE((SELECT (value #>> '{}')::BIGINT FROM settings WHERE key = 'sync_pulled'), 0)")
            .fetch_one(db)
            .await
            .map_err(|e| e.to_string())?;
        let entries: Value = sqlx::query_scalar(
            "SELECT COALESCE(jsonb_agg(jsonb_build_object('hub_seq', hub_seq, 'origin', origin, 'tbl', tbl, 'pk', pk, 'op', op, \
                    'row', row, 'user_id', user_id) ORDER BY hub_seq), '[]') \
             FROM (SELECT * FROM sync_log WHERE hub_seq > $1 ORDER BY hub_seq LIMIT $2) l",
        )
        .bind(last)
        .bind(BATCH)
        .fetch_one(hub)
        .await
        .map_err(hub_error)?;
        let n = entries.as_array().map_or(0, |a| a.len());
        if n == 0 {
            return Ok(taken);
        }
        let mut tx = db.begin().await.map_err(|e| e.to_string())?;
        sqlx::query(
            "INSERT INTO settings (key, value) SELECT 'sync_pulled', to_jsonb(sync_apply($1)) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
        )
        .bind(&entries)
        .execute(&mut *tx)
        .await
        .map_err(|e| e.to_string())?;
        tx.commit().await.map_err(|e| e.to_string())?;
        taken += n as u64;
        if (n as i64) < BATCH {
            return Ok(taken);
        }
    }
}

fn hub_error(e: sqlx::Error) -> String {
    if crate::auth::is_unreachable(&e) {
        "no_internet".into()
    } else {
        e.to_string()
    }
}

/// Before the first round, and after an update: the hub gets this app's tables too (an
/// older app on another computer keeps working, it only does not know the new columns).
async fn migrate_hub(hub: &PgPool) -> Result<(), String> {
    let mut migrator = sqlx::migrate!("../db/migrations");
    migrator.set_ignore_missing(true);
    migrator.run(hub).await.map_err(|e| format!("hub_migration: {e}"))
}

/// One push and pull. Returns how many changes went each way.
async fn round(db: &PgPool, hub: &PgPool, migrated: &mut bool) -> Result<(u64, u64), String> {
    let _one = RUNNING.lock().await;
    let hub_mode: Option<String> = sqlx::query_scalar("SELECT value #>> '{}' FROM settings WHERE key = 'sync_mode'")
        .fetch_optional(hub)
        .await
        .map_err(hub_error)?;
    if hub_mode.as_deref() != Some("hub") {
        return Err("hub_not_ready".into());
    }
    let hub_now: DateTime<Utc> = sqlx::query_scalar("SELECT now()").fetch_one(hub).await.map_err(hub_error)?;
    let off = (Utc::now() - hub_now).num_minutes();
    LIVE.write().unwrap().clock_off_minutes = (off.abs() > 5).then_some(off);
    if !*migrated {
        migrate_hub(hub).await?;
        *migrated = true;
    }
    let sent = push(db, hub).await?;
    let taken = pull(db, hub).await?;
    Ok((sent, taken))
}

/// On a node: every 10 seconds a look at the outbox, and a round when something waits to
/// be sent. Taking the others' changes is quick while there is work and slower when all is
/// quiet (up to 10 minutes), so Neon can sleep: it is paid by the hours it is awake.
pub async fn schedule(db: PgPool) {
    let mut hub: Option<(String, PgPool)> = None;
    let mut migrated = false;
    let mut idle = Duration::from_secs(10);
    let mut last_round: Option<std::time::Instant> = None;
    loop {
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(10)) => {}
            _ = WAKE.notified() => { last_round = None; }
        }
        let (Ok(m), Some(url)) = (mode(&db).await, hub_url()) else { continue };
        if m != "node" {
            continue;
        }
        let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM sync_log WHERE hub_seq IS NULL").fetch_one(&db).await.unwrap_or(0);
        let due = last_round.is_none_or(|t| t.elapsed() >= idle);
        if !due && !(waiting > 0 && LIVE.read().unwrap().error.is_none()) {
            continue;
        }
        if hub.as_ref().is_none_or(|(u, _)| *u != url) {
            match hub_pool(&url) {
                Ok(p) => {
                    hub = Some((url, p));
                    migrated = false;
                }
                Err(e) => {
                    note(Err(e));
                    last_round = Some(std::time::Instant::now());
                    idle = Duration::from_secs(300);
                    continue;
                }
            }
        }
        let outcome = round(&db, &hub.as_ref().unwrap().1, &mut migrated).await;
        idle = match &outcome {
            Ok((s, t)) if s + t > 0 => Duration::from_secs(10),
            Ok(_) => (idle * 2).clamp(Duration::from_secs(20), Duration::from_secs(600)),
            Err(_) => (idle * 2).clamp(Duration::from_secs(30), Duration::from_secs(300)),
        };
        note(outcome);
        last_round = Some(std::time::Instant::now());
    }
}

fn note(outcome: Result<(u64, u64), String>) {
    let mut live = LIVE.write().unwrap();
    live.tried_at = Some(Utc::now());
    match outcome {
        Ok((s, t)) => {
            live.ok_at = live.tried_at;
            live.error = None;
            live.sent += s;
            live.taken += t;
            if s + t > 0 {
                tracing::info!("sync: sent {s}, took {t}");
            }
        }
        Err(e) => {
            if live.error.as_deref() != Some(&e) {
                tracing::warn!("sync: {e}");
            }
            live.error = Some(e);
        }
    }
}

/// A round at once (after starting, or when the internet comes back).
pub fn poke() {
    WAKE.notify_one();
}

// ---------------------------------------------------------------------------
// Status bar and the sync page

#[derive(Serialize)]
pub struct Status {
    /// "off", "node", "online" (works on the hub directly), or "paused" (an online computer
    /// on its own database for now: nothing entered here reaches the server).
    mode: String,
    /// Only the server's name; the address with its password never leaves this computer.
    host: Option<String>,
    device: Option<DeviceRow>,
    waiting: i64,
    problems: i64,
    #[serde(flatten)]
    live: Live,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct DeviceRow {
    id: Uuid,
    name: String,
    receipt_prefix: String,
    member_no_from: Option<i32>,
    member_no_to: Option<i32>,
}

pub async fn status(State(s): State<AppState>, _user: CurrentUser) -> Result<Json<Status>, ApiError> {
    let mode = if online_device().is_some() {
        "online".to_string()
    } else if paused_device().is_some() {
        "paused".to_string()
    } else {
        mode(&s.db).await?
    };
    let host = hub_url().and_then(|u| url::Url::parse(&u).ok()?.host_str().map(String::from));
    let device = sqlx::query_as("SELECT id, name, receipt_prefix, member_no_from, member_no_to FROM devices WHERE id = current_device()")
        .fetch_optional(&s.db)
        .await?;
    let (waiting, problems): (i64, i64) = sqlx::query_as(
        "SELECT (SELECT count(*) FROM sync_log WHERE hub_seq IS NULL AND sync_mode() = 'node'), \
                (SELECT count(*) FROM sync_problems WHERE resolved_at IS NULL)",
    )
    .fetch_one(&s.db)
    .await?;
    let live = LIVE.read().unwrap().clone();
    Ok(Json(Status { mode, host, device, waiting, problems, live }))
}

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

/// "Sync now".
pub async fn now(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Live>, ApiError> {
    partner(&user)?;
    if mode(&s.db).await? != "node" {
        return Err(ApiError::bad("sync_off"));
    }
    let url = hub_url().ok_or(ApiError::bad("no_server"))?;
    let hub = hub_pool(&url).map_err(|_| ApiError::bad("bad_server"))?;
    let mut migrated = false;
    note(round(&s.db, &hub, &mut migrated).await);
    hub.close().await;
    Ok(Json(LIVE.read().unwrap().clone()))
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Problem {
    id: i64,
    at: DateTime<Utc>,
    tbl: Option<String>,
    op: Option<String>,
    error: String,
}

/// Changes from other computers that could not be written here (or that the server refused).
pub async fn problems(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Problem>>, ApiError> {
    partner(&user)?;
    Ok(Json(
        sqlx::query_as(
            "SELECT id, at, entry ->> 'tbl' AS tbl, entry ->> 'op' AS op, error FROM sync_problems \
             WHERE resolved_at IS NULL ORDER BY id DESC LIMIT 200",
        )
        .fetch_all(&s.db)
        .await?,
    ))
}

#[derive(Deserialize)]
pub struct SeenInput {
    /// One problem; left out = all of them.
    id: Option<i64>,
}

/// "Fixed": a partner looked at it and put right by hand what was needed.
pub async fn problems_seen(State(s): State<AppState>, user: CurrentUser, Json(i): Json<SeenInput>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    sqlx::query("UPDATE sync_problems SET resolved_at = now() WHERE resolved_at IS NULL AND ($1::BIGINT IS NULL OR id = $1)")
        .bind(i.id)
        .execute(&s.db)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Starting: this computer's data becomes the hub's

/// Data that stays on each computer and is not copied to the hub.
const LOCAL_DATA: &[&str] = &[
    "user_sessions", "login_state", "k50_fingers", "k50_users", "k50_device_ids", "fingerprint_sync_queue",
    "document_inbox", "receipt_counters", "audit_log", "sync_log", "sync_problems",
];

/// What the hub has now: nothing, an old one-way copy (overwritten), or a running hub.
async fn hub_state(url: &str) -> Result<&'static str, ApiError> {
    let mut c = sqlx::PgConnection::connect(url).await.map_err(|e| {
        tracing::warn!("sync: server: {e}");
        if crate::auth::is_unreachable(&e) { ApiError::bad("no_internet") } else { ApiError::bad("bad_server") }
    })?;
    let has_settings: bool = sqlx::query_scalar("SELECT to_regclass('public.settings') IS NOT NULL").fetch_one(&mut c).await?;
    let running = has_settings
        && sqlx::query_scalar::<_, bool>("SELECT EXISTS (SELECT 1 FROM settings WHERE key = 'sync_mode' AND value #>> '{}' = 'hub')")
            .fetch_one(&mut c)
            .await?;
    let _ = c.close().await;
    Ok(if running { "hub" } else if has_settings { "copy" } else { "empty" })
}

/// The roles the policies and grants name, and this login's right to act as them. On Neon
/// (PostgreSQL 16) the role's creator may not SET it until it grants itself that, as tried.
async fn prepare_roles(url: &str) -> Result<(), String> {
    let mut c = sqlx::PgConnection::connect(url).await.map_err(|e| format!("connect: {e}"))?;
    sqlx::query(
        "DO $$ DECLARE r TEXT; BEGIN \
           FOREACH r IN ARRAY ARRAY['pz_partner', 'pz_manager', 'pz_pec'] LOOP \
             IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN EXECUTE format('CREATE ROLE %I NOLOGIN', r); END IF; \
             IF NOT pg_has_role(current_user, r, 'SET') THEN EXECUTE format('GRANT %I TO %I WITH SET TRUE', r, current_user); END IF; \
           END LOOP; END $$",
    )
    .execute(&mut c)
    .await
    .map_err(|e| format!("roles: {e}"))?;
    let _ = c.close().await;
    Ok(())
}

async fn copy_to_hub(local: &str, hub: &str) -> Result<(), String> {
    let file = std::env::temp_dir().join(format!("pezhohesh-hub-{}.dump", Uuid::new_v4().simple()));
    let result = async {
        let mut dump = pg_command("pg_dump", local)?;
        dump.args(["--format=custom", "--no-owner"]);
        for t in LOCAL_DATA {
            dump.arg(format!("--exclude-table-data={t}"));
        }
        dump.arg("--file").arg(&file);
        run(dump, "pg_dump").await?;
        prepare_roles(hub).await?;
        let mut restore = pg_command("pg_restore", hub)?;
        restore.args(["--clean", "--if-exists", "--no-owner", "--single-transaction"]).arg(&file);
        run(restore, "pg_restore").await?;
        let mut c = sqlx::PgConnection::connect(hub).await.map_err(|e| e.to_string())?;
        // The settings of this computer stay here; the hub is now the hub.
        sqlx::query("DELETE FROM settings WHERE sync_local_setting(key)").execute(&mut c).await.map_err(|e| e.to_string())?;
        sqlx::query("INSERT INTO settings (key, value) VALUES ('sync_mode', '\"hub\"')").execute(&mut c).await.map_err(|e| e.to_string())?;
        let _ = c.close().await;
        Ok(())
    }
    .await;
    let _ = tokio::fs::remove_file(&file).await;
    result
}

/// "Start with this computer": its data goes to the empty server, and from now on its
/// changes are sent there. Only once, on the computer that has all the data (the hall's).
pub async fn start(State(s): State<AppState>, user: CurrentUser) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if online_device().is_some() || paused_device().is_some() || mode(&s.db).await? != "off" {
        return Err(ApiError::bad("sync_already_on"));
    }
    let url = hub_url().ok_or(ApiError::bad("no_server"))?;
    let _one = RUNNING.lock().await;
    if hub_state(&url).await? == "hub" {
        return Err(ApiError::bad("server_in_use"));
    }
    // Changes from this moment are written down. Ones that also make it into the copy
    // are sent once more later, which changes nothing.
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('sync_mode', '\"node\"'), ('sync_pulled', '0') \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .execute(&s.db)
    .await?;
    if let Err(e) = copy_to_hub(&crate::database_url(), &url).await {
        tracing::error!("sync start failed: {e}");
        sqlx::query("DELETE FROM settings WHERE key IN ('sync_mode', 'sync_pulled')").execute(&s.db).await?;
        sqlx::query("DELETE FROM sync_log").execute(&s.db).await?;
        return Err(ApiError(StatusCode::BAD_GATEWAY, "sync_start_failed"));
    }
    tracing::info!("sync started: this computer's data is on the server");
    poke();
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// A computer that works on the hub directly

#[derive(Deserialize)]
pub struct OnlineInput {
    name: String,
}

/// A bill letter nobody has: H is the hall's, P is kept for education services.
const LETTERS: &str = "KLMNRSTUVWXYZABCDEFGJ";

/// "This computer works on the server directly": it gets its own row in devices (with its
/// own bill letter and member numbers), and the app starts again on the server.
pub async fn go_online(State(s): State<AppState>, user: CurrentUser, Json(i): Json<OnlineInput>) -> Result<Json<DeviceRow>, ApiError> {
    partner(&user)?;
    let name = i.name.trim();
    if name.is_empty() || name.chars().count() > 60 {
        return Err(ApiError::bad("bad_name"));
    }
    if online_device().is_some() || paused_device().is_some() {
        return Err(ApiError::bad("sync_already_on"));
    }
    if mode(&s.db).await? == "node" {
        // The offline computer keeps its own database; it is not turned into an online one.
        return Err(ApiError::bad("is_node"));
    }
    let url = hub_url().ok_or(ApiError::bad("no_server"))?;
    if hub_state(&url).await? != "hub" {
        return Err(ApiError::bad("hub_not_ready"));
    }
    prepare_roles(&url).await.map_err(|_| ApiError::bad("bad_server"))?;
    let mut c = sqlx::PgConnection::connect(&url).await.map_err(|_| ApiError::bad("no_internet"))?;
    let mut tx = c.begin().await?;
    let id = Uuid::new_v4();
    sqlx::query("SELECT set_config('app.device_id', $1, true), set_config('app.user_id', $2, true)")
        .bind(id.to_string())
        .bind(user.id.to_string())
        .execute(&mut *tx)
        .await?;
    let taken: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM devices WHERE lower(name) = lower($1))")
        .bind(name)
        .fetch_one(&mut *tx)
        .await?;
    if taken {
        return Err(ApiError::bad("name_taken"));
    }
    let used: Vec<String> = sqlx::query_scalar("SELECT receipt_prefix FROM devices").fetch_all(&mut *tx).await?;
    let letter = LETTERS.chars().map(String::from).find(|l| !used.contains(l)).ok_or(ApiError::bad("no_letter"))?;
    // Blocks of 50 000 from 900 001, far above the hall's numbers.
    let from: i32 = sqlx::query_scalar(
        "SELECT min(f)::INT FROM generate_series(900001, 2000000001, 50000) f \
         WHERE NOT EXISTS (SELECT 1 FROM devices d WHERE d.member_no_from IS NOT NULL AND f <= d.member_no_to AND f + 49999 >= d.member_no_from) \
           AND NOT EXISTS (SELECT 1 FROM members m WHERE m.member_no BETWEEN f AND f + 49999)",
    )
    .fetch_one(&mut *tx)
    .await?;
    let row: DeviceRow = sqlx::query_as(
        "INSERT INTO devices (id, name, receipt_prefix, member_no_from, member_no_to) VALUES ($1, $2, $3, $4, $5) \
         RETURNING id, name, receipt_prefix, member_no_from, member_no_to",
    )
    .bind(id)
    .bind(name)
    .bind(&letter)
    .bind(from)
    .bind(from + 49999)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let _ = c.close().await;
    let file = app_file("online-device.txt").ok_or(ApiError::bad("no_appdata"))?;
    std::fs::write(&file, format!("{id}\n")).map_err(|_| ApiError::bad("no_appdata"))?;
    restart_soon();
    Ok(Json(row))
}

/// Back to this computer's own database (what was in it before going online).
pub async fn go_local(_s: State<AppState>, user: CurrentUser) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    if let Some(file) = app_file("online-device.txt") {
        let _ = std::fs::remove_file(file);
    }
    if let Some(file) = app_file("online-device-paused.txt") {
        let _ = std::fs::remove_file(file);
    }
    restart_soon();
    Ok(StatusCode::NO_CONTENT)
}

/// Back on the server after working on this computer's own database for a while.
pub async fn resume_online(_s: State<AppState>, user: CurrentUser) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let (Some(from), Some(to)) = (app_file("online-device-paused.txt"), app_file("online-device.txt")) else {
        return Err(ApiError::bad("no_appdata"));
    };
    if paused_device().is_none() {
        return Err(ApiError::bad("sync_off"));
    }
    std::fs::rename(from, to).map_err(|_| ApiError::bad("no_appdata"))?;
    restart_soon();
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct ServerState {
    /// "empty", "copy" (an old one-way copy, replaced on start) or "hub" (sync already runs).
    state: &'static str,
    server_members: Option<i64>,
    here_members: i64,
    /// For "hub": the computers already on it.
    devices: Vec<String>,
}

/// What «شروع» would replace, shown before it is pressed.
pub async fn server_state(State(s): State<AppState>, user: CurrentUser) -> Result<Json<ServerState>, ApiError> {
    partner(&user)?;
    let url = hub_url().ok_or(ApiError::bad("no_server"))?;
    let state = hub_state(&url).await?;
    let (mut server_members, mut devices) = (None, vec![]);
    if state != "empty" {
        let mut c = sqlx::PgConnection::connect(&url).await.map_err(|_| ApiError::bad("no_internet"))?;
        server_members = sqlx::query_scalar("SELECT count(*) FROM members WHERE deleted_at IS NULL").fetch_one(&mut c).await.ok();
        if state == "hub" {
            devices = sqlx::query_scalar("SELECT name FROM devices ORDER BY created_at").fetch_all(&mut c).await.unwrap_or_default();
        }
        let _ = c.close().await;
    }
    let here_members = sqlx::query_scalar("SELECT count(*) FROM members WHERE deleted_at IS NULL").fetch_one(&s.db).await?;
    Ok(Json(ServerState { state, server_members, here_members, devices }))
}

/// The desktop app starts the API again within seconds when it stops; it then connects
/// to the other database.
fn restart_soon() {
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(800)).await;
        tracing::info!("restarting for the new database");
        std::process::exit(0);
    });
}
