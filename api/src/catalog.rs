//! The library's catalogue: every book on the shelves, by section, as in the book list
//! (لیست کتابها، sheet «ترتیب نهایی»). A book has a code (its section's number and its
//! own: 553-001), a shelf (A1), a title, an author and a number of copies. A loan lent
//! from the catalogue names the book, so the list knows how many copies are out.

use std::collections::HashMap;
use std::io::Cursor;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::Json;
use calamine::{open_workbook_from_rs, Data, Range, Reader, Xlsx};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{clean as clean_opt, hall_only};
use crate::import_excel::{cell, clean, excel_row, num, percent_decode, text};
use crate::lists::pattern;
use crate::AppState;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");
const MAX_WARNINGS: usize = 60;

// ---------------------------------------------------------------------------
// Reading the book list

#[derive(Debug, Clone, PartialEq)]
struct FileSection {
    code: String,
    name: String,
    /// What the sheet itself says the section holds (its «مجموعه کتب این بخش» row).
    excel_total: Option<i64>,
    books: Vec<FileBook>,
}

#[derive(Debug, Clone, PartialEq)]
struct FileBook {
    row: usize,
    code: String,
    shelf: Option<String>,
    title: String,
    author: Option<String>,
    copies: i32,
}

struct FileList {
    sheet: String,
    sections: Vec<FileSection>,
    excel_grand_total: Option<i64>,
    warnings: Vec<String>,
}

/// Columns of the list's header row («کد، قفسه، نام کتاب، نوسند، بخش، تعداد جلد»).
struct Cols {
    row: usize,
    code: usize,
    title: usize,
    shelf: Option<usize>,
    author: Option<usize>,
    section: Option<usize>,
    copies: Option<usize>,
}

fn header(rg: &Range<Data>) -> Option<Cols> {
    (0..rg.height().min(30)).find_map(|r| {
        let at = |needles: &[&str]| {
            (0..rg.width()).find(|&c| text(cell(rg, r, c)).is_some_and(|t| needles.iter().any(|n| t.contains(n))))
        };
        let title = at(&["نام کتاب"])?;
        let code = (0..rg.width()).find(|&c| text(cell(rg, r, c)).as_deref() == Some("کد"))?;
        Some(Cols {
            row: r,
            code,
            title,
            shelf: at(&["قفسه"]),
            author: at(&["نویسنده", "نوسند", "مولف", "مؤلف"]),
            section: at(&["بخش"]),
            copies: at(&["تعداد"]),
        })
    })
}

/// 553-001: a section's number and the book's own.
fn book_code(t: &str) -> Option<String> {
    let (a, b) = t.split_once('-')?;
    let ok = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    (ok(a) && ok(b)).then(|| format!("{a}-{b}"))
}

/// «553بخش رمان»: the section's number, then its name.
fn section_header(t: &str) -> Option<(String, String)> {
    let digits: String = t.chars().take_while(|c| c.is_ascii_digit()).collect();
    let rest = t[digits.len()..].trim();
    let name = rest.strip_prefix("بخش").unwrap_or(rest).trim();
    (rest.starts_with("بخش") && !name.is_empty()).then(|| (digits, name.to_string()))
}

fn rows_with_codes(rg: &Range<Data>, cols: &Cols) -> usize {
    (cols.row + 1..rg.height()).filter(|&r| text(cell(rg, r, cols.code)).and_then(|t| book_code(&t)).is_some()).count()
}

fn read_list(bytes: &[u8]) -> Result<FileList, ApiError> {
    let mut wb: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| ApiError::bad("not_excel"))?;
    // The book has several copies of the list; the one with the most coded books is the
    // full one (the others are older lists or split by copy, 553-006-01).
    let mut best: Option<(usize, String, Range<Data>, Cols)> = None;
    for name in wb.sheet_names() {
        let Ok(rg) = wb.worksheet_range(&name) else { continue };
        let Some(cols) = header(&rg) else { continue };
        let n = rows_with_codes(&rg, &cols);
        if n > 0 && best.as_ref().is_none_or(|(m, ..)| n > *m) {
            best = Some((n, clean(&name), rg, cols));
        }
    }
    let (_, sheet, rg, cols) = best.ok_or(ApiError::bad("no_book_list"))?;
    Ok(parse_list(sheet, &rg, &cols))
}

