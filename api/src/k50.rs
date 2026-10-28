//! The ZKTeco K50 fingerprint device at the door. Each member is a user on the device under
//! their member number, with the dates their seat is paid for, so the device itself refuses
//! a finger once the seat has run out, even while the laptop is off. The app works out from
//! the memberships what the device should hold and sends only what changed (`k50_users` is
//! what it last sent); it also reads the device's punches into `attendance`.
//!
//! The device is driven through ZKTeco's own SDK (installed with ZKAccess), by the small
//! 32-bit helper `pezhohesh-k50.exe` (source in `api/k50-helper`), installed next to this API.
//! ZKAccess has to be closed while the app talks to the device.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::{FromRow, PgPool};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::auth::{ApiError, CurrentUser};
use crate::hall::{hall_only, today};
use crate::AppState;

/// Members sent in one talk with the device.
const BATCH: i64 = 40;

#[derive(Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Config {
    /// The app keeps the device up to date by itself.
    enabled: bool,
    ip: String,
    port: u16,
    machine: u32,
    /// The device's communication password (0: none).
    comm_key: u32,
    /// Digits of a user ID on the device, with zeros in front (0: the number as it is).
    /// ZKAccess may have stored 51003 as "051003".
    digits: u8,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, ip: String::new(), port: 4370, machine: 1, comm_key: 0, digits: 0 }
    }
}

/// How the last round with the device went (kept in memory; the page shows it).
#[derive(Serialize, Clone, Default)]
pub struct Last {
    at: Option<DateTime<Utc>>,
    ok: bool,
    error: Option<String>,
    pushed: u32,
    failed: u32,
    punches: u32,
}

static LAST: Mutex<Option<Last>> = Mutex::new(None);
/// One talk with the device at a time.
static DEVICE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static POKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// While someone puts their finger on the device, the rounds leave it alone (seconds since 1970).
static ENROLLING_UNTIL: AtomicU64 = AtomicU64::new(0);

fn now_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs())
}

/// A membership changed: bring the device up to date soon, not at the next round.
pub fn poke() {
    POKE.notify_one();
}

async fn config(db: &PgPool) -> Result<Config, sqlx::Error> {
    let v: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50'").fetch_optional(db).await?;
    Ok(v.and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default())
}

async fn save_setting(db: &PgPool, key: &str, value: Value) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()")
        .bind(key)
        .bind(value)
        .execute(db)
        .await?;
    Ok(())
}

// ---------------------------------------------------------------------------
// The helper

/// Runs `ops` against the device in one connection; one answer per op, each with its own `ok`.
async fn talk(cfg: &Config, ops: Vec<Value>, wait: Duration) -> Result<Vec<Value>, String> {
    if cfg.ip.trim().parse::<Ipv4Addr>().is_err() {
        return Err("no_ip".into());
    }
    let _one = DEVICE.lock().await;
    let request = json!({ "ip": cfg.ip.trim(), "port": cfg.port, "machine": cfg.machine, "key": cfg.comm_key, "ops": ops });
    let answer = ask_helper(&request, wait).await?;
    if answer["ok"] != json!(true) {
        let error = answer["error"].as_str().unwrap_or("failed");
        return Err(match answer["code"].as_i64() {
            Some(code) => format!("{error} ({code})"),
            None => error.to_string(),
        });
    }
    let results = answer["results"].as_array().cloned().unwrap_or_default();
    if results.len() != ops.len() {
        return Err("helper: short answer".into());
    }
    Ok(results)
}

