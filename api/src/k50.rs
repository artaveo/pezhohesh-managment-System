//! The ZKTeco K50 fingerprint device at the door. Each member is a user on the device under
//! their member number, with the dates their seat is paid for, so the device itself refuses
//! a finger once the seat has run out, even while the laptop is off. The app works out from
//! the memberships what the device should hold and sends only what changed (`k50_users` is
//! what it last sent); it also reads the device's punches into `attendance`.
//!
//! The device is driven through ZKTeco's own SDK (installed with ZKAccess), by the small
//! 32-bit helper `pezhohesh-k50.exe` (source in `api/k50-helper`), installed next to this API.
//! ZKAccess has to be closed while the app talks to the device.
//!
//! The K50 stops answering the network (until it is restarted) when talks with it are cut
//! off half way, or when it is kept busy. So: every talk has a time budget the helper keeps
//! to and ends properly (the app stops it only well after that); a device that does not
//! answer is asked again less and less often; punches are read only when the device has
//! new ones; and before this API stops it waits for a talk under way. When the device does
//! not answer, `diagnose` says why as far as the network shows it.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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
    /// Once a month the punches are taken off the device after the app has read them all,
    /// so its memory never fills up (see `clear_device_logs`).
    clear_monthly: bool,
    /// While ZKAccess still renews members too: a member the device lets in on days the app
    /// never wrote is not closed or cut by the app (see the helper's `keep_open`).
    keep_zk: bool,
}

impl Default for Config {
    fn default() -> Self {
        Config { enabled: false, ip: String::new(), port: 4370, machine: 1, comm_key: 0, digits: 0, clear_monthly: false, keep_zk: true }
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
    /// Why the device did not answer, as far as the network shows (see `diagnose`).
    diagnosis: Option<&'static str>,
}

static LAST: Mutex<Option<Last>> = Mutex::new(None);
/// One talk with the device at a time.
static DEVICE: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static POKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// While someone puts their finger on the device, the rounds leave it alone (seconds since 1970).
static ENROLLING_UNTIL: AtomicU64 = AtomicU64::new(0);
/// The device did not answer: the rounds wait until then (seconds since 1970), longer after
/// each failure in a row, so a device that is stuck is not kept busy with knocks.
static RETRY_AT: AtomicU64 = AtomicU64::new(0);
static FAILS: AtomicU64 = AtomicU64::new(0);
/// This API is stopping: no new talk with the device starts.
static QUIET: AtomicBool = AtomicBool::new(false);
/// The laptop's Wi-Fi is changing (the hotspot goes on or off): no talk starts before then
/// (seconds since 1970). A talk cut off by the network going away mid-way leaves the device stuck.
static HOLD_UNTIL: AtomicU64 = AtomicU64::new(0);
/// This computer's network addresses as last seen, and when they last changed (seconds).
static NETWORK: Mutex<(String, u64)> = Mutex::new((String::new(), 0));
/// A network that changed this recently is let settle before the device is talked to.
const SETTLE_SECS: u64 = 60;
/// A helper gets this much more than its budget before it is stopped by force.
const GRACE: Duration = Duration::from_secs(30);

/// The wait before the next round after `fails` failures in a row: 2, 4, 8, 16, then 30 minutes.
fn backoff(fails: u64) -> u64 {
    (120u64 << fails.saturating_sub(1).min(4)).min(1800)
}

/// The device was not reached at all (as opposed to refusing one member).
fn unreachable(error: &str) -> bool {
    error.starts_with("connect_failed") || error == "timeout" || error == "busy"
}

/// Before this API stops (closing, a restore, another database): no new talk starts, and a
/// talk under way is waited for, up to `max`.
pub async fn quiesce(max: Duration) {
    QUIET.store(true, Ordering::SeqCst);
    if tokio::time::timeout(max, DEVICE.lock()).await.is_err() {
        tracing::warn!("k50: a talk with the device was still going when the API stopped");
    }
}

/// The network changed within the last minute: an address came or went (Wi-Fi reconnecting,
/// the hotspot going on or off, a cable pulled). Talks wait until it has settled.
fn network_settling() -> bool {
    let mut now: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr {
            if_addrs::IfAddr::V4(v4) => Some(format!("{}={}", i.name, v4.ip)),
            _ => None,
        })
        .collect();
    now.sort();
    let now = now.join(",");
    let mut seen = NETWORK.lock().unwrap();
    if seen.0 != now {
        // The first look is not a change.
        let first = seen.0.is_empty();
        if !first {
            tracing::warn!("network changed: [{}] -> [{now}]", seen.0);
            // What Windows itself recorded about the Wi-Fi: its state now, and its last
            // connect and disconnect events with their reason. Only for the log.
            std::thread::spawn(|| tracing::warn!("wifi after the change: {}", wifi_story()));
        }
        *seen = (now, if first { 0 } else { now_secs() });
    }
    now_secs().saturating_sub(seen.1) < SETTLE_SECS
}

/// The Wi-Fi as Windows sees it, in one line: `netsh wlan show interfaces` (state, network,
/// signal) and the last WLAN-AutoConfig events (8001 connected, 8002 failed with a reason,
/// 8003 disconnected with a reason, 12013 disconnected). On 2026-11-04 14:20 the Wi-Fi
/// «Pezhohesh_Library» went away for every computer ("no connectable Access Point was
/// visible") and the office laptop did not join it again; this says why next time.
fn wifi_story() -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let run = |exe: &str, args: &[&str]| -> String {
            std::process::Command::new(exe)
                .args(args)
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
                .unwrap_or_else(|e| format!("({exe}: {e})"))
        };
        let keep = ["Name", "State", "SSID", "Signal", "Radio type", "Channel", "Receive rate", "Hosted network"];
        let iface: Vec<String> = run("netsh", &["wlan", "show", "interfaces"])
            .lines()
            .map(str::trim)
            .filter(|l| keep.iter().any(|k| l.starts_with(k)) && !l.starts_with("BSSID"))
            .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect();
        let query = "*[System[(EventID=8001 or EventID=8002 or EventID=8003 or EventID=12013)]]";
        let events: Vec<String> = run("wevtutil", &["qe", "Microsoft-Windows-WLAN-AutoConfig/Operational", &format!("/q:{query}"), "/c:4", "/rd:true", "/f:text"])
            .split("Event[")
            .filter(|e| !e.trim().is_empty())
            .map(|e| {
                let line = |k: &str| e.lines().map(str::trim).find(|l| l.starts_with(k)).map(|l| l[k.len()..].trim().to_string()).unwrap_or_default();
                let reason = e.lines().map(str::trim).find(|l| l.starts_with("Reason:") || l.starts_with("Failure Reason:")).unwrap_or("").to_string();
                let ssid = line("SSID:");
                format!("{} id {} {} {}", line("Date:"), line("Event ID:"), ssid, reason).split_whitespace().collect::<Vec<_>>().join(" ")
            })
            .collect();
        format!("interfaces [{}]; events [{}]", iface.join(", "), events.join(" | "))
    }
    #[cfg(not(windows))]
    String::new()
}

/// POST /api/v1/k50/hold?seconds=45 (local only): the desktop app asks this before it turns the
/// hotspot on or off. A talk under way is finished first; then none starts for that long.
pub async fn hold_now(axum::extract::Query(q): axum::extract::Query<HoldFor>) -> StatusCode {
    HOLD_UNTIL.store(now_secs() + q.seconds.min(120), Ordering::SeqCst);
    let _ = tokio::time::timeout(Duration::from_secs(90), DEVICE.lock()).await;
    StatusCode::NO_CONTENT
}

#[derive(Deserialize)]
pub struct HoldFor {
    #[serde(default = "hold_default")]
    seconds: u64,
}

fn hold_default() -> u64 {
    45
}

/// POST /api/v1/k50/quiesce: the desktop app asks this before it closes the API (local only).
pub async fn quiesce_now() -> StatusCode {
    quiesce(Duration::from_secs(90)).await;
    StatusCode::NO_CONTENT
}

/// The K50 holds 80,000 punches. It never forgets one by itself, and every read of them gets
/// longer as they pile up; when it is full it stops recording. The device page warns from here.
pub const LOGS_WARN: i64 = 60_000;

