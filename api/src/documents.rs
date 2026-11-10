//! A member's photo (printed on the membership card) and tazkira scans. The files are kept
//! in `%APPDATA%\Pezhohesh\files`, named by their SHA-256: a file is never stored twice,
//! never changed, and a backup copies only the files it does not have yet.

use std::path::{Path as FsPath, PathBuf};

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::hall_only;
use crate::AppState;

/// Largest file the desk may add (a phone photo of a tazkira is about 3 MB).
pub const MAX_BYTES: usize = 10 * 1024 * 1024;
/// The small copy of a photo that goes to the server (the app makes it about 20 KB).
const MAX_THUMB_BYTES: usize = 96 * 1024;
const KINDS: [&str; 4] = ["photo", "tazkira_front", "tazkira_back", "other"];
const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

pub fn files_dir() -> PathBuf {
    std::env::var("APPDATA")
        .map(|d| FsPath::new(&d).join("Pezhohesh").join("files"))
        .unwrap_or_else(|_| PathBuf::from("files"))
}

#[derive(Serialize, FromRow)]
pub struct Document {
    id: Uuid,
    kind: String,
    mime_type: String,
    size_bytes: i32,
    created_at: chrono::DateTime<chrono::Utc>,
    /// Its name on the file server (`<sha256>.<ext>`): the app reads it from there when the
    /// file is not on this computer.
    remote_name: String,
}

/// A member's current files, photo first.
pub async fn of_member(tx: &mut PgConnection, member: Uuid) -> Result<Vec<Document>, sqlx::Error> {
    sqlx::query_as(
        "SELECT id, kind::text AS kind, mime_type, size_bytes, created_at, regexp_replace(file_path, '^.*/', '') AS remote_name FROM member_documents \
         WHERE member_id = $1 AND deleted_at IS NULL ORDER BY member_documents.kind, created_at",
    )
    .bind(member)
    .fetch_all(tx)
    .await
}

/// The file type from its first bytes, not from what the sender says it is.
fn sniff(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image/jpeg", "jpg"))
    } else if b.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(("image/png", "png"))
    } else if b.len() > 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("image/webp", "webp"))
    } else if b.starts_with(b"%PDF-") {
        Some(("application/pdf", "pdf"))
    } else {
        None
    }
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Where a file lives, relative to the files folder: `ab/abcdef….jpg`.
fn relative(sha: &str, ext: &str) -> String {
    format!("{}/{sha}.{ext}", &sha[..2])
}

async fn store(rel: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = files_dir().join(rel);
    if tokio::fs::try_exists(&target).await.unwrap_or(false) {
        return Ok(());
    }
    if let Some(dir) = target.parent() {
        tokio::fs::create_dir_all(dir).await?;
    }
    // Its own .partial name, so two desks adding the same photo at once do not collide.
    let partial = target.with_extension(format!("{}.partial", Uuid::new_v4().simple()));
    let done = match tokio::fs::write(&partial, bytes).await {
        Ok(()) => tokio::fs::rename(&partial, &target).await,
        Err(e) => Err(e),
    };
    if done.is_err() {
        let _ = tokio::fs::remove_file(&partial).await;
    }
    done
}

#[derive(Serialize)]
pub struct Added {
    id: Uuid,
}

/// A file checked and stored in the files folder, not yet on anyone's record.
pub struct Stored {
    pub rel: String,
    pub sha: String,
    pub mime: &'static str,
    pub size: i32,
}

pub fn kind_ok(kind: &str) -> bool {
    KINDS.contains(&kind)
}