fn parse_list(sheet: String, rg: &Range<Data>, cols: &Cols) -> FileList {
    let mut list = FileList { sheet, sections: vec![], excel_grand_total: None, warnings: vec![] };
    let warn = |list: &mut FileList, w: String| {
        if list.warnings.len() < MAX_WARNINGS {
            list.warnings.push(w);
        }
    };
    // The labels the rows themselves carry in the «بخش» column, per section.
    let mut labels: Vec<HashMap<String, usize>> = vec![];
    // The first section's row usually comes before the header row.
    for r in 0..rg.height() {
        if r == cols.row {
            continue;
        }
        let first = text(cell(rg, r, cols.code));
        let title = text(cell(rg, r, cols.title));
        let last = cols.copies.and_then(|c| num(cell(rg, r, c)));
        if let Some(code) = first.as_deref().and_then(book_code) {
            let Some(title) = title else {
                warn(&mut list, format!("ردیف {}: کد {code} نام کتاب ندارد و وارد نشد.", excel_row(rg, r)));
                continue;
            };
            if list.sections.is_empty() {
                // A list without section rows: the number before the dash is the section.
                let prefix = code.split('-').next().unwrap_or_default().to_string();
                list.sections.push(FileSection { code: prefix.clone(), name: prefix, excel_total: None, books: vec![] });
                labels.push(HashMap::new());
            }
            let copies = match last {
                Some(v) if v.fract() == 0.0 && (1.0..=500.0).contains(&v) => v as i32,
                None => 1,
                Some(v) => {
                    warn(&mut list, format!("ردیف {}: تعداد جلد «{v}» درست نیست؛ ۱ جلد ثبت شد.", excel_row(rg, r)));
                    1
                }
            };
            let i = list.sections.len() - 1;
            if let Some(l) = cols.section.and_then(|c| text(cell(rg, r, c))) {
                *labels[i].entry(l).or_default() += 1;
            }
            let section = &mut list.sections[i];
            if section.books.iter().any(|b| b.code == code) {
                warn(&mut list, format!("ردیف {}: کد {code} در همین بخش دوبار آمده؛ بار دوم وارد نشد.", excel_row(rg, r)));
                continue;
            }
            section.books.push(FileBook {
                row: excel_row(rg, r),
                code,
                shelf: cols.shelf.and_then(|c| text(cell(rg, r, c))),
                title,
                author: cols.author.and_then(|c| text(cell(rg, r, c))),
                copies,
            });
        } else if let Some((code, name)) = first.as_deref().and_then(section_header) {
            list.sections.push(FileSection { code, name, excel_total: None, books: vec![] });
            labels.push(HashMap::new());
        } else if let (Some(t), Some(v)) = (&first, last) {
            if t.contains("عمومی") {
                list.excel_grand_total = Some(v as i64);
            } else if t.contains("مجموع") {
                if let Some(s) = list.sections.last_mut() {
                    s.excel_total = Some(v as i64);
                }
            }
        }
    }
    // A section's header may be misspelt («وانشناسی» while every row says «روانشناسی»):
    // then the rows' own word is the name.
    for (s, l) in list.sections.iter_mut().zip(labels) {
        if let Some((label, _)) = l.into_iter().max_by_key(|(_, n)| *n) {
            if label.len() > s.name.len() && label.contains(&s.name) {
                s.name = label;
            }
        }
    }
    list
}

// ---------------------------------------------------------------------------
// The catalogue

#[derive(Serialize, FromRow)]
pub struct Section {
    id: Uuid,
    code: String,
    name: String,
    titles: i64,
    copies: i64,
    /// The code a new book of this section gets unless another is typed.
    next_code: String,
}