/// POST /api/v1/k50/logs/clear (partners): takes the punches off the device once the app has
/// every one of them (they stay in the app's attendance). Users, fingers and settings stay.
pub async fn clear_logs(State(s): State<AppState>, user: CurrentUser) -> Result<Json<DeviceAnswer>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let cfg = config(&s.db).await?;
    check_config(&cfg)?;
    Ok(DeviceAnswer::from(clear_device_logs(&s.db, &cfg, &user.username).await))
}

/// Reads every punch the app does not have yet and then takes them all off the device. A read
/// that fails or is cut short stops it: nothing is cleared that the app has not got.
async fn clear_device_logs(db: &PgPool, cfg: &Config, by: &str) -> Result<Value, String> {
    // The count is written again only by a whole read.
    sqlx::query("DELETE FROM settings WHERE key = 'k50_logs_count'").execute(db).await.map_err(|e| e.to_string())?;
    pull_punches(db, cfg).await?;
    let held: Option<i64> = sqlx::query_scalar("SELECT (value #>> '{}')::bigint FROM settings WHERE key = 'k50_logs_count'")
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    let Some(held) = held else { return Err("logs_not_read".into()) };
    let r = talk(cfg, vec![json!({ "op": "clear_logs" })], Duration::from_secs(60)).await?.remove(0);
    if r["ok"] == json!(true) {
        save_setting(db, "k50_logs_count", json!(0)).await.map_err(|e| e.to_string())?;
        save_setting(db, "k50_logs_cleared", json!({ "at": Utc::now(), "count": held, "by": by })).await.map_err(|e| e.to_string())?;
        tracing::warn!("k50: {held} punches cleared from the device ({by})");
    }
    Ok(r)
}

/// With `clear_monthly`: the punches were not cleared yet in this Solar month.
async fn clear_due(db: &PgPool) -> bool {
    let last: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_logs_cleared'").fetch_optional(db).await.ok().flatten();
    let held: Option<i64> = sqlx::query_scalar("SELECT (value #>> '{}')::bigint FROM settings WHERE key = 'k50_logs_count'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten()
        .flatten();
    let month = |d: NaiveDate| (crate::solar::year_of(d), crate::solar::month_day(d).0);
    let at = last.as_ref().and_then(|v| v["at"].as_str()).and_then(|t| t.parse::<DateTime<Utc>>().ok());
    held.is_some_and(|n| n > 0) && at.is_none_or(|at| month(at.with_timezone(&chrono::Local).date_naive()) != month(today()))
}

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
    if QUIET.load(Ordering::SeqCst) {
        return Err("closing".into());
    }
    // The Wi-Fi is changing (hotspot): wait for it, at most two minutes.
    let held = HOLD_UNTIL.load(Ordering::SeqCst).saturating_sub(now_secs()).min(120);
    if held > 0 {
        tokio::time::sleep(Duration::from_secs(held)).await;
    }
    let _one = DEVICE.lock().await;
    if QUIET.load(Ordering::SeqCst) {
        return Err("closing".into());
    }
    // The helper ends the talk itself within `wait`; it is stopped by force only well after.
    let request = json!({
        "ip": cfg.ip.trim(), "port": cfg.port, "machine": cfg.machine, "key": cfg.comm_key,
        "budget": wait.as_secs(), "ops": ops,
    });
    let names: Vec<&str> = ops.iter().filter_map(|o| o["op"].as_str()).collect();
    let began = std::time::Instant::now();
    let answer = ask_helper(&request, wait + GRACE).await;
    // Every talk goes in the log (what, how long, how it ended), so a device that stops
    // answering can be traced to what was asked of it just before.
    let took = began.elapsed().as_millis();
    match &answer {
        Ok(a) if a["ok"] == json!(true) => tracing::info!("k50 talk: {} in {took} ms", names.join(",")),
        Ok(a) => tracing::warn!("k50 talk: {} in {took} ms: {} {}", names.join(","), a["error"], a["code"]),
        Err(e) => tracing::warn!("k50 talk: {} in {took} ms: {e}", names.join(",")),
    }
    let answer = answer?;
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
    // The device answered: the rounds go back to their usual pace.
    let failed = FAILS.load(Ordering::SeqCst);
    if failed > 0 {
        tracing::info!("k50: the device answers again, after {failed} tries that it did not");
    }
    FAILS.store(0, Ordering::SeqCst);
    RETRY_AT.store(0, Ordering::SeqCst);
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
    /// The last day the app itself wrote for this member (none: never written).
    pushed_end: Option<NaiveDate>,
    /// Removed, with the number freed or asked to be (such members are not sent again).
    #[allow(dead_code)]
    giving_up: bool,
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
           (SELECT max(s.end_date) FROM seat s WHERE s.member_id = m.id) AS end_date,
           (m.free_no OR m.no_freed_at IS NOT NULL) AS giving_up
    FROM members m
)
SELECT w.member_id, w.member_no, w.name, w.enabled, w.start_date, w.end_date,
       CASE WHEN k.member_no <> w.member_no THEN k.member_no END AS old_no,
       w.imported, k.claimed, k.pushed_name, k.pushed_end, w.giving_up
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
    AND NOT w.giving_up
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
/// ZKAccess's last day, typed by hand, is often a day or two off the app's 30 days: a device
/// end within this many days of the app's is the same month, and the app's day counts.
const ZK_MARGIN_DAYS: i64 = 3;

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
        "keep_open": cfg.keep_zk, "pushed_end": w.pushed_end.map(|d| d.to_string()).unwrap_or_default(), "margin": ZK_MARGIN_DAYS,
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
    // The device kept this member open on ZKAccess's days: noted with what it now holds, so
    // the member's page says so. What the app wanted is still recorded as sent, so the next
    // rounds do not send it again and again.
    let mut read = answer.get("valid_read").filter(|v| !v.is_null()).cloned();
    if let Some(kept) = answer.get("kept_open").filter(|v| v.is_object()) {
        tracing::info!("k50: member {} kept open on the device's own days {} to {} (ZKAccess); app wanted {} to {:?}",
            w.member_no, kept["start"], kept["end"], if w.enabled { "open" } else { "closed" }, w.end_date);
        let mut r = read.take().unwrap_or_else(|| json!({}));
        r["kept"] = kept.clone();
        read = Some(r);
    }
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
        .bind(read)
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

/// A member whose ID was changed in the app, and whose old ID on the device is surely
/// theirs: the new ID is made with the member's dates, the fingers are moved from the old ID
/// to the new one, and only then the old ID is taken off the device (so it is free there too).
/// If the fingers could not be moved the old ID stays, closed, and nothing is lost.
async fn renumber(db: &PgPool, cfg: &Config, w: &Wanted, old: i32) -> Result<bool, String> {
    let (from, to) = (device_no(cfg, old), device_no(cfg, w.member_no));
    // The new ID is written only if the device has no one else there (the owner check).
    let moved = Wanted { old_no: None, imported: false, claimed: None, ..w.clone() };
    let made = talk(cfg, set_user_ops(cfg, &moved, false), Duration::from_secs(30)).await?.remove(0);
    if made["ok"] != json!(true) {
        record(db, w, &made).await.map_err(|e| e.to_string())?;
        return Ok(false);
    }
    let fingers = talk(cfg, vec![json!({ "op": "move_fingers", "from": from, "to": to })], Duration::from_secs(60)).await?.remove(0);
    let fingers_ok = fingers["ok"] == json!(true);
    if fingers_ok {
        // The app's own copy of the fingers follows the ID.
        let _ = sqlx::query("UPDATE k50_fingers SET no = $2 WHERE no = $1 AND NOT EXISTS (SELECT 1 FROM k50_fingers f WHERE f.no = $2 AND f.finger = k50_fingers.finger)")
            .bind(&from)
            .bind(&to)
            .execute(db)
            .await;
        let gone = talk(cfg, vec![json!({ "op": "delete_user", "no": from })], Duration::from_secs(30)).await?.remove(0);
        if gone["ok"] == json!(true) {
            let _ = sqlx::query("DELETE FROM k50_device_ids WHERE no = $1").bind(old).execute(db).await;
            let _ = sqlx::query("DELETE FROM k50_fingers WHERE no = $1").bind(&from).execute(db).await;
        } else {
            tracing::warn!("k50 renumber {from} -> {to}: old ID not removed: {gone}");
        }
    } else {
        // Keep the old ID, closed, with its fingers.
        let _ = talk(cfg, vec![json!({ "op": "set_user", "no": from, "enabled": false, "existing": true, "owner": "" })], Duration::from_secs(30)).await;
        tracing::warn!("k50 renumber {from} -> {to}: fingers not moved: {fingers}");
    }
    tracing::info!("k50: member {} moved from ID {from} to {to} (fingers: {fingers})", w.member_id);
    record(db, w, &made).await.map_err(|e| e.to_string())
}