/// Checks a file (its real type from its bytes, its size) and keeps it in the files folder.
pub async fn store_upload(kind: &str, body: &[u8]) -> Result<Stored, ApiError> {
    if !kind_ok(kind) {
        return Err(ApiError::bad("bad_kind"));
    }
    if body.is_empty() || body.len() > MAX_BYTES {
        return Err(ApiError::bad("file_too_large"));
    }
    let (mime, ext) = sniff(body).ok_or(ApiError::bad("bad_file_type"))?;
    if kind == "photo" && mime == "application/pdf" {
        return Err(ApiError::bad("bad_file_type"));
    }
    let sha = hex(&Sha256::digest(body));
    let rel = relative(&sha, ext);
    store(&rel, body).await.map_err(|e| {
        tracing::error!("saving {rel} failed: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "file_not_saved")
    })?;
    Ok(Stored { rel, sha, mime, size: body.len() as i32 })
}

/// Puts a stored file on a member's record. A new photo or tazkira side takes the place of the old one.
pub async fn attach(tx: &mut PgConnection, member: Uuid, kind: &str, f: &Stored, by: Uuid) -> Result<Uuid, ApiError> {
    let known: Option<Uuid> = sqlx::query_scalar("SELECT id FROM members WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
        .bind(member)
        .fetch_optional(&mut *tx)
        .await?;
    known.ok_or(NOT_FOUND)?;
    if kind != "other" {
        sqlx::query("UPDATE member_documents SET deleted_at = now() WHERE member_id = $1 AND kind = $2::doc_kind AND deleted_at IS NULL")
            .bind(member)
            .bind(kind)
            .execute(&mut *tx)
            .await?;
    }
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO member_documents (id, member_id, kind, file_path, sha256, mime_type, size_bytes, created_by) \
         VALUES ($1, $2, $3::doc_kind, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(member)
    .bind(kind)
    .bind(&f.rel)
    .bind(&f.sha)
    .bind(f.mime)
    .bind(f.size)
    .bind(by)
    .execute(&mut *tx)
    .await?;
    Ok(id)
}

/// POST /api/v1/members/:id/documents/:kind with the file as the body.
pub async fn add(
    State(s): State<AppState>,
    user: CurrentUser,
    Path((member, kind)): Path<(Uuid, String)>,
    body: Bytes,
) -> Result<(StatusCode, Json<Added>), ApiError> {
    hall_only(&user)?;
    let f = store_upload(&kind, &body).await?;
    let mut tx = begin_as(&s.db, &user).await?;
    let id = attach(&mut tx, member, &kind, &f, user.id).await?;
    tx.commit().await?;
    Ok((StatusCode::CREATED, Json(Added { id })))
}

/// The bytes and type of a stored file.
pub async fn read_file(rel: &str) -> Result<Vec<u8>, ApiError> {
    tokio::fs::read(files_dir().join(rel)).await.map_err(|e| {
        tracing::error!("reading {rel} failed: {e}");
        ApiError(StatusCode::NOT_FOUND, "file_missing")
    })
}

/// GET /api/v1/documents/:id: the file itself.
pub async fn file(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<Response, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(String, String, Option<Vec<u8>>, Option<String>)> =
        sqlx::query_as(
            "SELECT d.file_path, d.mime_type, d.thumb, d.thumb_mime FROM member_documents d JOIN members m ON m.id = d.member_id \
             WHERE d.id = $1 AND d.deleted_at IS NULL AND m.deleted_at IS NULL",
        )
            .bind(id)
            .fetch_optional(&mut *tx)
            .await?;
    tx.commit().await?;
    let (rel, mime, thumb, thumb_mime) = row.ok_or(NOT_FOUND)?;
    // A computer working on the server has no files: the photo's small copy stands in.
    let (bytes, mime) = match (tokio::fs::read(files_dir().join(&rel)).await, thumb, thumb_mime) {
        (Ok(b), _, _) => (b, mime),
        (Err(_), Some(t), Some(m)) => (t, m),
        (Err(e), _, _) => {
            if crate::sync::online_device().is_none() {
                tracing::error!("reading {rel} failed: {e}");
            }
            // The app then fetches it from the file server by this name.
            let name = rel.rsplit('/').next().unwrap_or(&rel).to_string();
            let mut res = (StatusCode::NOT_FOUND, Json(serde_json::json!({ "error": "file_missing", "name": name }))).into_response();
            res.extensions_mut().insert(crate::auth::ErrorCode("file_missing"));
            return Ok(res);
        }
    };
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, mime.parse().map_err(|_| NOT_FOUND)?);
    // A document id always means the same bytes.
    headers.insert(header::CACHE_CONTROL, "private, max-age=31536000, immutable".parse().map_err(|_| NOT_FOUND)?);
    Ok((headers, bytes).into_response())
}

// ---------------------------------------------------------------------------
// The file server: photos and scans live apart from the database (Supabase Storage, behind
// a small gateway that wants the key). The app's window does the sending and the fetching;
// the API says what is still to send, notes what was sent, and keeps a copy fetched here.

#[derive(Serialize, Deserialize, Default)]
pub struct FilesStore {
    url: String,
    key: String,
}

/// GET /api/v1/files-store: where the file server is, and its key (the app talks to it).
pub async fn files_store(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Option<FilesStore>>, ApiError> {
    hall_only(&user)?;
    let v: Option<serde_json::Value> = sqlx::query_scalar("SELECT value FROM settings WHERE key = 'files_store'").fetch_optional(&s.db).await?;
    Ok(Json(v.and_then(|v| serde_json::from_value(v).ok())))
}

/// PUT /api/v1/files-store (partners): set once; it reaches every computer with the settings.
pub async fn set_files_store(State(s): State<AppState>, user: CurrentUser, Json(b): Json<FilesStore>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let url = b.url.trim().trim_end_matches('/').to_string();
    let key = b.key.trim().to_string();
    if !url.starts_with("https://") || key.len() < 32 {
        return Err(ApiError::bad("bad_files_store"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('files_store', $1) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::json!({ "url": url, "key": key }))
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Serialize)]
pub struct Unsent {
    id: Uuid,
    name: String,
}

/// GET /api/v1/documents/unsent: files on this computer not on the file server yet.
pub async fn unsent(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Unsent>>, ApiError> {
    hall_only(&user)?;
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, file_path FROM member_documents WHERE remote_at IS NULL AND deleted_at IS NULL ORDER BY created_at LIMIT 500",
    )
    .fetch_all(&s.db)
    .await?;
    let dir = files_dir();
    Ok(Json(
        rows.into_iter()
            .filter(|(_, rel)| dir.join(rel).is_file())
            .map(|(id, rel)| Unsent { id, name: rel.rsplit('/').next().unwrap_or(&rel).to_string() })
            .take(20)
            .collect(),
    ))
}

/// POST /api/v1/documents/:id/sent: the file server has it.
pub async fn sent(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query("UPDATE member_documents SET remote_at = now() WHERE id = $1 AND remote_at IS NULL").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /api/v1/documents/:id/copy: a file the app fetched from the file server, kept on this
/// computer too, when its bytes are the ones the record names.
pub async fn keep_copy(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, body: Bytes) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let row: Option<(String, String)> = sqlx::query_as("SELECT file_path, sha256 FROM member_documents WHERE id = $1").bind(id).fetch_optional(&s.db).await?;
    let (rel, sha) = row.ok_or(NOT_FOUND)?;
    if hex(&Sha256::digest(&body)) != sha {
        return Err(ApiError::bad("hash_mismatch"));
    }
    store(&rel, &body).await.map_err(|e| {
        tracing::error!("keeping {rel} failed: {e}");
        ApiError(StatusCode::INTERNAL_SERVER_ERROR, "file_not_saved")
    })?;
    Ok(StatusCode::NO_CONTENT)
}

/// PUT /api/v1/documents/:id/thumb: the small copy of a photo (the app shrinks it), which
/// goes to the server with the rest of the data.
pub async fn set_thumb(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>, body: Bytes) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    if body.is_empty() || body.len() > MAX_THUMB_BYTES {
        return Err(ApiError::bad("file_too_large"));
    }
    let mime = match sniff(&body) {
        Some((m, _)) if m != "application/pdf" => m,
        _ => return Err(ApiError::bad("bad_file_type")),
    };
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query("UPDATE member_documents SET thumb = $2, thumb_mime = $3 WHERE id = $1 AND kind = 'photo' AND deleted_at IS NULL")
        .bind(id)
        .bind(body.as_ref())
        .bind(mime)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/v1/documents/thumbless: current photos with no small copy yet whose file is on
/// this computer, a few at a time, for the app to make the copies.
pub async fn thumbless(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Vec<Uuid>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT d.id, d.file_path FROM member_documents d JOIN members m ON m.id = d.member_id \
         WHERE d.kind = 'photo' AND d.thumb IS NULL AND d.deleted_at IS NULL AND m.deleted_at IS NULL \
         ORDER BY d.created_at DESC LIMIT 200",
    )
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    let dir = files_dir();
    Ok(Json(rows.into_iter().filter(|(_, rel)| dir.join(rel).is_file()).map(|(id, _)| id).take(20).collect()))
}

/// DELETE /api/v1/documents/:id. The row stays (soft-deleted) in the audit log.
pub async fn remove(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let done = sqlx::query(
        "UPDATE member_documents d SET deleted_at = now() FROM members m \
         WHERE d.id = $1 AND d.deleted_at IS NULL AND m.id = d.member_id AND m.deleted_at IS NULL",
    )
        .bind(id)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// Copies into `to` every file it does not have yet (files never change, so a name that
/// is there is the same file). One file that fails does not stop the others; the first
/// error is returned after all were tried.
pub fn mirror(from: &FsPath, to: &FsPath) -> std::io::Result<usize> {
    let mut copied = 0;
    let mut first_error = None;
    let Ok(dirs) = std::fs::read_dir(from) else { return Ok(0) };
    for dir in dirs.flatten().filter(|d| d.path().is_dir()) {
        let target_dir = to.join(dir.file_name());
        let files = match std::fs::read_dir(dir.path()) {
            Ok(f) => f,
            Err(e) => {
                first_error.get_or_insert(e);
                continue;
            }
        };
        for f in files.flatten() {
            let name = f.file_name();
            if name.to_string_lossy().ends_with(".partial") {
                continue;
            }
            let target = target_dir.join(&name);
            if target.exists() {
                continue;
            }
            let partial = target.with_extension("partial");
            let done = std::fs::create_dir_all(&target_dir)
                .and_then(|_| std::fs::copy(f.path(), &partial))
                .and_then(|_| std::fs::rename(&partial, &target));
            match done {
                Ok(()) => copied += 1,
                Err(e) => {
                    let _ = std::fs::remove_file(&partial);
                    first_error.get_or_insert(e);
                }
            }
        }
    }
    first_error.map_or(Ok(copied), Err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn types() {
        assert_eq!(sniff(&[0xFF, 0xD8, 0xFF, 0xE0]).unwrap().0, "image/jpeg");
        assert_eq!(sniff(b"%PDF-1.7").unwrap().1, "pdf");
        assert!(sniff(b"MZ\x90\x00").is_none());
        assert_eq!(relative("abcdef", "jpg"), "ab/abcdef.jpg");
    }
}