#[derive(Serialize, FromRow)]
pub struct Book {
    id: Uuid,
    section_id: Option<Uuid>,
    section: Option<String>,
    code: Option<String>,
    shelf: Option<String>,
    title: String,
    author: Option<String>,
    copies: i32,
    /// Copies lent from the catalogue and not back yet.
    on_loan: i64,
    note: Option<String>,
}

#[derive(Serialize)]
pub struct Catalog {
    sections: Vec<Section>,
    total_titles: i64,
    total_copies: i64,
    /// The books that match the search (all of them without one).
    books: Vec<Book>,
}

#[derive(Deserialize)]
pub struct CatalogQuery {
    q: Option<String>,
    section: Option<Uuid>,
    limit: Option<i64>,
}

const SECTIONS: &str = "SELECT s.id, s.code, s.name, count(b.id) AS titles, COALESCE(sum(b.copies), 0)::bigint AS copies, \
        s.code || '-' || lpad((COALESCE(max(CASE WHEN b.code ~ '^[0-9]+-[0-9]+$' THEN split_part(b.code, '-', 2)::int END), 0) + 1)::text, 3, '0') AS next_code \
     FROM book_sections s LEFT JOIN books b ON b.section_id = s.id AND b.deleted_at IS NULL \
     WHERE s.deleted_at IS NULL GROUP BY s.id ORDER BY s.sort_order, s.name";

async fn sections_of(tx: &mut PgConnection) -> Result<Vec<Section>, ApiError> {
    Ok(sqlx::query_as(SECTIONS).fetch_all(&mut *tx).await?)
}

pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<CatalogQuery>) -> Result<Json<Catalog>, ApiError> {
    hall_only(&user)?;
    let q = pattern(&p.q);
    let mut tx = begin_as(&s.db, &user).await?;
    let sections = sections_of(&mut tx).await?;
    let (total_titles, total_copies): (i64, i64) =
        sqlx::query_as("SELECT count(*), COALESCE(sum(copies), 0)::bigint FROM books WHERE deleted_at IS NULL")
            .fetch_one(&mut *tx)
            .await?;
    let books = sqlx::query_as(
        "SELECT b.id, b.section_id, s.name AS section, b.code, b.shelf, b.title, b.author, b.copies, \
                (SELECT count(*) FROM book_loans l WHERE l.book_id = b.id AND l.returned_on IS NULL AND l.deleted_at IS NULL) AS on_loan, \
                b.note \
         FROM books b LEFT JOIN book_sections s ON s.id = b.section_id \
         WHERE b.deleted_at IS NULL AND ($2::uuid IS NULL OR b.section_id = $2) \
           AND ($1::text IS NULL OR b.title ILIKE $1 OR b.author ILIKE $1 OR b.code LIKE $1 OR b.shelf ILIKE $1) \
         ORDER BY ($1::text IS NOT NULL AND b.code = $3) DESC, s.sort_order NULLS LAST, s.name, \
                  CASE WHEN b.code ~ '^[0-9]+-[0-9]+$' THEN split_part(b.code, '-', 2)::int END NULLS LAST, b.title \
         LIMIT $4",
    )
    .bind(&q)
    .bind(p.section)
    .bind(p.q.as_deref().unwrap_or("").trim())
    .bind(p.limit.unwrap_or(5000).clamp(1, 5000))
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(Catalog { sections, total_titles, total_copies, books }))
}

#[derive(Deserialize)]
pub struct BookInput {
    section_id: Option<Uuid>,
    code: Option<String>,
    shelf: Option<String>,
    title: String,
    author: Option<String>,
    copies: i32,
    note: Option<String>,
}

struct CleanBook {
    section_id: Option<Uuid>,
    code: Option<String>,
    shelf: Option<String>,
    title: String,
    author: Option<String>,
    copies: i32,
    note: Option<String>,
}