/// Starts the helper with one request and reads its one answer. Callers hold `DEVICE`.
async fn ask_helper(request: &Value, wait: Duration) -> Result<Value, String> {
    let mut cmd = helper_command()?;
    cmd.stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    let mut child = cmd.spawn().map_err(|e| format!("helper: {e}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin.write_all(ascii_json(request).as_bytes()).await.map_err(|e| format!("helper: {e}"))?;
    }
    let output = tokio::time::timeout(wait, child.wait_with_output()).await.map_err(|_| "timeout".to_string())?.map_err(|e| format!("helper: {e}"))?;
    serde_json::from_slice(&output.stdout).map_err(|_| {
        let err = String::from_utf8_lossy(&output.stderr);
        format!("helper: {}", err.lines().find(|l| !l.trim().is_empty()).unwrap_or("no answer").trim())
    })
}

/// JSON with every letter outside ASCII written as a \u escape, so the helper reads it the
/// same whatever code page Windows gives its input.
fn ascii_json(v: &Value) -> String {
    let mut out = String::new();
    for c in v.to_string().chars() {
        if c.is_ascii() {
            out.push(c);
        } else {
            let mut units = [0u16; 2];
            for u in c.encode_utf16(&mut units) {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out
}

/// The helper installed next to this API (the SDK is 32-bit, so it is a program of its own).
/// `K50_HELPER` names a stand-in program for tests.
fn helper_command() -> Result<tokio::process::Command, String> {
    if let Ok(fake) = std::env::var("K50_HELPER") {
        return Ok(tokio::process::Command::new(fake));
    }
    if !cfg!(windows) {
        return Err("not_windows".into());
    }
    let helper = std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.join("pezhohesh-k50.exe")))
        .filter(|p| p.exists())
        .ok_or("no_helper")?;
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(helper);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(cmd)
}

// ---------------------------------------------------------------------------
// What the device should hold

#[derive(FromRow, Clone)]
struct Wanted {
    member_id: Uuid,
    member_no: i32,
    name: String,
    enabled: bool,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    /// The number it was sent under before, when that has changed since.
    old_no: Option<i32>,
    /// From the Excel book: its number is the one ZKAccess gave the same person.
    imported: bool,
    /// The device's user under this number is this member (made by the app, or checked).
    claimed: Option<bool>,
    pushed_name: Option<String>,
}

/// Per member: let in while a monthly or daily seat covers today, from the start of that
/// seat to the end of the last one paid for. Internet-only periods do not open the door.
const WANTED: &str = "
WITH seat AS (
    SELECT ms.member_id, ms.start_date, ms.end_date
    FROM memberships ms JOIN plans p ON p.id = ms.plan_id
    WHERE ms.deleted_at IS NULL AND ms.member_id IS NOT NULL AND p.kind IN ('monthly', 'daily')
), want AS (
    SELECT m.id AS member_id, m.member_no, m.import_batch_id IS NOT NULL AS imported,
           trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name,
           (m.deleted_at IS NULL AND EXISTS (SELECT 1 FROM seat s WHERE s.member_id = m.id AND $1 BETWEEN s.start_date AND s.end_date)) AS enabled,
           COALESCE((SELECT min(s.start_date) FROM seat s WHERE s.member_id = m.id AND $1 BETWEEN s.start_date AND s.end_date),
                    (SELECT max(s.start_date) FROM seat s WHERE s.member_id = m.id)) AS start_date,
           (SELECT max(s.end_date) FROM seat s WHERE s.member_id = m.id) AS end_date
    FROM members m
)
SELECT w.member_id, w.member_no, w.name, w.enabled, w.start_date, w.end_date,
       CASE WHEN k.member_no <> w.member_no THEN k.member_no END AS old_no,
       w.imported, k.claimed, k.pushed_name
FROM want w LEFT JOIN k50_users k ON k.member_id = w.member_id
";

/// Sent when it is wanted now and the device does not have it yet, or when what was sent
/// before has changed. Members who were never sent and are not let in are left alone (the
/// device may still hold them from ZKAccess). A member the device refused waits half an hour.
const DIFFERS: &str = "
    (k.member_id IS NULL OR k.pushed_at IS NULL OR k.member_no <> w.member_no
     OR k.pushed_enabled IS DISTINCT FROM w.enabled OR k.pushed_start IS DISTINCT FROM w.start_date
     OR k.pushed_end IS DISTINCT FROM w.end_date)
    AND (w.enabled OR k.pushed_at IS NOT NULL)
    AND (k.error_at IS NULL OR k.error_at < now() - interval '30 minutes')";

async fn pending(db: &PgPool) -> Result<Vec<Wanted>, sqlx::Error> {
    sqlx::query_as(&format!("{WANTED} WHERE {DIFFERS} ORDER BY w.enabled DESC, w.member_no LIMIT {BATCH}"))
        .bind(today())
        .fetch_all(db)
        .await
}

async fn pending_count(db: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar(&format!("SELECT count(*) FROM ({WANTED} WHERE {DIFFERS}) x")).bind(today()).fetch_one(db).await
}

async fn wanted(db: &PgPool, member: Uuid) -> Result<Option<Wanted>, sqlx::Error> {
    sqlx::query_as(&format!("{WANTED} WHERE w.member_id = $2")).bind(today()).bind(member).fetch_optional(db).await
}

/// The device keeps 24 bytes of a name.
fn short_name(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars() {
        if out.len() + c.len_utf8() > 24 {
            break;
        }
        out.push(c);
    }
    out.trim_end().to_string()
}

/// A member number as the device's user ID.
fn device_no(cfg: &Config, no: i32) -> String {
    format!("{no:0width$}", width = cfg.digits as usize)
}

/// `same_person`: a partner has said the device's user under this number is this member.
fn set_user_ops(cfg: &Config, w: &Wanted, same_person: bool) -> Vec<Value> {
    // A member made in the app owns a device ID only once that is known; until then the
    // helper writes it only if the device has no one there, or has them under this name.
    let checked = w.imported || w.claimed == Some(true) || same_person;
    let mut ops = Vec::new();
    if let Some(old) = w.old_no {
        let owner = if checked { String::new() } else { w.pushed_name.clone().unwrap_or_else(|| short_name(&w.name)) };
        ops.push(json!({ "op": "set_user", "no": device_no(cfg, old), "enabled": false, "existing": true, "owner": owner }));
    }
    ops.push(json!({
        "op": "set_user", "no": device_no(cfg, w.member_no), "name": short_name(&w.name), "enabled": w.enabled,
        "start": w.start_date.map(|d| d.to_string()), "end": w.end_date.map(|d| d.to_string()),
        "owner": if checked { String::new() } else { short_name(&w.name) },
    }));
    ops
}

/// The error kept for a member: "taken:<name on the device>" when the number is someone else's there.
fn answer_error(answer: &Value) -> String {
    let error = answer["error"].as_str().unwrap_or("failed");
    match answer["device_name"].as_str() {
        Some(name) if error == "taken" => format!("taken:{}", name.trim()),
        _ => error.to_string(),
    }
}

/// Writes what the device answered for one member.
async fn record(db: &PgPool, w: &Wanted, answer: &Value) -> Result<bool, sqlx::Error> {
    let ok = answer["ok"] == json!(true);
    if ok {
        sqlx::query(
            "INSERT INTO k50_users (member_id, member_no, pushed_name, pushed_start, pushed_end, pushed_enabled, pushed_at, valid_dates, claimed, device_read) \
             VALUES ($1, $2, $3, $4, $5, $6, now(), $7, true, $8) \
             ON CONFLICT (member_id) DO UPDATE SET member_no = $2, pushed_name = $3, pushed_start = $4, pushed_end = $5, \
               pushed_enabled = $6, pushed_at = now(), valid_dates = $7, claimed = true, device_read = $8, error = NULL, error_at = NULL",
        )
        .bind(w.member_id)
        .bind(w.member_no)
        .bind(short_name(&w.name))
        .bind(w.start_date)
        .bind(w.end_date)
        .bind(w.enabled)
        .bind(answer["valid_dates"].as_bool())
        .bind(answer.get("valid_read").filter(|v| !v.is_null()).cloned())
        .execute(db)
        .await?;
    } else {
        let error = answer_error(answer);
        sqlx::query(
            "INSERT INTO k50_users (member_id, member_no, error, error_at) VALUES ($1, $2, $3, now()) \
             ON CONFLICT (member_id) DO UPDATE SET error = $3, error_at = now()",
        )
        .bind(w.member_id)
        .bind(w.member_no)
        .bind(error)
        .execute(db)
        .await?;
    }
    Ok(ok)
}

/// Sends a batch; the answer for the member's own number is the one that counts.
async fn push(db: &PgPool, cfg: &Config, list: &[Wanted]) -> Result<(u32, u32), String> {
    let mut ops = Vec::new();
    let mut own = Vec::new();
    for w in list {
        ops.extend(set_user_ops(cfg, w, false));
        own.push(ops.len() - 1);
    }
    let answers = talk(cfg, ops, Duration::from_secs(30 + list.len() as u64 * 2)).await?;
    let (mut ok, mut failed) = (0, 0);
    let mut created = Vec::new();
    for (w, i) in list.iter().zip(own) {
        if record(db, w, &answers[i]).await.map_err(|e| e.to_string())? {
            ok += 1;
            if answers[i]["created"] == json!(true) {
                created.push(device_no(cfg, w.member_no));
            }
        } else {
            failed += 1;
        }
    }
    if !created.is_empty() {
        restore_fingers(db, cfg, &created).await;
    }
    Ok((ok, failed))
}

// ---------------------------------------------------------------------------
// The app's copy of the fingers

#[derive(Deserialize)]
struct Finger {
    no: String,
    finger: i32,
    #[serde(default)]
    flag: i32,
    template: String,
}

/// Copies every finger on the device into k50_fingers (nothing on the device changes) and
/// notes when, with how many.
async fn backup_fingers(db: &PgPool, cfg: &Config) -> Result<Value, String> {
    let answers = talk(cfg, vec![json!({ "op": "fingers" })], Duration::from_secs(600)).await?;
    let a = &answers[0];
    if a["ok"] != json!(true) {
        return Err(answer_error(a));
    }
    let list: Vec<Finger> = serde_json::from_value(a["fingers"].clone()).map_err(|e| format!("fingers: {e}"))?;
    let nos: Vec<String> = list.iter().map(|f| f.no.trim().to_string()).collect();
    let fingers: Vec<i32> = list.iter().map(|f| f.finger).collect();
    let flags: Vec<i32> = list.iter().map(|f| f.flag).collect();
    let templates: Vec<&str> = list.iter().map(|f| f.template.as_str()).collect();
    let changed = sqlx::query(
        "INSERT INTO k50_fingers (no, finger, flag, template) \
         SELECT * FROM UNNEST($1::text[], $2::int[], $3::int[], $4::text[]) AS f(no, finger, flag, template) \
         WHERE f.finger BETWEEN 0 AND 9 AND f.template <> '' \
         ON CONFLICT (no, finger) DO UPDATE SET flag = EXCLUDED.flag, template = EXCLUDED.template, read_at = now() \
         WHERE k50_fingers.template IS DISTINCT FROM EXCLUDED.template OR k50_fingers.flag IS DISTINCT FROM EXCLUDED.flag",
    )
    .bind(&nos)
    .bind(&fingers)
    .bind(&flags)
    .bind(&templates)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    let note = json!({ "at": Utc::now(), "users": a["users"], "fingers": list.len(), "changed": changed });
    save_setting(db, "k50_fingers_at", note.clone()).await.map_err(|e| e.to_string())?;
    tracing::info!("k50 fingers backup: {note}");
    Ok(note)
}

/// Once a day while the app keeps the device up to date.
async fn fingers_due(db: &PgPool) -> bool {
    let last: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_fingers_at'").fetch_optional(db).await.ok().flatten();
    let at = last.as_ref().and_then(|v| v["at"].as_str()).and_then(|t| t.parse::<DateTime<Utc>>().ok());
    at.is_none_or(|at| Utc::now() - at > chrono::Duration::hours(20))
}

/// A user the device did not have was just made again: give back the fingers the app saved
/// for that number. Fingers the device already has stay as they are.
async fn restore_fingers(db: &PgPool, cfg: &Config, nos: &[String]) {
    let rows: Vec<(String, i32, i32, String)> = match sqlx::query_as("SELECT no, finger, flag, template FROM k50_fingers WHERE no = ANY($1) ORDER BY no, finger")
        .bind(nos)
        .fetch_all(db)
        .await
    {
        Ok(rows) => rows,
        Err(e) => return tracing::warn!("k50 fingers restore: {e}"),
    };
    let mut ops: Vec<Value> = Vec::new();
    for (no, finger, flag, template) in rows {
        let one = json!({ "finger": finger, "flag": flag, "template": template });
        match ops.last_mut() {
            Some(op) if op["no"] == json!(no) => op["fingers"].as_array_mut().into_iter().for_each(|a| a.push(one.clone())),
            _ => ops.push(json!({ "op": "put_fingers", "no": no, "fingers": [one] })),
        }
    }
    if ops.is_empty() {
        return;
    }
    match talk(cfg, ops, Duration::from_secs(60)).await {
        Ok(answers) => tracing::info!("k50 fingers restored: {}", serde_json::Value::Array(answers)),
        Err(e) => tracing::warn!("k50 fingers restore: {e}"),
    }
}

// ---------------------------------------------------------------------------
// Punches

#[derive(Deserialize)]
struct Punch {
    no: String,
    at: String,
    #[serde(default)]
    verify: i32,
}

/// The device's clock is the office's local time.
fn device_time(at: &str) -> Option<DateTime<Utc>> {
    let local = NaiveDateTime::parse_from_str(at, "%Y-%m-%d %H:%M:%S").ok()?;
    chrono::Local.from_local_datetime(&local).earliest().map(|t| t.with_timezone(&Utc))
}

/// Reads the punches the app has not seen yet; the device keeps its own copy of all of them.
async fn pull_punches(db: &PgPool, cfg: &Config) -> Result<u32, String> {
    let since: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_logs_since'")
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?;
    let since = since.as_ref().and_then(Value::as_str).unwrap_or("").to_string();
    let answers = talk(cfg, vec![json!({ "op": "logs", "since": since })], Duration::from_secs(180)).await?;
    let a = &answers[0];
    if a["ok"] != json!(true) {
        return Err(a["error"].as_str().unwrap_or("logs_failed").to_string());
    }
    let list: Vec<Punch> = match &a["logs"] {
        Value::Array(_) => serde_json::from_value(a["logs"].clone()).unwrap_or_default(),
        one @ Value::Object(_) => serde_json::from_value(one.clone()).map(|p| vec![p]).unwrap_or_default(),
        _ => Vec::new(),
    };
    let newest = list.iter().map(|p| p.at.as_str()).max().map(String::from);
    let (mut nos, mut ats, mut modes) = (Vec::new(), Vec::new(), Vec::new());
    for p in &list {
        if let (Ok(no), Some(at)) = (p.no.trim().parse::<i32>(), device_time(&p.at)) {
            nos.push(no);
            ats.push(at);
            modes.push(p.verify);
        }
    }
    let added = sqlx::query(
        "INSERT INTO attendance (member_id, device_user_no, punched_at, verify_mode) \
         SELECT (SELECT m.id FROM members m WHERE m.member_no = l.no), l.no, l.at, l.mode \
         FROM UNNEST($1::int[], $2::timestamptz[], $3::int[]) AS l(no, at, mode) \
         ON CONFLICT (device_user_no, punched_at) DO NOTHING",
    )
    .bind(&nos)
    .bind(&ats)
    .bind(&modes)
    .execute(db)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    if let Some(newest) = newest.filter(|n| *n > since) {
        save_setting(db, "k50_logs_since", json!(newest)).await.map_err(|e| e.to_string())?;
    }
    Ok(added as u32)
}

// ---------------------------------------------------------------------------
// The rounds

/// Sends everything that changed (a few batches at most) and, when asked, reads the punches.
async fn round(db: &PgPool, cfg: &Config, punches: bool, batches: u32) -> Last {
    let mut last = Last { at: Some(Utc::now()), ok: true, ..Default::default() };
    for _ in 0..batches {
        let list = match pending(db).await {
            Ok(list) if list.is_empty() => break,
            Ok(list) => list,
            Err(e) => {
                last.error = Some(e.to_string());
                break;
            }
        };
        match push(db, cfg, &list).await {
            Ok((ok, failed)) => {
                last.pushed += ok;
                last.failed += failed;
            }
            Err(e) => {
                last.error = Some(e);
                break;
            }
        }
    }
    if punches && last.error.is_none() {
        match pull_punches(db, cfg).await {
            Ok(n) => last.punches = n,
            Err(e) => last.error = Some(e),
        }
    }
    last.ok = last.error.is_none();
    if let Some(e) = &last.error {
        tracing::warn!("k50: {e}");
    }
    *LAST.lock().unwrap() = Some(last.clone());
    last
}

/// Every two minutes (and soon after a membership changes) the device is brought up to
/// date; every ten minutes its punches are read. Nothing runs until a partner turns it on.
pub async fn schedule(db: PgPool) {
    let mut since_punches = Duration::from_secs(600);
    loop {
        let poked = tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(120)) => false,
            _ = POKE.notified() => true,
        };
        if poked {
            // A register-and-renew comes as a few changes in a row.
            tokio::time::sleep(Duration::from_secs(3)).await;
        } else {
            since_punches += Duration::from_secs(120);
        }
        let Ok(cfg) = config(&db).await else { continue };
        if !cfg.enabled || cfg.ip.trim().is_empty() || now_secs() < ENROLLING_UNTIL.load(Ordering::SeqCst) {
            continue;
        }
        let punches = since_punches >= Duration::from_secs(600);
        let last = round(&db, &cfg, punches, 5).await;
        if punches && last.ok {
            since_punches = Duration::ZERO;
        }
        if last.ok && fingers_due(&db).await {
            if let Err(e) = backup_fingers(&db, &cfg).await {
                tracing::warn!("k50 fingers backup: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The device page (partners)

fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.is_partner() { Ok(()) } else { Err(ApiError::FORBIDDEN) }
}

#[derive(Serialize)]
pub struct Status {
    config: Config,
    last: Option<Last>,
    /// Members waiting to be sent.
    pending: i64,
    /// Members on the device, and those it refused last time.
    sent: i64,
    errors: Vec<UserError>,
    punches_today: i64,
    /// Fingers in the app's own copy, and the last time it was read from the device.
    fingers_saved: i64,
    fingers_backup: Option<Value>,
    /// When dates were last taken from the device, and for how many members.
    dates_import: Option<Value>,
}

#[derive(Serialize, FromRow)]
pub struct UserError {
    member_no: i32,
    name: String,
    error: String,
    error_at: DateTime<Utc>,
}

/// GET /api/v1/k50
pub async fn status(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Status>, ApiError> {
    partner(&user)?;
    let sent: i64 = sqlx::query_scalar("SELECT count(*) FROM k50_users WHERE pushed_at IS NOT NULL").fetch_one(&s.db).await?;
    let errors: Vec<UserError> = sqlx::query_as(
        "SELECT k.member_no, trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name, k.error, k.error_at \
         FROM k50_users k JOIN members m ON m.id = k.member_id WHERE k.error IS NOT NULL ORDER BY k.error_at DESC LIMIT 50",
    )
    .fetch_all(&s.db)
    .await?;
    let punches_today: i64 = sqlx::query_scalar("SELECT count(*) FROM attendance WHERE punched_at >= $1")
        .bind(day_start(today()))
        .fetch_one(&s.db)
        .await?;
    let pending = pending_count(&s.db).await?;
    let fingers_saved: i64 = sqlx::query_scalar("SELECT count(*) FROM k50_fingers").fetch_one(&s.db).await?;
    let fingers_backup: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_fingers_at'").fetch_optional(&s.db).await?;
    let dates_import: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_dates_import'").fetch_optional(&s.db).await?;
    let last = LAST.lock().unwrap().clone();
    Ok(Json(Status {
        config: config(&s.db).await?,
        last,
        pending,
        sent,
        errors,
        punches_today,
        fingers_saved,
        fingers_backup,
        dates_import,
    }))
}

fn day_start(day: NaiveDate) -> DateTime<Utc> {
    chrono::Local
        .from_local_datetime(&day.and_hms_opt(0, 0, 0).unwrap_or_default())
        .earliest()
        .map_or_else(Utc::now, |t| t.with_timezone(&Utc))
}

fn check_config(c: &Config) -> Result<(), ApiError> {
    let ip_ok = c.ip.trim().is_empty() || c.ip.trim().parse::<Ipv4Addr>().is_ok();
    if !ip_ok || c.port == 0 || c.machine == 0 || c.digits > 9 || (c.enabled && c.ip.trim().is_empty()) {
        return Err(ApiError::bad("bad_k50_config"));
    }
    Ok(())
}

/// PUT /api/v1/k50
pub async fn set_config(State(s): State<AppState>, user: CurrentUser, Json(mut c): Json<Config>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    c.ip = c.ip.trim().to_string();
    check_config(&c)?;
    save_setting(&s.db, "k50", serde_json::to_value(&c).unwrap_or_default()).await?;
    if c.enabled {
        poke();
    }
    Ok(StatusCode::NO_CONTENT)
}

/// What a device answered, or why it could not.
#[derive(Serialize)]
pub struct DeviceAnswer {
    ok: bool,
    error: Option<String>,
    #[serde(flatten)]
    result: Option<Value>,
}

impl DeviceAnswer {
    fn from(r: Result<Value, String>) -> Json<DeviceAnswer> {
        Json(match r {
            Ok(v) if v["ok"] == json!(true) => DeviceAnswer { ok: true, error: None, result: Some(without_ok(v)) },
            Ok(v) => DeviceAnswer { ok: false, error: Some(answer_error(&v)), result: Some(without_ok(v)) },
            Err(e) => DeviceAnswer { ok: false, error: Some(e), result: None },
        })
    }
}

fn without_ok(mut v: Value) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.remove("ok");
        o.remove("error");
    }
    v
}

/// POST /api/v1/k50/test: reaches the device (with the address on the form, saved or not)
/// and says what it is: serial number, users, fingers, its clock.
pub async fn test(State(s): State<AppState>, user: CurrentUser, Json(mut c): Json<Config>) -> Result<Json<DeviceAnswer>, ApiError> {
    partner(&user)?;
    c.ip = c.ip.trim().to_string();
    check_config(&Config { enabled: false, ..c.clone() })?;
    let _ = &s;
    let r = talk(&c, vec![json!({ "op": "info" })], Duration::from_secs(40)).await.map(|mut a| a.remove(0));
    if let Ok(info) = &r {
        tracing::info!("k50 test: {info}");
    }
    Ok(DeviceAnswer::from(r))
}

/// GET /api/v1/k50/sdk: which copy of ZKTeco's SDK the helper loads ("sdk": "app" when it is
/// the app's own copy), whether the app has its own copy, and the one ZKAccess registered.
pub async fn sdk_status(user: CurrentUser) -> Result<Json<DeviceAnswer>, ApiError> {
    partner(&user)?;
    let _one = DEVICE.lock().await;
    Ok(DeviceAnswer::from(ask_helper(&json!({ "sdk": "status" }), Duration::from_secs(30)).await))
}

#[derive(Deserialize, Default)]
pub struct SdkFrom {
    #[serde(default)]
    from: String,
}

/// POST /api/v1/k50/sdk: copies the SDK into the app's own folder, from `from` (a folder of
/// ZKTeco's SDK download) or, when empty, from where ZKAccess installed it. After this the app
/// no longer needs ZKAccess.
pub async fn sdk_install(user: CurrentUser, body: Option<Json<SdkFrom>>) -> Result<Json<DeviceAnswer>, ApiError> {
    partner(&user)?;
    let from = body.map(|Json(b)| b.from).unwrap_or_default();
    let _one = DEVICE.lock().await;
    let r = ask_helper(&json!({ "sdk": "install", "from": from.trim() }), Duration::from_secs(60)).await;
    tracing::info!("k50 sdk copy: {r:?}");
    Ok(DeviceAnswer::from(r))
}

/// POST /api/v1/k50/fingers: copies every finger on the device into the app now.
pub async fn fingers_now(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Result<Value, String>>, ApiError> {
    partner(&user)?;
    let cfg = config(&s.db).await?;
    if cfg.ip.trim().is_empty() {
        return Err(ApiError::bad("no_ip"));
    }
    Ok(Json(backup_fingers(&s.db, &cfg).await))
}

/// POST /api/v1/k50/sync: one full round now, punches included.
pub async fn sync_now(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Last>, ApiError> {
    partner(&user)?;
    let cfg = config(&s.db).await?;
    if cfg.ip.trim().is_empty() {
        return Err(ApiError::bad("no_ip"));
    }
    Ok(Json(round(&s.db, &cfg, true, 100).await))
}

/// POST /api/v1/k50/time: sets the device's clock to the laptop's.
pub async fn set_time(State(s): State<AppState>, user: CurrentUser) -> Result<Json<DeviceAnswer>, ApiError> {
    partner(&user)?;
    let cfg = config(&s.db).await?;
    let r = talk(&cfg, vec![json!({ "op": "set_time" }), json!({ "op": "info" })], Duration::from_secs(40)).await;
    Ok(DeviceAnswer::from(r.map(|mut a| {
        let info = a.remove(1);
        let mut set = a.remove(0);
        set["time"] = info["time"].clone();
        set
    })))
}

#[derive(Deserialize)]
struct DeviceUser {
    no: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    privilege: i32,
}

#[derive(Serialize)]
pub struct Compared {
    /// The user ID on the device, as it is written there.
    no: String,
    device_name: String,
    /// The member with that number in the app, if any.
    app_name: Option<String>,
    admin: bool,
    /// "same", "differs" (the names look like two people) or "missing" (no such member).
    state: &'static str,
}

/// A name as it is compared: Arabic ي/ك as Persian ی/ک, no half-spaces, one space between
/// words, Latin letters in lower case.
fn plain_name(s: &str) -> String {
    let s: String = s
        .chars()
        .map(|c| match c {
            'ي' | 'ى' => 'ی',
            'ك' => 'ک',
            '\u{200c}' | '\u{200f}' | '\u{200e}' => ' ',
            c => c,
        })
        .flat_map(char::to_lowercase)
        .collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The device keeps short names (often cut), so a device name that starts the app's name
/// counts as the same person. Names written in English on the device (as ZKAccess has them)
/// are compared with the app's Persian ones by their consonants (see `sounds`).
fn same_person(device: &str, app: &str) -> bool {
    let (d, a) = (plain_name(device), plain_name(app));
    if d.is_empty() {
        return false;
    }
    if d == a || a.starts_with(&d) || d.starts_with(&a) {
        return true;
    }
    let (dw, aw) = (sounds(&d), sounds(&a));
    let (df, af) = (dw.concat(), aw.concat());
    if df.is_empty() || af.is_empty() {
        return false;
    }
    // A cut name must still hold the whole first name of the other.
    df == af || (af.starts_with(&df) && df.len() >= aw[0].len()) || (df.starts_with(&af) && af.len() >= dw[0].len())
}

/// Each word of a name as the consonants it sounds with, so "Mohammad Ali" and «محمد علی»
/// both read "mhmd", "l". Vowels (and ا و ی ع, which English writes as vowels or not at all)
/// are left out and a sound said twice counts once.
fn sounds(name: &str) -> Vec<String> {
    name.split_whitespace()
        .map(|word| {
            let w: Vec<char> = word.chars().collect();
            let mut out = String::new();
            let mut i = 0;
            while i < w.len() {
                let next = w.get(i + 1).copied();
                let last = i + 1 == w.len();
                let (class, used) = match (w[i], next) {
                    ('k', Some('h')) | ('x', _) => (Some('k'), 1 + usize::from(w[i] == 'k')),
                    ('g', Some('h')) => (Some('k'), 2),
                    ('s', Some('h')) | ('c', Some('h')) if w[i] == 's' => (Some('s'), 2),
                    ('c', Some('h')) => (Some('j'), 2),
                    ('z', Some('h')) | ('d', Some('h')) => (Some('z'), 2),
                    ('p', Some('h')) => (Some('f'), 2),
                    ('t', Some('h')) => (Some('t'), 2),
                    // A word-final h or ه is a vowel sound: «فاطمه», "Fatemah".
                    ('h' | 'ه' | 'ة', _) if last && i > 0 => (None, 1),
                    (c, _) => (sound(c), 1),
                };
                if let Some(c) = class {
                    if !out.ends_with(c) {
                        out.push(c);
                    }
                }
                i += used;
            }
            out
        })
        .filter(|w| !w.is_empty())
        .collect()
}

fn sound(c: char) -> Option<char> {
    Some(match c {
        'b' | 'p' | 'ب' | 'پ' => 'b',
        't' | 'ت' | 'ط' => 't',
        's' | 'c' | 'ث' | 'س' | 'ص' | 'ش' => 's',
        'j' | 'ج' | 'چ' => 'j',
        'h' | 'ح' | 'ه' | 'ة' => 'h',
        // ق is written Q in Kabul and Gh in Tehran.
        'k' | 'q' | 'g' | 'خ' | 'ق' | 'ک' | 'غ' | 'گ' => 'k',
        'd' | 'د' => 'd',
        'z' | 'ذ' | 'ز' | 'ض' | 'ظ' | 'ژ' => 'z',
        'r' | 'ر' => 'r',
        'f' | 'ف' => 'f',
        'l' | 'ل' => 'l',
        'm' | 'م' => 'm',
        'n' | 'ن' => 'n',
        _ => return None,
    })
}

#[derive(Serialize)]
pub struct Comparison {
    device_users: usize,
    /// Users whose ID is a member number in the app (read with the digits setting).
    in_app: usize,
    not_in_app: usize,
    /// Users whose device name and app name do not look like the same person.
    differs: usize,
    admins: usize,
    /// IDs written with zeros in front (as 051003), and their usual length.
    zero_padded: usize,
    padded_width: Option<usize>,
    /// Members the app had sent that the device lost; they are sent again.
    resend: usize,
    /// Every user whose name differs, then those the app does not know, then up to 300 in all.
    rows: Vec<Compared>,
}

// ---------------------------------------------------------------------------
// Dates from the device, once

/// The day in a date the device gives back ("2026-10-26 16:45:50", or digits only).
fn device_day(s: &str) -> Option<NaiveDate> {
    let digits: String = s.chars().filter(char::is_ascii_digit).take(8).collect();
    NaiveDate::parse_from_str(&digits, "%Y%m%d").ok().filter(|d| d.year() >= 2000)
}

#[derive(Deserialize)]
struct DatedUser {
    no: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    valid: Option<Value>,
}

#[derive(Deserialize)]
pub struct DatesParams {
    #[serde(default)]
    commit: bool,
    /// Also members from the Excel book whose device name does not look like theirs.
    #[serde(default)]
    include_differs: bool,
}

#[derive(Serialize, Clone)]
pub struct DateRow {
    no: String,
    device_name: String,
    app_name: String,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    /// Gets the dates (false only for a name that differs on a member made in the app).
    taken: bool,
}

#[derive(Serialize, Default)]
pub struct DatesReport {
    committed: bool,
    device_users: usize,
    /// Members who get the device's dates (or would, before commit).
    added: Vec<DateRow>,
    /// Members the app already has dates for; the app's dates stand.
    has_dates: usize,
    /// Device users with no let-in dates, or the app has no member under that number.
    no_dates: usize,
    not_in_app: usize,
    /// Names that do not look alike. They get the dates only when asked, and only members
    /// from the Excel book (whose numbers are ZKAccess's), never ones made in the app.
    name_differs: Vec<DateRow>,
}

/// POST /api/v1/k50/dates?commit=: for members the app has no seat dates for at all (the
/// Excel book has none), takes the dates the device lets them in on, as a period without
/// money or bill. Without commit it only shows what it would do. After this the app's
/// dates are the ones that count; it never reads dates from the device for a member that
/// has any.
pub async fn dates_from_device(
    State(s): State<AppState>,
    user: CurrentUser,
    axum::extract::Query(p): axum::extract::Query<DatesParams>,
) -> Result<Json<Result<DatesReport, String>>, ApiError> {
    partner(&user)?;
    let cfg = device_for(&s.db).await?;
    let answer = match talk(&cfg, vec![json!({ "op": "users", "valid": true })], Duration::from_secs(600)).await {
        Ok(mut a) => a.remove(0),
        Err(e) => return Ok(Json(Err(e))),
    };
    if answer["ok"] != json!(true) {
        return Ok(Json(Err(answer_error(&answer))));
    }
    let users: Vec<DatedUser> = serde_json::from_value(answer["users"].clone()).unwrap_or_default();
    let nos: Vec<i32> = users.iter().filter_map(|u| u.no.trim().parse().ok()).collect();
    // Members under those numbers, and whether they have any seat period already.
    let members: Vec<(Uuid, i32, String, bool, bool)> = sqlx::query_as(
        "SELECT m.id, m.member_no, trim(m.first_name || ' ' || COALESCE(m.last_name, '')), m.import_batch_id IS NOT NULL, \
                EXISTS (SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
                        WHERE ms.member_id = m.id AND ms.deleted_at IS NULL AND p.kind IN ('monthly', 'daily')) \
         FROM members m WHERE m.deleted_at IS NULL AND m.member_no = ANY($1)",
    )
    .bind(&nos)
    .fetch_all(&s.db)
    .await?;
    let by_no: std::collections::HashMap<i32, (Uuid, String, bool, bool)> =
        members.into_iter().map(|(id, no, name, imported, dated)| (no, (id, name, imported, dated))).collect();

    let mut report = DatesReport { device_users: users.len(), ..Default::default() };
    let mut take: Vec<(Uuid, NaiveDate, NaiveDate)> = Vec::new();
    for u in &users {
        let Some((id, app_name, imported, dated)) = u.no.trim().parse::<i32>().ok().and_then(|n| by_no.get(&n)) else {
            report.not_in_app += 1;
            continue;
        };
        if *dated {
            report.has_dates += 1;
            continue;
        }
        let valid = u.valid.as_ref().filter(|v| v["expires"].as_i64() == Some(1));
        let (start, end) = match valid {
            Some(v) => (v["start"].as_str().and_then(device_day), v["end"].as_str().and_then(device_day)),
            None => (None, None),
        };
        let (Some(start), Some(end)) = (start, end) else {
            report.no_dates += 1;
            continue;
        };
        if end < start {
            report.no_dates += 1;
            continue;
        }
        let row = DateRow { no: u.no.trim().to_string(), device_name: u.name.trim().to_string(), app_name: app_name.clone(), start: Some(start), end: Some(end), taken: true };
        let alike = row.device_name.is_empty() || same_person(&row.device_name, app_name);
        if !alike {
            let taken = *imported && p.include_differs;
            report.name_differs.push(DateRow { taken, ..row.clone() });
            if !taken {
                continue;
            }
        }
        take.push((*id, start, end));
        report.added.push(row);
    }

    if p.commit && !take.is_empty() {
        let plan: Option<Uuid> = sqlx::query_scalar(
            "SELECT p.id FROM plans p LEFT JOIN memberships ms ON ms.plan_id = p.id AND ms.deleted_at IS NULL \
             WHERE p.kind = 'monthly' GROUP BY p.id, p.active ORDER BY p.active DESC, count(ms.id) DESC LIMIT 1",
        )
        .fetch_optional(&s.db)
        .await?;
        let Some(plan) = plan else { return Err(ApiError::bad("no_monthly_plan")) };
        let ids: Vec<Uuid> = take.iter().map(|t| t.0).collect();
        let starts: Vec<NaiveDate> = take.iter().map(|t| t.1).collect();
        let ends: Vec<NaiveDate> = take.iter().map(|t| t.2).collect();
        let mut tx = crate::auth::begin_as(&s.db, &user).await?;
        // A member who got dates in the meantime keeps them.
        sqlx::query(
            "INSERT INTO memberships (id, member_id, plan_id, start_date, end_date, fee, discount, note, created_by) \
             SELECT gen_random_uuid(), t.member_id, $4, t.start_date, t.end_date, 0, 0, \
                    'تاریخ از دستگاه انگشت؛ پولش پیش از برنامه گرفته شده', $5 \
             FROM UNNEST($1::uuid[], $2::date[], $3::date[]) AS t(member_id, start_date, end_date) \
             WHERE NOT EXISTS (SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
                               WHERE ms.member_id = t.member_id AND ms.deleted_at IS NULL AND p.kind IN ('monthly', 'daily'))",
        )
        .bind(&ids)
        .bind(&starts)
        .bind(&ends)
        .bind(plan)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        report.committed = true;
        save_setting(&s.db, "k50_dates_import", json!({ "at": Utc::now(), "added": take.len() })).await?;
        tracing::info!("k50 dates from device: {} members", take.len());
        poke();
    }
    report.added.sort_by_key(|r| r.no.parse::<i64>().unwrap_or(i64::MAX));
    Ok(Json(Ok(report)))
}

/// POST /api/v1/k50/compare: reads every user on the device (nothing is changed) and puts
/// each next to the app's member with the same number, so a partner can see that the IDs
/// mean the same people before the app writes anything.
pub async fn compare(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Result<Comparison, String>>, ApiError> {
    partner(&user)?;
    let cfg = device_for(&s.db).await?;
    let answer = match talk(&cfg, vec![json!({ "op": "users" })], Duration::from_secs(180)).await {
        Ok(mut a) => a.remove(0),
        Err(e) => return Ok(Json(Err(e))),
    };
    if answer["ok"] != json!(true) {
        return Ok(Json(Err(answer["error"].as_str().unwrap_or("failed").to_string())));
    }
    let users: Vec<DeviceUser> = match &answer["users"] {
        one @ Value::Object(_) => serde_json::from_value(one.clone()).map(|u| vec![u]).unwrap_or_default(),
        list => serde_json::from_value(list.clone()).unwrap_or_default(),
    };
    let nos: Vec<i32> = users.iter().filter_map(|u| u.no.trim().parse().ok()).collect();
    // New member numbers step over these (see hall::NEXT_NO).
    let device_names: Vec<String> =
        users.iter().filter(|u| u.no.trim().parse::<i32>().is_ok()).map(|u| u.name.trim().to_string()).collect();
    let mut tx = s.db.begin().await?;
    sqlx::query("DELETE FROM k50_device_ids").execute(&mut *tx).await?;
    sqlx::query("INSERT INTO k50_device_ids (no, name) SELECT * FROM UNNEST($1::int[], $2::text[]) ON CONFLICT (no) DO NOTHING")
        .bind(&nos)
        .bind(&device_names)
        .execute(&mut *tx)
        .await?;
    // Members the app sent before that the device no longer has (a reset, a ZKAccess "sync
    // to device") go again with the next round, and get their saved fingers back.
    let resend = if users.is_empty() {
        0
    } else {
        sqlx::query(
            "UPDATE k50_users SET pushed_at = NULL, error = NULL, error_at = NULL \
             WHERE pushed_at IS NOT NULL AND NOT (member_no = ANY($1))",
        )
        .bind(&nos)
        .execute(&mut *tx)
        .await?
        .rows_affected() as usize
    };
    tx.commit().await?;
    if resend > 0 {
        tracing::info!("k50 compare: {resend} members sent before are not on the device; sending again");
        poke();
    }
    let names: Vec<(i32, String)> = sqlx::query_as(
        "SELECT member_no, trim(first_name || ' ' || COALESCE(last_name, '')) FROM members WHERE deleted_at IS NULL AND member_no = ANY($1)",
    )
    .bind(&nos)
    .fetch_all(&s.db)
    .await?;
    let app: std::collections::HashMap<i32, String> = names.into_iter().collect();
    let padded: Vec<usize> = users.iter().filter(|u| u.no.len() > 1 && u.no.starts_with('0')).map(|u| u.no.len()).collect();
    let padded_width = {
        let mut counts = std::collections::HashMap::new();
        for w in &padded {
            *counts.entry(*w).or_insert(0) += 1;
        }
        counts.into_iter().max_by_key(|(_, n)| *n).map(|(w, _)| w)
    };
    let mut rows: Vec<Compared> = users
        .iter()
        .map(|u| {
            let app_name = u.no.trim().parse::<i32>().ok().and_then(|n| app.get(&n).cloned());
            let state = match &app_name {
                None => "missing",
                // A user with no name on the device cannot be checked; it is not a different person.
                Some(a) if u.name.trim().is_empty() || same_person(&u.name, a) => "same",
                Some(_) => "differs",
            };
            Compared { no: u.no.clone(), device_name: u.name.trim().to_string(), app_name, admin: u.privilege > 0, state }
        })
        .collect();
    let in_app = rows.iter().filter(|r| r.app_name.is_some()).count();
    let comparison = Comparison {
        device_users: users.len(),
        in_app,
        not_in_app: users.len() - in_app,
        differs: rows.iter().filter(|r| r.state == "differs").count(),
        admins: rows.iter().filter(|r| r.admin).count(),
        zero_padded: padded.len(),
        padded_width,
        resend,
        rows: {
            let rank = |r: &Compared| match r.state {
                "differs" => 0,
                "missing" => 1,
                _ => 2,
            };
            rows.sort_by_key(|r| (rank(r), r.no.trim_start_matches('0').parse::<i64>().unwrap_or(i64::MAX)));
            rows
        },
    };
    Ok(Json(Ok(comparison)))
}

#[derive(Serialize)]
pub struct Found {
    ip: String,
    /// The laptop's own address on that network.
    via: String,
}

/// POST /api/v1/k50/scan: looks for devices (TCP port 4370) on the laptop's own networks.
pub async fn scan(user: CurrentUser) -> Result<Json<Vec<Found>>, ApiError> {
    partner(&user)?;
    let nets: Vec<(Ipv4Addr, u32)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4)
                if !v4.ip.is_loopback() && !v4.ip.is_link_local() && !crate::phone::virtual_network(&i.name, v4.ip) =>
            {
                Some((v4.ip, u32::from(v4.netmask).count_ones()))
            }
            _ => None,
        })
        .collect();
    let mut tasks = tokio::task::JoinSet::new();
    for (own, prefix) in nets {
        // The /24 around the laptop's address (a bigger network would take too long).
        let base = u32::from(own) & if prefix >= 24 { u32::MAX << (32 - prefix) } else { 0xFFFF_FF00 };
        let size = if prefix >= 24 { 1u32 << (32 - prefix) } else { 256 };
        for n in 1..size.saturating_sub(1) {
            let ip = Ipv4Addr::from(base + n);
            if ip == own {
                continue;
            }
            tasks.spawn(async move {
                let addr = SocketAddr::from((ip, 4370));
                let open = tokio::time::timeout(Duration::from_millis(700), tokio::net::TcpStream::connect(addr)).await.is_ok_and(|r| r.is_ok());
                open.then(|| Found { ip: ip.to_string(), via: own.to_string() })
            });
        }
    }
    let mut found = Vec::new();
    while let Some(r) = tasks.join_next().await {
        if let Ok(Some(f)) = r {
            found.push(f);
        }
    }
    found.sort_by(|a, b| a.ip.cmp(&b.ip));
    Ok(Json(found))
}

// ---------------------------------------------------------------------------
// On the member page (the desk)

#[derive(Serialize, FromRow)]
pub struct Sent {
    member_no: i32,
    pushed_start: Option<NaiveDate>,
    pushed_end: Option<NaiveDate>,
    pushed_enabled: Option<bool>,
    pushed_at: Option<DateTime<Utc>>,
    valid_dates: Option<bool>,
    /// The dates as the device gave them back after writing them.
    device_read: Option<Value>,
    fingers: Option<i32>,
    error: Option<String>,
    error_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct MemberK50 {
    /// The device is set up (an address is saved).
    configured: bool,
    auto: bool,
    /// What the device should hold for this member now.
    enabled: bool,
    start_date: Option<NaiveDate>,
    end_date: Option<NaiveDate>,
    sent: Option<Sent>,
    visits: Vec<DateTime<Utc>>,
}

/// GET /api/v1/members/:id/k50 (from the database only; the device is asked with /check).
pub async fn member(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Json<MemberK50>, ApiError> {
    hall_only(&user)?;
    let w = wanted(&s.db, id).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let cfg = config(&s.db).await?;
    let sent: Option<Sent> = sqlx::query_as(
        "SELECT member_no, pushed_start, pushed_end, pushed_enabled, pushed_at, valid_dates, device_read, fingers, error, error_at FROM k50_users WHERE member_id = $1",
    )
    .bind(id)
    .fetch_optional(&s.db)
    .await?;
    let visits: Vec<DateTime<Utc>> =
        sqlx::query_scalar("SELECT punched_at FROM attendance WHERE member_id = $1 ORDER BY punched_at DESC LIMIT 10")
            .bind(id)
            .fetch_all(&s.db)
            .await?;
    Ok(Json(MemberK50 {
        configured: !cfg.ip.is_empty(),
        auto: cfg.enabled,
        enabled: w.enabled,
        start_date: w.start_date,
        end_date: w.end_date,
        sent,
        visits,
    }))
}

async fn device_for(db: &PgPool) -> Result<Config, ApiError> {
    let cfg = config(db).await?;
    if cfg.ip.is_empty() {
        return Err(ApiError::bad("no_ip"));
    }
    Ok(cfg)
}

/// POST /api/v1/members/:id/k50/check: what the device holds for this member (fingers,
/// dates, group and time zones as the device has them), with the device's clock.
pub async fn check(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Json<DeviceAnswer>, ApiError> {
    hall_only(&user)?;
    let cfg = device_for(&s.db).await?;
    let w = wanted(&s.db, id).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let ops = vec![json!({ "op": "user", "no": device_no(&cfg, w.member_no) }), json!({ "op": "time" })];
    let r = talk(&cfg, ops, Duration::from_secs(40)).await.map(|a| {
        let mut user = a[0].clone();
        user["device_time"] = a[1]["time"].clone();
        user
    });
    if let Ok(v) = &r {
        if let Some(f) = v["fingers"].as_i64() {
            sqlx::query("UPDATE k50_users SET fingers = $2 WHERE member_id = $1").bind(id).bind(f as i32).execute(&s.db).await?;
        }
    }
    Ok(DeviceAnswer::from(r))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Push {
    /// The person the device has under this number is this member (said after a `taken`).
    same_person: bool,
}

/// POST /api/v1/members/:id/k50/push: sends this member's dates now.
pub async fn push_member(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    b: Option<Json<Push>>,
) -> Result<Json<DeviceAnswer>, ApiError> {
    hall_only(&user)?;
    let cfg = device_for(&s.db).await?;
    let w = wanted(&s.db, id).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let same_person = b.map(|Json(b)| b.same_person).unwrap_or(false);
    if same_person {
        tracing::info!("k50: {} said member {} is the device user under that number", user.username, w.member_no);
    }
    let r = send_one(&s.db, &cfg, &w, same_person).await;
    Ok(DeviceAnswer::from(r))
}

async fn send_one(db: &PgPool, cfg: &Config, w: &Wanted, same_person: bool) -> Result<Value, String> {
    let mut answers = talk(cfg, set_user_ops(cfg, w, same_person), Duration::from_secs(40)).await?;
    let answer = answers.pop().unwrap_or_default();
    record(db, w, &answer).await.map_err(|e| e.to_string())?;
    Ok(answer)
}

#[derive(Deserialize)]
pub struct Enroll {
    /// 0-9, the device's finger numbers (6 is the right index finger).
    finger: u8,
}

/// POST /api/v1/members/:id/k50/enroll: puts the member on the device (if not there yet)
/// and turns the device to "put your finger" for them; they press it three times.
pub async fn enroll(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<Enroll>,
) -> Result<Json<DeviceAnswer>, ApiError> {
    hall_only(&user)?;
    if b.finger > 9 {
        return Err(ApiError::bad("bad_finger"));
    }
    let cfg = device_for(&s.db).await?;
    let w = wanted(&s.db, id).await?.ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    // As at the desk today: register and pay first, then the finger.
    if !w.enabled {
        return Err(ApiError::bad("no_active_seat"));
    }
    let sent = send_one(&s.db, &cfg, &w, false).await;
    if let Err(e) = &sent {
        return Ok(DeviceAnswer::from(Err(e.clone())));
    }
    if let Ok(v) = &sent {
        if v["ok"] != json!(true) {
            return Ok(DeviceAnswer::from(sent));
        }
    }
    let r = talk(&cfg, vec![json!({ "op": "enroll", "no": device_no(&cfg, w.member_no), "finger": b.finger })], Duration::from_secs(40))
        .await
        .map(|mut a| a.remove(0));
    if r.as_ref().is_ok_and(|v| v["ok"] == json!(true)) {
        ENROLLING_UNTIL.store(now_secs() + 120, Ordering::SeqCst);
    }
    Ok(DeviceAnswer::from(r))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_fit_the_device() {
        assert_eq!(short_name("Ali Ahmadi"), "Ali Ahmadi");
        let long = short_name("محمد عبدالرحمن احمدزی نصیری");
        assert!(long.len() <= 24 && long.chars().count() == 12);
    }

    #[test]
    fn padded_ids() {
        let mut c = Config::default();
        assert_eq!(device_no(&c, 51003), "51003");
        c.digits = 6;
        assert_eq!(device_no(&c, 51003), "051003");
        assert_eq!(device_no(&c, 1234567), "1234567");
    }

    #[test]
    fn requests_are_ascii() {
        let v = json!({ "name": "علی 😀", "n": 1 });
        let text = ascii_json(&v);
        assert!(text.is_ascii());
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), v);
    }

    #[test]
    fn names_are_compared_loosely() {
        assert!(same_person("علي احمدي", "علی  احمدی"));
        assert!(same_person("Ali Ahm", "ali ahmadi"));
        assert!(same_person("زهرا\u{200c}کریمی", "زهرا کریمی"));
        assert!(!same_person("محمد", "زهرا کریمی"));
        assert!(!same_person("", "زهرا"));
        // English on the device, Persian in the app.
        assert!(same_person("Atifa", "عاطفه"));
        assert!(same_person("Mohammad Ali", "محمد علی"));
        assert!(same_person("Zakir Naseri", "ذاکر ناصری"));
        assert!(same_person("Abdul Rahman", "عبدالرحمن"));
        assert!(same_person("Fatemah Ahmadi", "فاطمه احمدی"));
        assert!(same_person("Khalid", "خالد"));
        assert!(same_person("Shabnam Kari", "شبنم کریمی"));
        assert!(same_person("Sadiq", "صادق"));
        assert!(same_person("Ghasem", "قاسم"));
        assert!(same_person("Qasim", "قاسم"));
        assert!(!same_person("SAQIQ", "صادق"));
        assert!(!same_person("Zahra", "محمد"));
        assert!(!same_person("Ali", "احمد علی"));
    }

    #[test]
    fn device_clock_is_local() {
        let t = device_time("2026-10-27 08:30:00").unwrap();
        assert_eq!(t.with_timezone(&chrono::Local).format("%H:%M").to_string(), "08:30");
        assert!(device_time("bad").is_none());
    }
}