/// Sends a batch; the answer for the member's own number is the one that counts.
async fn push(db: &PgPool, cfg: &Config, list: &[Wanted]) -> Result<(u32, u32), String> {
    let (mut moved_ok, mut moved_failed) = (0, 0);
    let mut rest = Vec::new();
    for w in list {
        match w.old_no {
            Some(old) if w.imported || w.claimed == Some(true) => {
                if renumber(db, cfg, w, old).await? { moved_ok += 1 } else { moved_failed += 1 }
            }
            _ => rest.push(w.clone()),
        }
    }
    if rest.is_empty() {
        return Ok((moved_ok, moved_failed));
    }
    let list = &rest[..];
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
    Ok((ok + moved_ok, failed + moved_failed))
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
    // How many punches the device held last time: the same count means nothing new to read.
    let known: Option<i64> = sqlx::query_scalar("SELECT (value #>> '{}')::bigint FROM settings WHERE key = 'k50_logs_count'")
        .fetch_optional(db)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    let mut op = json!({ "op": "logs", "since": since });
    if let Some(n) = known.filter(|_| !since.is_empty()) {
        op["known"] = json!(n);
    }
    let answers = talk(cfg, vec![op], Duration::from_secs(180)).await?;
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
         SELECT (SELECT m.id FROM members m WHERE m.member_no = l.no AND m.no_freed_at IS NULL), l.no, l.at, l.mode \
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
    // A read cut short by time is finished next round from where it stopped, so the count is
    // kept only for a whole read.
    if let Some(count) = a["count"].as_i64().filter(|c| *c >= 0 && a["partial"] != json!(true)) {
        save_setting(db, "k50_logs_count", json!(count)).await.map_err(|e| e.to_string())?;
    }
    Ok(added as u32)
}

// ---------------------------------------------------------------------------
// The rounds

/// Sends everything that changed (a few batches at most) and, when asked, reads the punches.
async fn round(db: &PgPool, cfg: &Config, punches: bool, batches: u32) -> Last {
    let mut last = Last { at: Some(Utc::now()), ok: true, ..Default::default() };
    if let Err(e) = free_asked(db, cfg).await {
        last.error = Some(e);
    }
    for _ in 0..batches {
        if last.error.is_some() {
            break;
        }
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
    match &last.error {
        Some(e) if unreachable(e) => {
            let ip = cfg.ip.trim().parse().ok();
            last.diagnosis = match ip {
                Some(ip) => Some(diagnose(db, ip).await),
                None => None,
            };
            let fails = FAILS.fetch_add(1, Ordering::SeqCst) + 1;
            RETRY_AT.store(now_secs() + backoff(fails), Ordering::SeqCst);
            tracing::warn!("k50: {e} ({}; try {fails}, next in {} min)", last.diagnosis.unwrap_or("?"), backoff(fails) / 60);
            // Is it the device or the network? A ping to it, and to others on its network
            // (the modem first): others answering and the device not means the device itself.
            if let Some(ip) = ip {
                let seen = tokio::task::spawn_blocking(move || network_check(ip)).await.unwrap_or_default();
                tracing::warn!("k50 network check: {seen}");
            }
        }
        Some(e) => tracing::warn!("k50: {e}"),
        None => {
            if let Ok(ip) = cfg.ip.trim().parse() {
                remember_mac(db, ip).await;
                remember_wifi(db, ip).await;
            }
        }
    }
    // Windows put this laptop on another Wi-Fi (it did on 2026-11-04 14:21, when the office
    // Wi-Fi was gone for a minute and a saved network with internet was in reach): the
    // device is on the office one, so the laptop is sent back to it.
    if last.diagnosis == Some("other_network") && cfg.enabled {
        rejoin_wifi(db).await;
    }
    *LAST.lock().unwrap() = Some(last.clone());
    last
}

// ---------------------------------------------------------------------------
// When the device does not answer

/// Why the device did not answer, as far as this computer's network shows it:
/// - `other_network`: this computer is not on the device's network (another Wi-Fi, a phone's
///   hotspot, or the cable is out);
/// - `no_answer`: nothing on the network answers for the device's address (it is off, its
///   cable is out, or its network part is stuck; restarting the device brings it back);
/// - `other_device`: another device answers for that address (two have the same IP);
/// - `answers`: the device is on the network but did not take the connection (another
///   program, such as ZKAccess, may be talking to it, or the communication key differs).
async fn diagnose(db: &PgPool, ip: Ipv4Addr) -> &'static str {
    if !on_network(ip) {
        return "other_network";
    }
    let Some(mac) = tokio::task::spawn_blocking(move || arp(ip)).await.ok().flatten() else { return "no_answer" };
    let known: Option<String> = sqlx::query_scalar("SELECT value #>> '{}' FROM settings WHERE key = 'k50_mac'")
        .fetch_optional(db)
        .await
        .ok()
        .flatten();
    match known {
        Some(k) if !k.eq_ignore_ascii_case(&mac) => "other_device",
        _ => "answers",
    }
}

/// One line for the log when the device does not answer: whether it answers on the network
/// (ARP: its hardware address; and a ping), and whether up to three other devices this
/// computer knows on its network do. Some computers block pings; ARP still tells.
fn network_check(ip: Ipv4Addr) -> String {
    let probe = |a: Ipv4Addr| {
        let mac = arp(a).unwrap_or_else(|| "none".into());
        format!("{a} arp {mac}, ping {}", if ping(a) { "yes" } else { "no" })
    };
    let mut out = vec![format!("device {}", probe(ip))];
    out.extend(neighbours(ip).into_iter().take(3).map(probe));
    out.join("; ")
}