fn checked(b: BookInput) -> Result<CleanBook, ApiError> {
    let title = clean(&b.title);
    if title.is_empty() {
        return Err(ApiError::bad("title_required"));
    }
    if !(0..=500).contains(&b.copies) {
        return Err(ApiError::bad("bad_copies"));
    }
    let code = match clean_opt(&b.code) {
        Some(c) => Some(book_code(&c).ok_or(ApiError::bad("bad_book_code"))?),
        None => None,
    };
    Ok(CleanBook {
        section_id: b.section_id,
        code,
        shelf: clean_opt(&b.shelf).map(|s| s.to_uppercase()),
        title,
        author: clean_opt(&b.author).map(|a| clean(&a)),
        copies: b.copies,
        note: clean_opt(&b.note),
    })
}

async fn code_free(tx: &mut PgConnection, b: &CleanBook, except: Option<Uuid>) -> Result<(), ApiError> {
    let Some(code) = &b.code else { return Ok(()) };
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM books WHERE deleted_at IS NULL AND section_id IS NOT DISTINCT FROM $1 \
                        AND code = $2 AND id IS DISTINCT FROM $3)",
    )
    .bind(b.section_id)
    .bind(code)
    .bind(except)
    .fetch_one(&mut *tx)
    .await?;
    if taken { Err(ApiError(StatusCode::CONFLICT, "book_code_taken")) } else { Ok(()) }
}

pub async fn create_book(State(s): State<AppState>, user: CurrentUser, Json(b): Json<BookInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let b = checked(b)?;
    let mut tx = begin_as(&s.db, &user).await?;
    code_free(&mut tx, &b, None).await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO books (id, section_id, code, shelf, title, author, copies, note) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(id)
    .bind(b.section_id)
    .bind(&b.code)
    .bind(&b.shelf)
    .bind(&b.title)
    .bind(&b.author)
    .bind(b.copies)
    .bind(&b.note)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

pub async fn update_book(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<BookInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let b = checked(b)?;
    let mut tx = begin_as(&s.db, &user).await?;
    code_free(&mut tx, &b, Some(id)).await?;
    let done = sqlx::query(
        "UPDATE books SET section_id = $2, code = $3, shelf = $4, title = $5, author = $6, copies = $7, note = $8 \
         WHERE id = $1 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(b.section_id)
    .bind(&b.code)
    .bind(&b.shelf)
    .bind(&b.title)
    .bind(&b.author)
    .bind(b.copies)
    .bind(&b.note)
    .execute(&mut *tx)
    .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// A book that left the library (or was typed twice). Partners only; loans keep its title.
pub async fn delete_book(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let out: Option<i64> = sqlx::query_scalar(
        "SELECT (SELECT count(*) FROM book_loans l WHERE l.book_id = b.id AND l.returned_on IS NULL AND l.deleted_at IS NULL) \
         FROM books b WHERE b.id = $1 AND b.deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    if out.ok_or(NOT_FOUND)? > 0 {
        return Err(ApiError(StatusCode::CONFLICT, "book_on_loan"));
    }
    sqlx::query("UPDATE books SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct SectionInput {
    code: String,
    name: String,
}

fn checked_section(s: SectionInput) -> Result<(String, String), ApiError> {
    let code = s.code.trim().to_string();
    let name = clean(&s.name);
    if name.is_empty() {
        return Err(ApiError::bad("section_name_required"));
    }
    if code.is_empty() || !code.chars().all(|c| c.is_ascii_digit()) {
        return Err(ApiError::bad("bad_section_code"));
    }
    Ok((code, name))
}

async fn name_free(tx: &mut PgConnection, name: &str, except: Option<Uuid>) -> Result<(), ApiError> {
    let taken: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM book_sections WHERE deleted_at IS NULL AND lower(name) = lower($1) AND id IS DISTINCT FROM $2)",
    )
    .bind(name)
    .bind(except)
    .fetch_one(&mut *tx)
    .await?;
    if taken { Err(ApiError(StatusCode::CONFLICT, "section_exists")) } else { Ok(()) }
}

pub async fn create_section(State(s): State<AppState>, user: CurrentUser, Json(i): Json<SectionInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let (code, name) = checked_section(i)?;
    let mut tx = begin_as(&s.db, &user).await?;
    name_free(&mut tx, &name, None).await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO book_sections (id, code, name, sort_order) \
         VALUES ($1, $2, $3, (SELECT COALESCE(max(sort_order), 0) + 1 FROM book_sections))",
    )
    .bind(id)
    .bind(&code)
    .bind(&name)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

pub async fn update_section(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(i): Json<SectionInput>,
) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let (code, name) = checked_section(i)?;
    let mut tx = begin_as(&s.db, &user).await?;
    name_free(&mut tx, &name, Some(id)).await?;
    let done = sqlx::query("UPDATE book_sections SET code = $2, name = $3 WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .bind(&code)
        .bind(&name)
        .execute(&mut *tx)
        .await?;
    if done.rows_affected() == 0 {
        return Err(NOT_FOUND);
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Importing the book list

#[derive(Deserialize)]
pub struct ImportParams {
    #[serde(default)]
    commit: bool,
}

#[derive(Serialize)]
pub struct SectionReport {
    code: String,
    name: String,
    titles: usize,
    copies: i64,
    excel_total: Option<i64>,
    added: usize,
    changed: usize,
}

#[derive(Serialize)]
pub struct ImportReport {
    sheet: String,
    sections: Vec<SectionReport>,
    titles: usize,
    copies: i64,
    excel_grand_total: Option<i64>,
    added: usize,
    changed: usize,
    unchanged: usize,
    /// Books in the catalogue that the file does not have; they are kept.
    not_in_file: i64,
    /// Earlier loans whose typed title is now a catalogue book.
    loans_linked: u64,
    /// Codes that now name another title (the list was renumbered).
    retitled: Vec<String>,
    warnings: Vec<String>,
}

/// POST /api/v1/catalog/import?commit=false with the .xlsx as the body (and its password,
/// if it has one, URL-encoded in X-Excel-Password). Books are matched by section and code,
/// so importing a newer list again updates the books instead of adding them twice.
pub async fn import(
    State(s): State<AppState>,
    user: CurrentUser,
    Query(p): Query<ImportParams>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<ImportReport>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let password = headers.get("x-excel-password").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let raw = body.to_vec();
    let list = tokio::task::spawn_blocking(move || -> Result<FileList, ApiError> {
        let plain = if raw.starts_with(b"PK") {
            raw
        } else if password.is_empty() {
            return Err(ApiError::bad("excel_password_needed"));
        } else {
            office_crypto::decrypt_from_bytes(raw, &password).map_err(|_| ApiError::bad("wrong_excel_password"))?
        };
        read_list(&plain)
    })
    .await
    .map_err(|_| ApiError::bad("not_excel"))??;

    let mut tx = begin_as(&s.db, &user).await?;
    let report = store(&mut tx, list).await?;
    if p.commit {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(Json(report))
}

#[derive(FromRow)]
struct Existing {
    id: Uuid,
    shelf: Option<String>,
    title: String,
    author: Option<String>,
    copies: i32,
}

async fn store(tx: &mut PgConnection, mut list: FileList) -> Result<ImportReport, ApiError> {
    let mut report = ImportReport {
        sheet: list.sheet.clone(),
        sections: vec![],
        titles: 0,
        copies: 0,
        excel_grand_total: list.excel_grand_total,
        added: 0,
        changed: 0,
        unchanged: 0,
        not_in_file: 0,
        loans_linked: 0,
        retitled: vec![],
        warnings: vec![],
    };
    let mut seen: Vec<Uuid> = vec![];
    let mut codes: HashMap<String, Vec<String>> = HashMap::new();
    for (order, sec) in list.sections.iter().enumerate() {
        codes.entry(sec.code.clone()).or_default().push(sec.name.clone());
        let found: Option<Uuid> =
            sqlx::query_scalar("SELECT id FROM book_sections WHERE deleted_at IS NULL AND lower(name) = lower($1)")
                .bind(&sec.name)
                .fetch_optional(&mut *tx)
                .await?;
        let section_id = match found {
            Some(id) => {
                sqlx::query("UPDATE book_sections SET code = $2, sort_order = $3 WHERE id = $1 AND (code, sort_order) IS DISTINCT FROM ($2, $3)")
                    .bind(id)
                    .bind(&sec.code)
                    .bind(order as i32 + 1)
                    .execute(&mut *tx)
                    .await?;
                id
            }
            None => {
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO book_sections (id, code, name, sort_order) VALUES ($1, $2, $3, $4)")
                    .bind(id)
                    .bind(&sec.code)
                    .bind(&sec.name)
                    .bind(order as i32 + 1)
                    .execute(&mut *tx)
                    .await?;
                id
            }
        };
        let mut sr = SectionReport {
            code: sec.code.clone(),
            name: sec.name.clone(),
            titles: sec.books.len(),
            copies: sec.books.iter().map(|b| b.copies as i64).sum(),
            excel_total: sec.excel_total,
            added: 0,
            changed: 0,
        };
        for b in &sec.books {
            let old: Option<Existing> = sqlx::query_as(
                "SELECT id, shelf, title, author, copies FROM books WHERE deleted_at IS NULL AND section_id = $1 AND code = $2",
            )
            .bind(section_id)
            .bind(&b.code)
            .fetch_optional(&mut *tx)
            .await?;
            match old {
                Some(o) => {
                    seen.push(o.id);
                    if (o.shelf.as_ref(), &o.title, o.author.as_ref(), o.copies) == (b.shelf.as_ref(), &b.title, b.author.as_ref(), b.copies) {
                        report.unchanged += 1;
                        continue;
                    }
                    if o.title != b.title {
                        report.retitled.push(format!("{} {}: «{}» ← «{}»", sec.name, b.code, b.title, o.title));
                    }
                    sqlx::query("UPDATE books SET shelf = $2, title = $3, author = $4, copies = $5 WHERE id = $1")
                        .bind(o.id)
                        .bind(&b.shelf)
                        .bind(&b.title)
                        .bind(&b.author)
                        .bind(b.copies)
                        .execute(&mut *tx)
                        .await?;
                    sr.changed += 1;
                }
                None => {
                    let id = Uuid::new_v4();
                    seen.push(id);
                    sqlx::query(
                        "INSERT INTO books (id, section_id, code, shelf, title, author, copies) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                    )
                    .bind(id)
                    .bind(section_id)
                    .bind(&b.code)
                    .bind(&b.shelf)
                    .bind(&b.title)
                    .bind(&b.author)
                    .bind(b.copies)
                    .execute(&mut *tx)
                    .await?;
                    sr.added += 1;
                }
            }
        }
        report.titles += sr.titles;
        report.copies += sr.copies;
        report.added += sr.added;
        report.changed += sr.changed;
        if let Some(t) = sec.excel_total.filter(|t| *t != sr.copies) {
            report.warnings.push(format!(
                "بخش {} ({}): جمع خود اکسل {t} جلد است ولی ردیف‌هایش {} جلد می‌شوند؛ فرمول جمع آن بخش را چک کنید.",
                sec.name, sec.code, sr.copies
            ));
        }
        let no_author = sec.books.iter().filter(|b| b.author.is_none()).count();
        if no_author > 0 {
            report.warnings.push(format!("بخش {}: {no_author} کتاب نام نویسنده ندارد.", sec.name));
        }
        report.sections.push(sr);
    }
    if let Some(t) = list.excel_grand_total.filter(|t| *t != report.copies) {
        report.warnings.push(format!("جمع عمومی اکسل {t} جلد است ولی همهٔ ردیف‌ها {} جلد می‌شوند.", report.copies));
    }
    let mut shared: Vec<_> = codes.into_iter().filter(|(_, names)| names.len() > 1).collect();
    shared.sort();
    for (code, names) in shared {
        report.warnings.push(format!(
            "شمارهٔ {code} برای چند بخش آمده ({})؛ برنامه آن‌ها را از هم جدا نگه می‌دارد، ولی روی برچسب کتاب‌ها یکی دیده می‌شوند.",
            names.join("، ")
        ));
    }
    if !report.retitled.is_empty() {
        report.warnings.push(format!(
            "{} کد حالا نام کتاب دیگری دارد (فهرست دوباره شماره‌گذاری شده)؛ اگر برچسب کتاب‌ها هنوز شمارهٔ قبلی را دارند، برچسب‌ها را تازه کنید.",
            report.retitled.len()
        ));
    }
    report.warnings.append(&mut list.warnings);
    report.not_in_file = sqlx::query_scalar("SELECT count(*) FROM books WHERE deleted_at IS NULL AND NOT (id = ANY($1))")
        .bind(&seen)
        .fetch_one(&mut *tx)
        .await?;
    // Loans typed before the catalogue existed: link those whose title is exactly one book's.
    report.loans_linked = sqlx::query(
        "WITH one AS (SELECT lower(title) AS t, (array_agg(id))[1] AS id FROM books WHERE deleted_at IS NULL \
                      GROUP BY lower(title) HAVING count(*) = 1) \
         UPDATE book_loans l SET book_id = one.id FROM one \
         WHERE l.book_id IS NULL AND l.deleted_at IS NULL AND lower(trim(l.book_title)) = one.t",
    )
    .execute(&mut *tx)
    .await?
    .rows_affected();
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_and_headers() {
        assert_eq!(book_code("553-001").as_deref(), Some("553-001"));
        assert_eq!(book_code("000-12").as_deref(), Some("000-12"));
        assert_eq!(book_code("553-006-01"), None);
        assert_eq!(book_code("کد"), None);
        assert_eq!(section_header("553بخش رمان"), Some(("553".into(), "رمان".into())));
        assert_eq!(section_header("000بخش اطلاعات عمومی"), Some(("000".into(), "اطلاعات عمومی".into())));
        assert_eq!(section_header("مجموعه کتب این بخش"), None);
    }

    fn sheet(rows: &[&[Data]]) -> Range<Data> {
        let w = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        let mut rg = Range::new((0, 0), (rows.len() as u32 - 1, w as u32 - 1));
        for (r, row) in rows.iter().enumerate() {
            for (c, v) in row.iter().enumerate() {
                rg.set_value((r as u32, c as u32), v.clone());
            }
        }
        rg
    }

    #[test]
    fn reads_sections_and_totals() {
        let s = |t: &str| Data::String(t.into());
        let e = Data::Empty;
        let rg = sheet(&[
            &[s("لیست کتاب های کتابخانه")],
            &[s("150بخش وانشناسی"), e.clone(), e.clone(), e.clone(), e.clone(), e.clone()],
            &[s("کد"), s("قفسه "), s("نام کتاب"), s("نوسند"), s("بخش"), s("تعداد جلد")],
            &[s("150-001"), s("B5"), s("روانشناسی رشد"), s("برک"), s("روانشناسی"), Data::Int(2)],
            &[s("150-002"), s("B5"), s("ذهن"), e.clone(), s("روانشناسی"), Data::Float(1.0)],
            &[s("مجموعه کتب این بخش"), e.clone(), e.clone(), e.clone(), e.clone(), Data::Int(3)],
            &[s("398بخش کودک "), e.clone(), e.clone(), e.clone(), e.clone(), e.clone()],
            &[s("398-001"), s("G1"), s("قصه"), s("کسی"), s("کودک"), Data::Int(1)],
            &[s("398-001"), s("G1"), s("دوباره"), s("کسی"), s("کودک"), Data::Int(1)],
            &[s("مجموعه عمومی کتب "), e.clone(), e.clone(), e.clone(), e.clone(), Data::Int(9)],
        ]);
        let cols = header(&rg).unwrap();
        let list = parse_list("ترتیب نهایی".into(), &rg, &cols);
        assert_eq!(list.sections.len(), 2);
        assert_eq!(list.sections[0].name, "روانشناسی");
        assert_eq!(list.sections[0].excel_total, Some(3));
        assert_eq!(list.sections[0].books[1].author, None);
        assert_eq!(list.sections[1].code, "398");
        assert_eq!(list.sections[1].books.len(), 1);
        assert_eq!(list.excel_grand_total, Some(9));
        assert_eq!(list.warnings.len(), 1);
    }
}