/// Other addresses in the device's /24 that this computer has seen lately (its ARP table),
/// the .1 (usually the modem) first.
#[cfg(windows)]
fn neighbours(ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    use windows_sys::Win32::NetworkManagement::IpHelper::{GetIpNetTable, MIB_IPNETTABLE};
    let mut size = 0u32;
    // SAFETY: the first call only reports the size; the second fills a buffer of that size,
    // aligned for MIB_IPNETTABLE, and the rows are read within the count it gives.
    unsafe {
        GetIpNetTable(std::ptr::null_mut(), &mut size, 0);
        if size == 0 {
            return Vec::new();
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        let table = buf.as_mut_ptr() as *mut MIB_IPNETTABLE;
        if GetIpNetTable(table, &mut size, 1) != 0 {
            return Vec::new();
        }
        let rows = std::slice::from_raw_parts((*table).table.as_ptr(), (*table).dwNumEntries as usize);
        let net = &ip.octets()[..3];
        // Only addresses that answered (dynamic) or were set by hand (static), as `arp -a` lists
        // them; a lookup that got no answer leaves an "invalid" row behind.
        let mut found: Vec<Ipv4Addr> = rows
            .iter()
            .filter(|r| matches!(r.Anonymous.dwType, 3 | 4))
            .map(|r| Ipv4Addr::from(r.dwAddr.to_ne_bytes()))
            .filter(|a| &a.octets()[..3] == net && *a != ip && !matches!(a.octets()[3], 0 | 255))
            .collect();
        found.sort_by_key(|a| (a.octets()[3] != 1, a.octets()[3]));
        found.dedup();
        found
    }
}

#[cfg(not(windows))]
fn neighbours(_ip: Ipv4Addr) -> Vec<Ipv4Addr> {
    Vec::new()
}

/// One ICMP echo with a second to answer (what `ping` does), without needing a console.
#[cfg(windows)]
fn ping(ip: Ipv4Addr) -> bool {
    use windows_sys::Win32::NetworkManagement::IpHelper::{IcmpCloseHandle, IcmpCreateFile, IcmpSendEcho};
    // SAFETY: the handle is checked and closed; the reply buffer is larger than one echo reply
    // with its 8 bytes of data, and only the count of replies and their status are read.
    unsafe {
        let h = IcmpCreateFile();
        if h.is_null() || h as isize == -1 {
            return false;
        }
        let data = *b"pezhoesh";
        let mut reply = [0u8; 128];
        let n = IcmpSendEcho(h, u32::from_ne_bytes(ip.octets()), data.as_ptr().cast(), data.len() as u16, std::ptr::null(), reply.as_mut_ptr().cast(), reply.len() as u32, 1000);
        IcmpCloseHandle(h);
        // ICMP_ECHO_REPLY: the address, then the status (0: answered).
        n > 0 && u32::from_ne_bytes([reply[4], reply[5], reply[6], reply[7]]) == 0
    }
}

#[cfg(not(windows))]
fn ping(_ip: Ipv4Addr) -> bool {
    false
}

/// Some network of this computer holds `ip`.
fn on_network(ip: Ipv4Addr) -> bool {
    if_addrs::get_if_addrs().unwrap_or_default().into_iter().any(|i| match i.addr {
        if_addrs::IfAddr::V4(v4) if !v4.ip.is_loopback() => {
            let mask = u32::from(v4.netmask);
            mask != 0 && u32::from(v4.ip) & mask == u32::from(ip) & mask
        }
        _ => false,
    })
}

/// The hardware address that answers for `ip` on the local network (an ARP request), if any.
#[cfg(windows)]
fn arp(ip: Ipv4Addr) -> Option<String> {
    use windows_sys::Win32::NetworkManagement::IpHelper::SendARP;
    let mut mac = [0u8; 8];
    let mut len = mac.len() as u32;
    // SAFETY: SendARP writes at most `len` bytes into `mac` and the length it wrote into `len`.
    let r = unsafe { SendARP(u32::from_ne_bytes(ip.octets()), 0, mac.as_mut_ptr().cast(), &mut len) };
    (r == 0 && len >= 6).then(|| mac[..6].iter().map(|b| format!("{b:02X}")).collect::<Vec<_>>().join("-"))
}

#[cfg(not(windows))]
fn arp(_ip: Ipv4Addr) -> Option<String> {
    None
}

/// After a good round: the device's hardware address, so another device taking its IP later
/// can be told apart.
async fn remember_mac(db: &PgPool, ip: Ipv4Addr) {
    if let Some(mac) = tokio::task::spawn_blocking(move || arp(ip)).await.ok().flatten() {
        let _ = sqlx::query(
            "INSERT INTO settings (key, value) VALUES ('k50_mac', to_jsonb($1::text)) \
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value",
        )
        .bind(mac)
        .execute(db)
        .await;
    }
}

/// The Wi-Fi (interface and network name) through which this computer reaches the device,
/// kept after a good round; nothing when the device is reached by cable.
async fn remember_wifi(db: &PgPool, ip: Ipv4Addr) {
    let Ok(Some((interface, ssid))) = tokio::task::spawn_blocking(move || wifi_to(ip)).await else { return };
    let _ = sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('k50_wifi', $1) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now() WHERE settings.value IS DISTINCT FROM EXCLUDED.value",
    )
    .bind(json!({ "interface": interface, "ssid": ssid }))
    .execute(db)
    .await;
}

/// The device is not on any network of this computer: when the Wi-Fi it was reached through
/// is now on another network (or on none), Windows is asked to join the device's again.
/// Logged either way. A Wi-Fi that is not in reach just fails to join.
async fn rejoin_wifi(db: &PgPool) {
    let saved: Option<Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_wifi'").fetch_optional(db).await.ok().flatten();
    let Some(saved) = saved else { return };
    let (Some(interface), Some(ssid)) = (saved["interface"].as_str().map(str::to_string), saved["ssid"].as_str().map(str::to_string)) else { return };
    let r = tokio::task::spawn_blocking(move || {
        let now = wifi_interfaces().into_iter().find(|w| w.0 == interface);
        match now {
            Some((_, state, current)) if state == "connected" && current == ssid => format!("{interface} is on {ssid} already"),
            other => {
                let was = other.map(|(_, state, current)| format!("{state} {current}")).unwrap_or_else(|| "not found".into());
                let out = netsh(&["wlan", "connect", &format!("name={ssid}"), &format!("ssid={ssid}"), &format!("interface={interface}")]);
                format!("{interface} was {was}; asked to join {ssid}: {}", out.split_whitespace().collect::<Vec<_>>().join(" "))
            }
        }
    })
    .await
    .unwrap_or_default();
    tracing::warn!("k50 wifi: {r}");
}

fn netsh(args: &[&str]) -> String {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("netsh")
            .args(args)
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
            .unwrap_or_else(|e| format!("(netsh: {e})"))
    }
    #[cfg(not(windows))]
    {
        let _ = args;
        String::new()
    }
}

/// Each Wi-Fi interface as `netsh wlan show interfaces` lists it: (name, state, network).
fn wifi_interfaces() -> Vec<(String, String, String)> {
    let mut out: Vec<(String, String, String)> = Vec::new();
    for line in netsh(&["wlan", "show", "interfaces"]).lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim(), v.trim().to_string());
        match k {
            "Name" => out.push((v, String::new(), String::new())),
            "State" => if let Some(w) = out.last_mut() { w.1 = v },
            "SSID" => if let Some(w) = out.last_mut() { w.2 = v },
            _ => {}
        }
    }
    out
}

/// The connected Wi-Fi interface whose network holds `ip`, with its network name.
fn wifi_to(ip: Ipv4Addr) -> Option<(String, String)> {
    let on: Vec<String> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter(|i| match &i.addr {
            if_addrs::IfAddr::V4(v4) => {
                let mask = u32::from(v4.netmask);
                mask != 0 && u32::from(v4.ip) & mask == u32::from(ip) & mask
            }
            _ => false,
        })
        .map(|i| i.name)
        .collect();
    wifi_interfaces().into_iter().find(|w| w.1 == "connected" && !w.2.is_empty() && on.contains(&w.0)).map(|w| (w.0, w.2))
}

/// ZKAccess (or another ZKTeco program) is open on this computer. It keeps its own connection
/// to the device, and the K50 does not take two programs well: the app then reads punches
/// less often and the device page says so.
#[cfg(windows)]
pub fn zk_program_open() -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
    use windows_sys::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION};
    let zk = |path: &str| {
        let p = path.to_lowercase();
        ["\\zkaccess", "\\zktime", "\\zkbio", "\\att2008", "zkaccess"].iter().any(|n| p.contains(n))
    };
    // SAFETY: plain Win32 calls; every handle opened here is closed here.
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snap == INVALID_HANDLE_VALUE {
            return false;
        }
        let mut e: PROCESSENTRY32W = std::mem::zeroed();
        e.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut found = false;
        let mut more = Process32FirstW(snap, &mut e) != 0;
        while more && !found {
            let name = String::from_utf16_lossy(&e.szExeFile[..e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len())]);
            found = zk(&name);
            if !found {
                let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, e.th32ProcessID);
                if !h.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut len = buf.len() as u32;
                    if QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut len) != 0 {
                        found = zk(&String::from_utf16_lossy(&buf[..len as usize]));
                    }
                    CloseHandle(h);
                }
            }
            more = Process32NextW(snap, &mut e) != 0;
        }
        CloseHandle(snap);
        found
    }
}

#[cfg(not(windows))]
pub fn zk_program_open() -> bool {
    false
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
        // The device did not answer lately: leave it alone until its next try. Nor while the
        // laptop's network is changing: a talk the network cuts off leaves the device stuck.
        if now_secs() < RETRY_AT.load(Ordering::SeqCst) || now_secs() < HOLD_UNTIL.load(Ordering::SeqCst) || QUIET.load(Ordering::SeqCst) {
            continue;
        }
        if tokio::task::spawn_blocking(network_settling).await.unwrap_or(false) {
            continue;
        }
        // With ZKAccess open the device has two programs to serve: punches every half hour.
        let every = if tokio::task::spawn_blocking(zk_program_open).await.unwrap_or(false) { 1800 } else { 600 };
        let punches = since_punches >= Duration::from_secs(every);
        let last = round(&db, &cfg, punches, 5).await;
        if punches && last.ok {
            since_punches = Duration::ZERO;
        }
        // Once a month, at a quiet moment, the device's punches go (the app has them all).
        if cfg.clear_monthly && last.ok && punches && last.punches == 0 && clear_due(&db).await {
            if let Err(e) = clear_device_logs(&db, &cfg, "every month").await {
                tracing::warn!("k50: monthly clear: {e}");
            }
        }
        // The daily copy of every finger is a long talk: done when no one has just come in.
        if last.ok && punches && last.punches == 0 && fingers_due(&db).await {
            if let Err(e) = backup_fingers(&db, &cfg).await {
                tracing::warn!("k50 fingers backup: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// The device page (partners)

/// The device page: partners, and whoever a partner gave «دستگاه انگشت».
fn partner(user: &CurrentUser) -> Result<(), ApiError> {
    if user.may("device") { Ok(()) } else { Err(ApiError::FORBIDDEN) }
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
    /// ZKAccess (or another ZKTeco program) is open on this computer.
    zk_program_open: bool,
    /// The device did not answer: the next try (seconds since 1970) and failures in a row.
    retry_at: Option<u64>,
    fails: u64,
    /// Punches the device holds (as counted at the last read), and from how many the page warns.
    logs_on_device: Option<i64>,
    logs_warn: i64,
    /// When the punches were last taken off the device, how many, and by whom.
    logs_cleared: Option<Value>,
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
    let logs_on_device: Option<i64> = sqlx::query_scalar("SELECT (value #>> '{}')::bigint FROM settings WHERE key = 'k50_logs_count'")
        .fetch_optional(&s.db)
        .await?
        .flatten();
    let retry_at = Some(RETRY_AT.load(Ordering::SeqCst)).filter(|t| *t > now_secs());
    Ok(Json(Status {
        zk_program_open: tokio::task::spawn_blocking(zk_program_open).await.unwrap_or(false),
        retry_at,
        fails: FAILS.load(Ordering::SeqCst),
        logs_on_device,
        logs_warn: LOGS_WARN,
        logs_cleared: sqlx::query_scalar("SELECT value FROM settings WHERE key = 'k50_logs_cleared'").fetch_optional(&s.db).await?,
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

/// GET /api/v1/k50/sdk/copies: folders holding a copy of the SDK from a backup, for a new
/// computer without ZKAccess.
pub async fn sdk_copies(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<String>>, ApiError> {
    partner(&user)?;
    Ok(Json(crate::backup::sdk_copies(&s.db).await?))
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
    #[serde(default = "yes")]
    enabled: bool,
    /// With `dates`: the days the device lets this user in.
    #[serde(default)]
    valid: Option<Value>,
}

fn yes() -> bool {
    true
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
    enabled: bool,
    /// The member with that number in the app, to open their page.
    member_id: Option<Uuid>,
    /// Read only when asked for (`dates`): the days the device lets them in.
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
    /// Fingers the app keeps a copy of under this ID.
    saved_fingers: i64,
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

/// Device names a partner said are the member with that number (see k50_name_ok).
async fn names_confirmed(db: &PgPool) -> Result<std::collections::HashMap<i32, String>, sqlx::Error> {
    let rows: Vec<(i32, String)> = sqlx::query_as("SELECT member_no, device_name FROM k50_name_ok").fetch_all(db).await?;
    Ok(rows.into_iter().collect())
}

/// `same_person`, or a partner said so for this number and this very device name.
fn same_or_confirmed(confirmed: &std::collections::HashMap<i32, String>, no: &str, device: &str, app: &str) -> bool {
    same_person(device, app)
        || no.trim().parse::<i32>().ok().and_then(|n| confirmed.get(&n)).is_some_and(|d| plain_name(d) == plain_name(device))
}

/// The device keeps short names (often cut), so a device name that starts the app's name
/// counts as the same person. Names written in English on the device (as ZKAccess has them)
/// are compared with the app's Persian ones by their consonants (see `sounds`).
pub(crate) fn same_person(device: &str, app: &str) -> bool {
    let (d, a) = (plain_name(device), plain_name(app));
    if d.is_empty() {
        return false;
    }
    if d == a || a.starts_with(&d) || d.starts_with(&a) {
        return true;
    }
    let (dw, aw) = (sounds(&d), sounds(&a));
    if dw.is_empty() || aw.is_empty() {
        return false;
    }
    // English often leaves out the h of ح and ه inside a word: "Zabiullah", «ذبیح الله».
    let no_h = |w: &[String]| w.iter().map(|x| x.replace('h', "")).filter(|x| !x.is_empty()).collect::<Vec<_>>();
    joined_alike(&dw, &aw) || joined_alike(&no_h(&dw), &no_h(&aw)) || words_alike(&dw, &aw) || words_alike(&no_h(&dw), &no_h(&aw))
}

/// The whole names run together, so «عبدالرحمن» and "Abdul Rahman" meet. A cut name must
/// still hold the whole first name of the other.
fn joined_alike(dw: &[String], aw: &[String]) -> bool {
    let join = |w: &[String]| {
        let mut out = String::new();
        for c in w.concat().chars() {
            if !out.ends_with(c) {
                out.push(c);
            }
        }
        out
    };
    let (df, af) = (join(dw), join(aw));
    if df.is_empty() || af.is_empty() || dw.is_empty() || aw.is_empty() {
        return false;
    }
    df == af || (af.starts_with(&df) && df.len() >= aw[0].len()) || (df.starts_with(&af) && af.len() >= dw[0].len())
}

/// Word by word, as the desk shortens names on the device: «محمد» and «سید» left out or
/// written "Moh", "S"; the surname left out. Every device word must stand for the app word
/// in its place (the same, or its start), and at least one of them must be written out.
fn words_alike(dw: &[String], aw: &[String]) -> bool {
    // «محمد», «سید», «سیده», «میر» as `sounds` reads them.
    let title = |w: &str| matches!(w, "mhmd" | "sd" | "mr");
    let fits = |dw: &[String], aw: &[String]| {
        !dw.is_empty()
            && dw.len() <= aw.len()
            && dw.iter().zip(aw).all(|(d, a)| a == d || a.starts_with(d.as_str()))
            && dw.iter().zip(aw).any(|(d, a)| a == d && d.len() >= 2 && !title(a))
    };
    let skip_app = usize::from(aw.len() > 1 && title(&aw[0]));
    let skip_dev = usize::from(dw.len() > 1 && (dw[0].len() == 1 || title(&dw[0])));
    fits(dw, aw) || fits(dw, &aw[skip_app..]) || fits(&dw[skip_dev..], &aw[skip_app..])
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
    /// Numbers of removed members the device no longer has, now free for new members.
    freed: usize,
    /// Every user whose name differs, then those the app does not know, then up to 300 in all.
    rows: Vec<Compared>,
}

// ---------------------------------------------------------------------------
// Dates from the device, once

/// The day in a date the device gives back: "2026-10-26 16:45:50", digits only ("20261026"),
/// or, as the K50 writes it, without leading zeros: "2026-11-3 0:0:0" is the 3rd (taking the
/// first eight digits made it the 30th).
fn device_day(s: &str) -> Option<NaiveDate> {
    let parts: Vec<&str> = s.split(|c: char| !c.is_ascii_digit()).filter(|p| !p.is_empty()).collect();
    let day = match parts.as_slice() {
        [whole, ..] if whole.len() >= 8 => NaiveDate::parse_from_str(&whole[..8], "%Y%m%d").ok(),
        [y, m, d, ..] if y.len() == 4 => NaiveDate::from_ymd_opt(y.parse().ok()?, m.parse().ok()?, d.parse().ok()?),
        _ => None,
    };
    day.filter(|d| d.year() >= 2000)
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
    /// Members whose last period in the app ends before the day the device still lets them in
    /// to (renewed in ZKAccess or the Excel book, not in the app), and that day is today or
    /// later: they get a period from the day after the app's end (or the device's first day,
    /// if later) to the device's last day. `start` is that new first day.
    extended: Vec<DateRow>,
    /// Members the app already has dates for, as far as the device's or further; they stand.
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
/// money or bill. Members whose app dates end before the device's, while the device still
/// lets them in today, get the rest as such a period too (`extended`): the Excel book gives
/// money and names but no days, the device has the days. A device end that is past, or not
/// after the app's, changes nothing. Without commit it only shows what it would do.
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
    // Members under those numbers, and the last day of their seat periods (none: no dates yet).
    let members: Vec<(Uuid, i32, String, bool, Option<NaiveDate>)> = sqlx::query_as(
        "SELECT m.id, m.member_no, trim(m.first_name || ' ' || COALESCE(m.last_name, '')), m.import_batch_id IS NOT NULL, \
                (SELECT max(ms.end_date) FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
                 WHERE ms.member_id = m.id AND ms.deleted_at IS NULL AND p.kind IN ('monthly', 'daily')) \
         FROM members m WHERE m.deleted_at IS NULL AND m.member_no = ANY($1)",
    )
    .bind(&nos)
    .fetch_all(&s.db)
    .await?;
    let by_no: std::collections::HashMap<i32, (Uuid, String, bool, Option<NaiveDate>)> =
        members.into_iter().map(|(id, no, name, imported, last)| (no, (id, name, imported, last))).collect();

    let confirmed = names_confirmed(&s.db).await?;
    let today = crate::hall::today();
    let mut report = DatesReport { device_users: users.len(), ..Default::default() };
    let mut take: Vec<(Uuid, NaiveDate, NaiveDate)> = Vec::new();
    let mut extend: Vec<(Uuid, NaiveDate, NaiveDate)> = Vec::new();
    for u in &users {
        let Some((id, app_name, imported, last)) = u.no.trim().parse::<i32>().ok().and_then(|n| by_no.get(&n)) else {
            report.not_in_app += 1;
            continue;
        };
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
        // A member with dates in the app: only the part the device lets them in beyond the
        // app's last day, and only while it still runs.
        let start = match *last {
            None => start,
            Some(last) if end > last + chrono::Duration::days(ZK_MARGIN_DAYS) && end >= today => start.max(last + chrono::Duration::days(1)),
            Some(_) => {
                report.has_dates += 1;
                continue;
            }
        };
        let row = DateRow { no: u.no.trim().to_string(), device_name: u.name.trim().to_string(), app_name: app_name.clone(), start: Some(start), end: Some(end), taken: true };
        let alike = row.device_name.is_empty() || same_or_confirmed(&confirmed, &row.no, &row.device_name, app_name);
        if !alike {
            let taken = *imported && p.include_differs;
            report.name_differs.push(DateRow { taken, ..row.clone() });
            if !taken {
                continue;
            }
        }
        if last.is_some() {
            extend.push((*id, start, end));
            report.extended.push(row);
        } else {
            take.push((*id, start, end));
            report.added.push(row);
        }
    }

    if p.commit && (!take.is_empty() || !extend.is_empty()) {
        let plan: Option<Uuid> = sqlx::query_scalar(
            "SELECT p.id FROM plans p LEFT JOIN memberships ms ON ms.plan_id = p.id AND ms.deleted_at IS NULL \
             WHERE p.kind = 'monthly' GROUP BY p.id, p.active ORDER BY p.active DESC, count(ms.id) DESC LIMIT 1",
        )
        .fetch_optional(&s.db)
        .await?;
        let Some(plan) = plan else { return Err(ApiError::bad("no_monthly_plan")) };
        let col = |v: &[(Uuid, NaiveDate, NaiveDate)]| -> (Vec<Uuid>, Vec<NaiveDate>, Vec<NaiveDate>) {
            (v.iter().map(|t| t.0).collect(), v.iter().map(|t| t.1).collect(), v.iter().map(|t| t.2).collect())
        };
        let (ids, starts, ends) = col(&take);
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
        // The rest of a renewal the app did not see; a member whose app dates reached that far
        // in the meantime keeps them.
        let (ids, starts, ends) = col(&extend);
        sqlx::query(
            "INSERT INTO memberships (id, member_id, plan_id, start_date, end_date, fee, discount, note, created_by) \
             SELECT gen_random_uuid(), t.member_id, $4, t.start_date, t.end_date, 0, 0, \
                    'تمدید از دستگاه انگشت؛ پولش در اکسل یا بیرون از برنامه گرفته شده', $5 \
             FROM UNNEST($1::uuid[], $2::date[], $3::date[]) AS t(member_id, start_date, end_date) \
             WHERE NOT EXISTS (SELECT 1 FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
                               WHERE ms.member_id = t.member_id AND ms.deleted_at IS NULL AND p.kind IN ('monthly', 'daily') \
                                 AND ms.end_date >= t.end_date)",
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
        save_setting(&s.db, "k50_dates_import", json!({ "at": Utc::now(), "added": take.len(), "extended": extend.len() })).await?;
        tracing::info!("k50 dates from device: {} members, {} extended", take.len(), extend.len());
        poke();
    }
    report.added.sort_by_key(|r| r.no.parse::<i64>().unwrap_or(i64::MAX));
    report.extended.sort_by_key(|r| r.no.parse::<i64>().unwrap_or(i64::MAX));
    Ok(Json(Ok(report)))
}

/// POST /api/v1/k50/compare: reads every user on the device (nothing is changed) and puts
/// each next to the app's member with the same number, so a partner can see that the IDs
/// mean the same people before the app writes anything.
#[derive(Deserialize, Default)]
pub struct CompareParams {
    /// Also read each user's let-in days (slower: one more question per user).
    #[serde(default)]
    dates: bool,
}

/// POST /api/v1/k50/compare?dates=: every user on the device next to the app's member
/// under the same number. Also the list on «کاربران دستگاه».
pub async fn compare(
    State(s): State<AppState>,
    user: CurrentUser,
    p: Option<axum::extract::Query<CompareParams>>,
) -> Result<Json<Result<Comparison, String>>, ApiError> {
    partner(&user)?;
    let dates = p.map(|q| q.dates).unwrap_or(false);
    let cfg = device_for(&s.db).await?;
    let wait = Duration::from_secs(if dates { 600 } else { 180 });
    let answer = match talk(&cfg, vec![json!({ "op": "users", "valid": dates })], wait).await {
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
    let mut tx = crate::auth::begin(&s.db).await?;
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
    // Removed members the device no longer has (taken off in ZKAccess, or never sent):
    // their numbers are free.
    let mut freed = 0;
    if !users.is_empty() {
        let gone: Vec<i32> = sqlx::query_scalar(
            "SELECT DISTINCT member_no FROM members WHERE deleted_at IS NOT NULL AND no_freed_at IS NULL AND NOT (member_no = ANY($1))",
        )
        .bind(&nos)
        .fetch_all(&s.db)
        .await?;
        for no in gone {
            forget_number(&s.db, Some(user.id), no, &device_no(&cfg, no)).await?;
            freed += 1;
        }
    }
    if resend > 0 {
        tracing::info!("k50 compare: {resend} members sent before are not on the device; sending again");
        poke();
    }
    let names: Vec<(i32, String, Uuid)> = sqlx::query_as(
        "SELECT member_no, trim(first_name || ' ' || COALESCE(last_name, '')), id FROM members WHERE deleted_at IS NULL AND member_no = ANY($1)",
    )
    .bind(&nos)
    .fetch_all(&s.db)
    .await?;
    let ids: std::collections::HashMap<i32, Uuid> = names.iter().map(|(n, _, id)| (*n, *id)).collect();
    let app: std::collections::HashMap<i32, String> = names.into_iter().map(|(n, name, _)| (n, name)).collect();
    let saved: std::collections::HashMap<String, i64> =
        sqlx::query_as::<_, (String, i64)>("SELECT no, count(*) FROM k50_fingers GROUP BY no").fetch_all(&s.db).await?.into_iter().collect();
    let confirmed = names_confirmed(&s.db).await?;
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
                Some(a) if u.name.trim().is_empty() || same_or_confirmed(&confirmed, &u.no, &u.name, a) => "same",
                Some(_) => "differs",
            };
            let valid = u.valid.as_ref().filter(|v| v["expires"].as_i64() == Some(1));
            Compared {
                no: u.no.clone(),
                device_name: u.name.trim().to_string(),
                app_name,
                admin: u.privilege > 0,
                state,
                enabled: u.enabled,
                member_id: u.no.trim().parse::<i32>().ok().and_then(|n| ids.get(&n).copied()),
                start: valid.and_then(|v| v["start"].as_str()).and_then(device_day),
                end: valid.and_then(|v| v["end"].as_str()).and_then(device_day),
                saved_fingers: saved.get(u.no.trim()).copied().unwrap_or(0),
            }
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
        freed,
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

#[derive(Deserialize)]
pub struct NameOk {
    no: String,
    device_name: String,
}

/// POST /api/v1/k50/names/ok: a partner says each of these device users (number and the
/// name as the device has it) is the app's member with that number. Compare and the date
/// import then count them as the same person.
pub async fn names_ok(State(s): State<AppState>, user: CurrentUser, Json(rows): Json<Vec<NameOk>>) -> Result<StatusCode, ApiError> {
    partner(&user)?;
    let mut nos = Vec::new();
    let mut names = Vec::new();
    for r in rows {
        let (Ok(no), name) = (r.no.trim().parse::<i32>(), r.device_name.trim().to_string()) else {
            return Err(ApiError::bad("bad_number"));
        };
        if name.is_empty() {
            return Err(ApiError::bad("bad_name"));
        }
        nos.push(no);
        names.push(name);
    }
    if nos.is_empty() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let mut tx = crate::auth::begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO k50_name_ok (member_no, device_name, confirmed_by) \
         SELECT t.no, t.name, $3 FROM UNNEST($1::int[], $2::text[]) AS t(no, name) \
         ON CONFLICT (member_no) DO UPDATE SET device_name = EXCLUDED.device_name, confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()",
    )
    .bind(&nos)
    .bind(&names)
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Freeing numbers

/// Gives up a number in the app once the device does not hold it: the removed members who
/// had it let it go, and what the app kept for it (what was sent, the saved fingers, a
/// partner's word about the name) goes, so the next person under it starts clean.
async fn forget_number(db: &PgPool, by: Option<Uuid>, no: i32, dev_no: &str) -> Result<(), sqlx::Error> {
    let mut tx = crate::auth::begin(db).await?;
    if let Some(by) = by {
        sqlx::query("SELECT set_config('app.user_id', $1, true)").bind(by.to_string()).execute(&mut *tx).await?;
    }
    sqlx::query("UPDATE members SET no_freed_at = now(), free_no = false WHERE member_no = $1 AND deleted_at IS NOT NULL AND no_freed_at IS NULL")
        .bind(no)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM k50_users k USING members m WHERE m.id = k.member_id AND k.member_no = $1 AND m.deleted_at IS NOT NULL")
        .bind(no)
        .execute(&mut *tx)
        .await?;
    sqlx::query("DELETE FROM k50_fingers WHERE no = $1 OR no = $2").bind(dev_no).bind(no.to_string()).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM k50_device_ids WHERE no = $1").bind(no).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM k50_name_ok WHERE member_no = $1").bind(no).execute(&mut *tx).await?;
    tx.commit().await?;
    tracing::info!("k50: number {no} is free");
    Ok(())
}

#[derive(Serialize)]
pub struct Freed {
    no: i32,
    ok: bool,
    error: Option<String>,
    /// The user the device had under this number (now removed from it).
    device_name: Option<String>,
}

/// Removes each number's user from the device with every finger, checks it is gone, and
/// frees the number in the app. A number a member still has is refused. With `check_names`
/// (the rounds, which no one watches) a device user whose name is not the removed
/// member's is left alone: the number is someone else's there.
async fn free_numbers(db: &PgPool, cfg: &Config, by: Option<Uuid>, nos: &[i32], check_names: bool) -> Result<Vec<Freed>, String> {
    let alive: Vec<i32> = sqlx::query_scalar("SELECT member_no FROM members WHERE deleted_at IS NULL AND member_no = ANY($1)")
        .bind(nos)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?;
    let mut out: Vec<Freed> = Vec::new();
    let mut go: Vec<i32> = Vec::new();
    for &no in nos {
        if alive.contains(&no) {
            out.push(Freed { no, ok: false, error: Some("member_alive".into()), device_name: None });
        } else if !go.contains(&no) {
            go.push(no);
        }
    }
    if check_names && !go.is_empty() {
        let looked = talk(cfg, go.iter().map(|&n| json!({ "op": "user", "no": device_no(cfg, n) })).collect(), Duration::from_secs(60)).await?;
        let names: std::collections::HashMap<i32, String> = sqlx::query_as::<_, (i32, String)>(
            "SELECT member_no, trim(first_name || ' ' || COALESCE(last_name, '')) FROM members \
             WHERE deleted_at IS NOT NULL AND no_freed_at IS NULL AND member_no = ANY($1)",
        )
        .bind(&go)
        .fetch_all(db)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
        let confirmed = names_confirmed(db).await.map_err(|e| e.to_string())?;
        let mut keep = Vec::new();
        for (no, a) in go.iter().zip(&looked) {
            let device_name = a["name"].as_str().unwrap_or("").trim().to_string();
            let app_name = names.get(no).cloned().unwrap_or_default();
            let mine = a["exists"] != json!(true)
                || device_name.is_empty()
                || same_or_confirmed(&confirmed, &device_no(cfg, *no), &device_name, &app_name);
            if mine {
                keep.push(*no);
            } else {
                out.push(Freed { no: *no, ok: false, error: Some(format!("taken:{device_name}")), device_name: Some(device_name) });
            }
        }
        go = keep;
    }
    if !go.is_empty() {
        let answers = talk(cfg, go.iter().map(|&n| json!({ "op": "delete_user", "no": device_no(cfg, n) })).collect(), Duration::from_secs(90)).await?;
        for (no, a) in go.iter().zip(&answers) {
            if a["ok"] == json!(true) {
                forget_number(db, by, *no, &device_no(cfg, *no)).await.map_err(|e| e.to_string())?;
                out.push(Freed { no: *no, ok: true, error: None, device_name: a["name"].as_str().map(|n| n.trim().to_string()) });
            } else {
                out.push(Freed { no: *no, ok: false, error: Some(answer_error(a)), device_name: None });
            }
        }
    }
    // A removed member waiting for their number to be freed shows why it was not.
    for f in out.iter().filter(|f| !f.ok) {
        sqlx::query(
            "INSERT INTO k50_users (member_id, member_no, error, error_at) \
             SELECT id, member_no, $2, now() FROM members WHERE member_no = $1 AND deleted_at IS NOT NULL AND no_freed_at IS NULL \
             ON CONFLICT (member_id) DO UPDATE SET error = EXCLUDED.error, error_at = now()",
        )
        .bind(f.no)
        .bind(format!("free:{}", f.error.as_deref().unwrap_or("failed")))
        .execute(db)
        .await
        .map_err(|e| e.to_string())?;
    }
    out.sort_by_key(|f| f.no);
    Ok(out)
}

/// The numbers of removed members asked to be freed, a few at a time; one the device
/// refused is tried again after half an hour.
async fn free_asked(db: &PgPool, cfg: &Config) -> Result<(), String> {
    let nos: Vec<i32> = sqlx::query_scalar(
        "SELECT m.member_no FROM members m LEFT JOIN k50_users k ON k.member_id = m.id \
         WHERE m.free_no AND m.deleted_at IS NOT NULL AND m.no_freed_at IS NULL \
           AND (k.error_at IS NULL OR k.error_at < now() - interval '30 minutes') \
         ORDER BY m.deleted_at LIMIT 40",
    )
    .fetch_all(db)
    .await
    .map_err(|e| e.to_string())?;
    if nos.is_empty() {
        return Ok(());
    }
    let done = free_numbers(db, cfg, None, &nos, true).await?;
    tracing::info!("k50: freed {} of {} numbers asked for", done.iter().filter(|f| f.ok).count(), done.len());
    Ok(())
}

/// Right after a member is removed with "free the number": done at once when the device is
/// set up on this computer, even while the app does not keep the device up to date by itself.
pub fn free_soon(db: PgPool) {
    tokio::spawn(async move {
        let Ok(cfg) = config(&db).await else { return };
        if cfg.ip.trim().is_empty() || now_secs() < ENROLLING_UNTIL.load(Ordering::SeqCst) {
            return;
        }
        if let Err(e) = free_asked(&db, &cfg).await {
            tracing::warn!("k50 free: {e}");
        }
    });
}

#[derive(Deserialize)]
pub struct DeviceEdit {
    no: String,
    /// The name the device had when the list was read; nothing is written if it changed since.
    #[serde(default)]
    was: String,
    name: String,
    enabled: bool,
    start: Option<NaiveDate>,
    end: Option<NaiveDate>,
}

/// POST /api/v1/k50/device-user: changes the name, the let-in days or on/off of a device
/// user the app has no member for (one added in ZKAccess). A member's own ID is changed on
/// the member's page instead, so the app and the device never tell two stories.
pub async fn edit_device_user(State(s): State<AppState>, user: CurrentUser, Json(b): Json<DeviceEdit>) -> Result<Json<DeviceAnswer>, ApiError> {
    partner(&user)?;
    let no: i32 = b.no.trim().parse().map_err(|_| ApiError::bad("bad_number"))?;
    let name = short_name(b.name.trim());
    if name.is_empty() {
        return Err(ApiError::bad("name_required"));
    }
    if b.start.is_some() != b.end.is_some() || matches!((b.start, b.end), (Some(a), Some(z)) if z < a) {
        return Err(ApiError::bad("bad_dates"));
    }
    let member: Option<bool> = sqlx::query_scalar("SELECT true FROM members WHERE member_no = $1 AND deleted_at IS NULL").bind(no).fetch_optional(&s.db).await?;
    if member.is_some() {
        return Err(ApiError(StatusCode::CONFLICT, "member_number"));
    }
    let cfg = device_for(&s.db).await?;
    let op = json!({
        "op": "set_user", "no": b.no.trim(), "existing": true, "owner": b.was.trim(), "rename": true, "name": name,
        "enabled": b.enabled, "start": b.start.map(|d| d.to_string()), "end": b.end.map(|d| d.to_string()),
    });
    let r = talk(&cfg, vec![op], Duration::from_secs(30)).await.map(|mut a| a.remove(0)).map(|a| {
        if a["absent"] == json!(true) { json!({ "ok": false, "error": "no_user" }) } else { a }
    });
    if matches!(&r, Ok(a) if a["ok"] == json!(true)) {
        sqlx::query("UPDATE k50_device_ids SET name = $2 WHERE no = $1").bind(no).bind(&name).execute(&s.db).await?;
        tracing::info!("k50: device user {} changed by {}: {name}", b.no.trim(), user.id);
    }
    Ok(DeviceAnswer::from(r))
}

#[derive(Serialize, FromRow)]
pub struct Held {
    member_id: Uuid,
    member_no: i32,
    name: String,
    deleted_at: Option<DateTime<Utc>>,
    /// Freeing was asked for (when the member was removed).
    free_no: bool,
    error: Option<String>,
}

/// GET /api/v1/k50/held: removed members whose numbers are still theirs.
pub async fn held(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Held>>, ApiError> {
    partner(&user)?;
    let rows = sqlx::query_as(
        "SELECT m.id AS member_id, m.member_no, trim(m.first_name || ' ' || COALESCE(m.last_name, '')) AS name, m.deleted_at, m.free_no, \
                CASE WHEN k.error LIKE 'free:%' THEN substr(k.error, 6) END AS error \
         FROM members m LEFT JOIN k50_users k ON k.member_id = m.id \
         WHERE m.deleted_at IS NOT NULL AND m.no_freed_at IS NULL ORDER BY m.member_no",
    )
    .fetch_all(&s.db)
    .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
pub struct Numbers {
    nos: Vec<i32>,
}

#[derive(Serialize)]
pub struct Looked {
    no: i32,
    /// On the device: whether it has the number, under which name, with how many fingers.
    on_device: bool,
    device_name: Option<String>,
    fingers: Option<i64>,
    device_admin: bool,
    /// In the app: the member who has it now, or the removed one who had it.
    member: Option<String>,
    removed_member: Option<String>,
}

/// POST /api/v1/k50/look: what the device and the app hold under these numbers (nothing
/// changes), shown before a partner frees them.
pub async fn look(State(s): State<AppState>, user: CurrentUser, Json(b): Json<Numbers>) -> Result<Json<Result<Vec<Looked>, String>>, ApiError> {
    partner(&user)?;
    if b.nos.is_empty() || b.nos.len() > 100 || b.nos.iter().any(|n| *n <= 0) {
        return Err(ApiError::bad("bad_number"));
    }
    let cfg = device_for(&s.db).await?;
    let answers = match talk(&cfg, b.nos.iter().map(|&n| json!({ "op": "user", "no": device_no(&cfg, n) })).collect(), Duration::from_secs(60)).await {
        Ok(a) => a,
        Err(e) => return Ok(Json(Err(e))),
    };
    let names: Vec<(i32, String, bool)> = sqlx::query_as(
        "SELECT member_no, trim(first_name || ' ' || COALESCE(last_name, '')), deleted_at IS NULL FROM members \
         WHERE member_no = ANY($1) AND no_freed_at IS NULL",
    )
    .bind(&b.nos)
    .fetch_all(&s.db)
    .await?;
    let rows = b
        .nos
        .iter()
        .zip(&answers)
        .map(|(&no, a)| {
            let on_device = a["exists"] == json!(true);
            Looked {
                no,
                on_device,
                device_name: on_device.then(|| a["name"].as_str().unwrap_or("").trim().to_string()),
                fingers: a["fingers"].as_i64(),
                device_admin: a["privilege"].as_i64().unwrap_or(0) > 0,
                member: names.iter().find(|(n, _, alive)| *n == no && *alive).map(|(_, name, _)| name.clone()),
                removed_member: names.iter().find(|(n, _, alive)| *n == no && !*alive).map(|(_, name, _)| name.clone()),
            }
        })
        .collect();
    Ok(Json(Ok(rows)))
}

/// POST /api/v1/k50/free: removes these numbers' users from the device, fingers and all,
/// and frees the numbers for new members. A partner has seen them with /look first.
pub async fn free(State(s): State<AppState>, user: CurrentUser, Json(b): Json<Numbers>) -> Result<Json<Result<Vec<Freed>, String>>, ApiError> {
    partner(&user)?;
    if b.nos.is_empty() || b.nos.len() > 100 || b.nos.iter().any(|n| *n <= 0) {
        return Err(ApiError::bad("bad_number"));
    }
    let cfg = device_for(&s.db).await?;
    tracing::info!("k50: {} frees numbers {:?}", user.username, b.nos);
    Ok(Json(free_numbers(&s.db, &cfg, Some(user.id), &b.nos, false).await))
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
        // Shortened at the desk (the 1405 compare).
        assert!(same_person("Moh Aquil", "محمد عقیل سلطانی"));
        assert!(same_person("Hussain", "محمد حسین احمدی"));
        assert!(same_person("Mahdi", "محمد مهدی ترکمنی"));
        assert!(same_person("Moh Javad", "محمد جواد حلیمی"));
        assert!(same_person("Zabiullah", "ذبیح الله احمدی"));
        assert!(same_person("s ezzat", "سید عزت الله حسینی 2"));
        assert!(same_person("Moh Jawid", "محمد جاوید واحدی"));
        assert!(same_person("Abdul ali", "عبدالعلی شجاعی"));
        assert!(same_person("S Baqir", "سید باقر حسینی"));
        assert!(same_person("Moh Reza", "محمد رضا سادات"));
        assert!(!same_person("Abdulrashid", "زینب جعفری"));
        assert!(!same_person("Moh", "محمد رضا سادات"));
        assert!(!same_person("S Baqir", "سید رضا حسینی"));
        assert!(!same_person("Hussain", "محمد رضا حسینی"));
    }

    #[test]
    fn a_device_that_does_not_answer_is_asked_less_often() {
        assert_eq!([1, 2, 3, 4, 5, 9].map(super::backoff), [120, 240, 480, 960, 1800, 1800]);
        assert!(super::unreachable("connect_failed (-307)") && super::unreachable("timeout") && super::unreachable("busy"));
        assert!(!super::unreachable("set_user_failed (-2)"));
    }

    #[test]
    #[ignore = "reads this computer's Wi-Fi; run by hand"]
    fn wifi_story_reads() {
        let s = super::wifi_story();
        println!("{s}");
        assert!(s.starts_with("interfaces ["));
    }

    #[test]
    #[ignore = "reads this computer's Wi-Fi; run by hand on the office network"]
    fn wifi_to_the_device() {
        println!("{:?}", super::wifi_interfaces());
        println!("{:?}", super::wifi_to("192.168.48.201".parse().unwrap()));
    }

    #[test]
    fn device_days_with_and_without_zeros() {
        let d = |y, m, day| chrono::NaiveDate::from_ymd_opt(y, m, day);
        // As the K50 gave them back for member 511053.
        assert_eq!(super::device_day("2026-11-3 0:0:0"), d(2026, 11, 3));
        assert_eq!(super::device_day("2026-12-2 23:59:59"), d(2026, 12, 2));
        assert_eq!(super::device_day("2026-10-26 16:45:50"), d(2026, 10, 26));
        assert_eq!(super::device_day("20261103"), d(2026, 11, 3));
        assert_eq!(super::device_day("1999-01-01"), None);
        assert_eq!(super::device_day(""), None);
    }

    #[test]
    fn device_clock_is_local() {
        let t = device_time("2026-10-27 08:30:00").unwrap();
        assert_eq!(t.with_timezone(&chrono::Local).format("%H:%M").to_string(), "08:30");
        assert!(device_time("bad").is_none());
    }
}
