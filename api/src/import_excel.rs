//! Bringing a year's Excel book (دیتابیس 1405) into the database: members, every payment,
//! every expense and the partners' withdrawals. Memberships are not created: the book has
//! no start dates, so the manager enters those (the database then sets the end date).
//!
//! A dry run does the whole import inside a transaction and rolls it back, and returns
//! month-by-month totals next to the book's own statement sheet (محاسبات) so a partner
//! can check them before importing for real. Importing the same year again replaces the
//! rows of the earlier run and never touches anything typed into the app.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Cursor;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::http::HeaderMap;
use axum::Json;
use calamine::{open_workbook_from_rs, Data, Range, Reader, Xlsx};
use chrono::{Days, NaiveDate};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::solar::{self, month_of, MONTHS};
use crate::AppState;

const SOURCE: &str = "excel-hall";
const MAX_WARNINGS: usize = 300;

// ---------------------------------------------------------------------------------------
// The statement lines this import knows, in the book's order.

#[derive(Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Kind {
    Income,
    Expense,
    Withdrawal,
}

struct Line {
    /// Income category code, expense category name, or partner key.
    key: &'static str,
    kind: Kind,
    /// Labels in the statement sheet (after trimming), first one is the usual spelling.
    labels: &'static [&'static str],
    /// true: the book has no detail sheet for it, so its monthly statement figure is imported.
    from_statement: bool,
}

const LINES: &[Line] = &[
    Line { key: "monthly", kind: Kind::Income, labels: &["عضویت ماهیانه", "عضویت ماهانه"], from_statement: false },
    Line { key: "daily", kind: Kind::Income, labels: &["عضویت روزانه"], from_statement: false },
    Line { key: "internet", kind: Kind::Income, labels: &["عضویت ماهیانه انترنت", "عضویت ماهانه انترنت"], from_statement: false },
    Line { key: "hotspot", kind: Kind::Income, labels: &["انترنت هاتسپات"], from_statement: true },
    Line { key: "books", kind: Kind::Income, labels: &["امانت دهی کتاب"], from_statement: true },
    Line { key: "misc", kind: Kind::Income, labels: &["عواید متفرقه (انترنت خدمات)", "عواید متفرقه"], from_statement: true },
    Line { key: "services", kind: Kind::Income, labels: &["طلبات (عواید خدمات)", "طلبات"], from_statement: true },
    Line { key: "کرایه سالن", kind: Kind::Expense, labels: &["کرایه سالن"], from_statement: true },
    Line { key: "پول صرفیه انترنت", kind: Kind::Expense, labels: &["پول صرفیه انترنت"], from_statement: true },
    Line { key: "اجوره مدیر اداری", kind: Kind::Expense, labels: &["اجوره مدیر اداری"], from_statement: false },
    Line { key: "اجوره مدیر ارتباطات", kind: Kind::Expense, labels: &["اجوره مدیر ارتباطات", "اجوره مدیر ارتباطاط"], from_statement: false },
    Line { key: "اجوره کانتیندار", kind: Kind::Expense, labels: &["اجوره کانتیندار"], from_statement: false },
    Line { key: "پول صرفیه برق", kind: Kind::Expense, labels: &["پول صرفیه برق"], from_statement: true },
    Line { key: "پول صرفیه آب", kind: Kind::Expense, labels: &["پول صرفیه آب"], from_statement: true },
    Line { key: "فاضلاب", kind: Kind::Expense, labels: &["فاضلاب"], from_statement: true },
    Line { key: "پول چوکیداری", kind: Kind::Expense, labels: &["پول چوکیداری"], from_statement: true },
    Line { key: "ماکولات", kind: Kind::Expense, labels: &["مصارفات روزانه (ماکولات)", "ماکولات"], from_statement: false },
    Line { key: "مصارف جانبی", kind: Kind::Expense, labels: &["مصارف جانبی"], from_statement: false },
    Line { key: "ترمیمات و بهسازی", kind: Kind::Expense, labels: &["ترمیمات و بهسازی"], from_statement: false },
    Line { key: "مصارفات شرکت خدمات", kind: Kind::Expense, labels: &["مصارفات شرکت خدمات"], from_statement: false },
    Line { key: "10% برای احتمالات", kind: Kind::Expense, labels: &["10% برای احتمالات"], from_statement: true },
    Line { key: "rahimi", kind: Kind::Withdrawal, labels: &["برداشت رحیمی"], from_statement: false },
    Line { key: "naseri", kind: Kind::Withdrawal, labels: &["برداشت ناصری"], from_statement: false },
];

/// Statement rows that are worked out from the others, or not money in or out.
const COMPUTED: &[&str] = &[
    "مجموع درآمد", "مجموع مصارفات", "بدهیات", "بیلانس", "موجودی", "سهمیه رحیمی", "سهمیه ناصری", "ضمانت کتاب", "Total", "نوت",
];

/// The four amount columns of each month in the daily-expenses sheet.
const DAILY_EXPENSES: [(&str, &str); 4] = [
    ("ماکولات", "تفصیلات ماکولات"),
    ("مصارف جانبی", "مصارف جانبی"),
    ("ترمیمات و بهسازی", "ترمیمات و بهسازی"),
    ("مصارفات شرکت خدمات", "خدمات"),
];

const PARTNER_NAMES: [(&str, &str); 2] = [("rahimi", "جلیل رحیمی"), ("naseri", "ذاکر ناصری")];

// ---------------------------------------------------------------------------------------
// What is read from the book.

struct Member {
    no: i32,
    name: String,
    father: Option<String>,
    phone: Option<String>,
    field: Option<String>,
    tazkira: Option<String>,
}

struct Entry {
    kind: Kind,
    /// Income category, expense category name, or partner key.
    key: &'static str,
    month: u32,
    day: Option<u32>,
    amount: f64,
    note: Option<String>,
}

#[derive(Default)]
struct Book {
    members: Vec<Member>,
    entries: Vec<Entry>,
    /// Statement figures per line key, by month.
    statement: HashMap<&'static str, [Option<f64>; 12]>,
    warnings: Vec<String>,
}

impl Book {
    fn warn(&mut self, w: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(w);
        }
    }
}

fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('ي', "ی").replace('ك', "ک")
}

fn text(d: &Data) -> Option<String> {
    let t = match d {
        Data::String(s) => clean(s),
        Data::Int(i) => i.to_string(),
        Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        _ => return None,
    };
    (!t.is_empty() && t != "-").then_some(t)
}

fn num(d: &Data) -> Option<f64> {
    match d {
        Data::Int(i) => Some(*i as f64),
        Data::Float(f) => Some(*f),
        Data::String(s) => s.trim().replace(',', "").parse().ok(),
        _ => None,
    }
}

fn cell(rg: &Range<Data>, r: usize, c: usize) -> &Data {
    rg.get((r, c)).unwrap_or(&Data::Empty)
}

/// Row number as Excel shows it, for messages.
fn excel_row(rg: &Range<Data>, r: usize) -> usize {
    rg.start().map(|(r0, _)| r0 as usize).unwrap_or(0) + r + 1
}

fn find_header(rg: &Range<Data>, first: &str) -> Option<usize> {
    (0..rg.height()).find(|&r| text(cell(rg, r, 0)).as_deref() == Some(first))
}

/// (month 1-12, column) for every month name in a header row.
fn month_cols(rg: &Range<Data>, r: usize) -> Vec<(u32, usize)> {
    (0..rg.width()).filter_map(|c| text(cell(rg, r, c)).and_then(|t| month_of(&t)).map(|m| (m, c))).collect()
}

fn col_containing(rg: &Range<Data>, r: usize, needle: &str) -> Option<usize> {
    (0..rg.width()).find(|&c| text(cell(rg, r, c)).is_some_and(|t| t.contains(needle)))
}

/// Afghan mobile numbers are often stored as 9-digit numbers without the leading 0.
fn phone(d: &Data) -> Option<String> {
    let t = text(d)?;
    let digits: String = t.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() == 9 && digits.starts_with('7') {
        Some(format!("0{digits}"))
    } else {
        Some(t)
    }
}

fn day_of(d: &Data) -> Option<u32> {
    num(d).filter(|v| v.fract() == 0.0 && (1.0..=31.0).contains(v)).map(|v| v as u32)
}

fn sheet<'a>(sheets: &'a HashMap<String, Range<Data>>, name: &str) -> Option<&'a Range<Data>> {
    sheets.get(&clean(name))
}

/// A fee cell: blank, zero and "-" are nothing; huge numbers are phone numbers typed in the wrong column.
fn fee(book: &mut Book, rg: &Range<Data>, sheet_name: &str, r: usize, m: u32, d: &Data) -> Option<f64> {
    let v = num(d).filter(|v| *v != 0.0)?;
    if v < 0.0 || v > 100_000.0 {
        book.warn(format!("{sheet_name}، ردیف {}، {}: مبلغ {v} درست به نظر نمی‌رسد و وارد نشد.", excel_row(rg, r), MONTHS[m as usize - 1]));
        return None;
    }
    if v > 1000.0 {
        book.warn(format!("{sheet_name}، ردیف {}، {}: مبلغ {v} بزرگ‌تر از معمول است؛ وارد شد، لطفاً چک کنید.", excel_row(rg, r), MONTHS[m as usize - 1]));
    }
    Some(v)
}

fn parse(bytes: &[u8]) -> Result<Book, ApiError> {
    let mut wb: Xlsx<_> = open_workbook_from_rs(Cursor::new(bytes)).map_err(|_| ApiError::bad("not_excel"))?;
    let mut sheets = HashMap::new();
    for name in wb.sheet_names() {
        if let Ok(rg) = wb.worksheet_range(&name) {
            sheets.insert(clean(&name), rg);
        }
    }
    let mut book = Book::default();
    let mut seen = HashSet::new();
    let mut duplicates = BTreeMap::new();

    // Monthly seats: one row per member, the fee paid under each month.
    let name = "عضویت ماهانه";
    let rg = sheet(&sheets, name).ok_or(ApiError::bad("sheet_missing_monthly"))?;
    let h = find_header(rg, "ID").ok_or(ApiError::bad("sheet_missing_monthly"))?;
    read_member_sheet(&mut book, rg, name, h, "monthly", &mut seen, &mut duplicates);

    // Monthly internet: the same layout, often the same people.
    let name = "انترنت";
    if let Some(rg) = sheet(&sheets, name) {
        if let Some(h) = find_header(rg, "ID") {
            read_member_sheet(&mut book, rg, name, h, "internet", &mut seen, &mut duplicates);
        }
    }
    if !duplicates.is_empty() {
        let list: Vec<String> = duplicates.keys().map(|n: &i32| n.to_string()).collect();
        book.warn(format!(
            "{} شماره عضویت دو بار آمده است (اولین ردیف به عنوان عضو ثبت شد، پول هر دو ردیف وارد شد): {}",
            list.len(),
            list.join("، ")
        ));
    }

    let name = "عضویت روزانه";
    if let Some(rg) = sheet(&sheets, name) {
        read_daily_seats(&mut book, rg, name);
    }
    let name = "مصارف روزانه";
    if let Some(rg) = sheet(&sheets, name) {
        read_daily_expenses(&mut book, rg, name);
    }
    let name = "برداشت ها";
    if let Some(rg) = sheet(&sheets, name) {
        read_withdrawals(&mut book, rg, name);
    }
    let name = "محاسبات";
    let rg = sheet(&sheets, name).ok_or(ApiError::bad("sheet_missing_statement"))?;
    read_statement(&mut book, rg, name);
    Ok(book)
}

fn read_member_sheet(
    book: &mut Book,
    rg: &Range<Data>,
    sheet_name: &str,
    h: usize,
    category: &'static str,
    seen: &mut HashSet<i32>,
    duplicates: &mut BTreeMap<i32, ()>,
) {
    let months = month_cols(rg, h);
    let c_name = col_containing(rg, h, "نام و تخلص").unwrap_or(1);
    let c_father = col_containing(rg, h, "نام پدر");
    let c_phone = col_containing(rg, h, "تماس");
    let c_field = col_containing(rg, h, "رشته");
    let c_tazkira = col_containing(rg, h, "تذکره");
    let opt = |r: usize, c: Option<usize>| c.and_then(|c| text(cell(rg, r, c)));
    let label = if category == "monthly" { "عضویت ماهانه" } else { "انترنت ماهانه" };

    for r in h + 1..rg.height() {
        let id = num(cell(rg, r, 0)).filter(|v| v.fract() == 0.0 && *v > 0.0 && *v < 2e9).map(|v| v as i32);
        let person = text(cell(rg, r, c_name));
        let filled = months.iter().filter(|(_, c)| num(cell(rg, r, *c)).is_some_and(|v| v != 0.0)).count();
        if id.is_none() && person.is_none() {
            // The table's total row ends the list; anything below it is scratch work.
            if filled >= 3 {
                let rest = (r + 1..rg.height()).filter(|&rr| months.iter().any(|(_, c)| num(cell(rg, rr, *c)).is_some())).count();
                if rest > 0 {
                    book.warn(format!("{sheet_name}: {rest} ردیف زیر ردیف جمع کل نادیده گرفته شد."));
                }
                break;
            }
            if filled > 0 {
                book.warn(format!("{sheet_name}، ردیف {}: مبلغ بدون نام و شماره وارد نشد.", excel_row(rg, r)));
            }
            continue;
        }
        if let Some(no) = id {
            if seen.insert(no) {
                book.members.push(Member {
                    no,
                    name: person.clone().unwrap_or_else(|| "بدون نام".into()),
                    father: opt(r, c_father),
                    phone: c_phone.and_then(|c| phone(cell(rg, r, c))),
                    field: opt(r, c_field),
                    tazkira: opt(r, c_tazkira),
                });
            } else if category == "monthly" {
                duplicates.insert(no, ());
            }
        } else if filled > 0 {
            book.warn(format!("{sheet_name}، ردیف {}: {} شمارهٔ عضویت ندارد؛ پولش وارد شد.", excel_row(rg, r), person.as_deref().unwrap_or("")));
        }
        for &(m, c) in &months {
            if let Some(v) = fee(book, rg, sheet_name, r, m, cell(rg, r, c)) {
                let who = match (&person, id) {
                    (Some(p), Some(no)) => format!("{p} · شمارهٔ {no}"),
                    (Some(p), None) => p.clone(),
                    (None, Some(no)) => format!("شمارهٔ {no}"),
                    (None, None) => String::new(),
                };
                book.entries.push(Entry { kind: Kind::Income, key: category, month: m, day: None, amount: v, note: Some(format!("{label} · {who}")) });
            }
        }
    }
}

/// Daily seats: each month has a day column followed by the amount.
fn read_daily_seats(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    let Some(h) = find_header(rg, "نمبر") else { return };
    let months = month_cols(rg, h);
    for r in h + 1..rg.height() {
        let person = text(cell(rg, r, 1));
        let serial = num(cell(rg, r, 0));
        let filled = months.iter().filter(|(_, c)| num(cell(rg, r, *c)).is_some_and(|v| v != 0.0)).count();
        if person.is_none() && serial.is_none() {
            if filled >= 3 {
                break;
            }
            if filled > 0 {
                book.warn(format!("{sheet_name}، ردیف {}: مبلغ بدون نام وارد نشد.", excel_row(rg, r)));
            }
            continue;
        }
        for &(m, c) in &months {
            if let Some(v) = fee(book, rg, sheet_name, r, m, cell(rg, r, c)) {
                let day = if c > 0 { day_of(cell(rg, r, c - 1)) } else { None };
                let who = person.clone().unwrap_or_else(|| "مهمان".into());
                book.entries.push(Entry { kind: Kind::Income, key: "daily", month: m, day, amount: v, note: Some(format!("عضویت روزانه · {who}")) });
            }
        }
    }
}

/// Twelve blocks side by side: day, then four (detail, amount) pairs.
fn read_daily_expenses(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    let Some(h) = find_header(rg, "روز") else { return };
    let mut block = 0u32;
    for base in 0..rg.width() {
        if text(cell(rg, h, base)).as_deref() != Some("روز") {
            continue;
        }
        block += 1;
        let month = h.checked_sub(1).and_then(|r| text(cell(rg, r, base))).and_then(|t| month_of(&t)).unwrap_or(block);
        if month > 12 {
            break;
        }
        for (k, (category, usual)) in DAILY_EXPENSES.iter().enumerate() {
            let c_detail = base + 1 + 2 * k;
            let c_amount = c_detail + 1;
            // Some months use a column for something else (e.g. "نوآوری"); keep that name in the note.
            let heading = text(cell(rg, h, c_detail)).unwrap_or_default();
            let prefix = (!heading.is_empty() && heading != *usual).then(|| heading.clone());
            for r in h + 1..rg.height() {
                let Some(day) = day_of(cell(rg, r, base)) else { continue };
                let Some(v) = num(cell(rg, r, c_amount)).filter(|v| *v != 0.0) else { continue };
                if !(0.0..=1_000_000.0).contains(&v) {
                    book.warn(format!("{sheet_name}، ردیف {}، {}: مبلغ {v} وارد نشد.", excel_row(rg, r), MONTHS[month as usize - 1]));
                    continue;
                }
                let detail = text(cell(rg, r, c_detail));
                let note = match (&prefix, detail) {
                    (Some(p), Some(d)) => Some(format!("{p}: {d}")),
                    (Some(p), None) => Some(p.clone()),
                    (None, d) => d,
                };
                book.entries.push(Entry { kind: Kind::Expense, key: category, month, day: Some(day), amount: v, note });
            }
        }
    }
}

/// One block per month, stacked: month name, people, headings, entries, and a totals row.
fn read_withdrawals(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    let mut r = 0;
    while r < rg.height() {
        let Some(month) = text(cell(rg, r, 0)).and_then(|t| month_of(&t)) else {
            r += 1;
            continue;
        };
        let people = r + 1;
        let first = r + 3;
        let mut end = first;
        while end < rg.height() && text(cell(rg, end, 0)).as_deref() != Some("لیست برداشت ها") && text(cell(rg, end, 0)).and_then(|t| month_of(&t)).is_none() {
            end += 1;
        }
        let groups: Vec<(usize, String)> = (0..rg.width()).step_by(3).filter_map(|c| text(cell(rg, people, c)).map(|n| (c, n))).collect();
        let has_amount = |row: usize| groups.iter().any(|(c, _)| num(cell(rg, row, c + 1)).is_some());
        let no_dates = |row: usize| groups.iter().all(|(c, _)| num(cell(rg, row, *c)).is_none());
        // The last row with amounts and no dates is the block's total.
        let total_row = (first..end).rev().find(|&row| has_amount(row)).filter(|&row| no_dates(row));

        for (c, person) in &groups {
            let target: Option<(Kind, &'static str)> = if person.contains("رحیمی") {
                Some((Kind::Withdrawal, "rahimi"))
            } else if person.contains("ناصری") {
                Some((Kind::Withdrawal, "naseri"))
            } else if person.contains("اداری") {
                Some((Kind::Expense, "اجوره مدیر اداری"))
            } else if person.contains("ارتباط") {
                Some((Kind::Expense, "اجوره مدیر ارتباطات"))
            } else if person.contains("شمس") || person.contains("کانتین") {
                Some((Kind::Expense, "اجوره کانتیندار"))
            } else {
                None
            };
            let Some((kind, key)) = target else {
                book.warn(format!("{sheet_name}، {}: ستون «{person}» شناخته نشد و وارد نشد.", MONTHS[month as usize - 1]));
                continue;
            };
            for row in first..end {
                if Some(row) == total_row {
                    continue;
                }
                let Some(v) = num(cell(rg, row, c + 1)).filter(|v| *v != 0.0) else { continue };
                let note = text(cell(rg, row, c + 2));
                book.entries.push(Entry { kind, key, month, day: day_of(cell(rg, row, *c)), amount: v, note });
            }
        }
        r = end;
    }
}

fn read_statement(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    let Some(h) = find_header(rg, "تفصیلات") else {
        book.warn(format!("{sheet_name}: سطر عنوان «تفصیلات» پیدا نشد."));
        return;
    };
    let months = month_cols(rg, h);
    for r in h + 1..rg.height() {
        let Some(label) = text(cell(rg, r, 0)) else { continue };
        let mut values = [None; 12];
        for &(m, c) in &months {
            values[m as usize - 1] = num(cell(rg, r, c));
        }
        let line = LINES.iter().find(|l| l.labels.iter().any(|x| clean(x) == label));
        match line {
            Some(l) => {
                book.statement.insert(l.key, values);
                if l.from_statement {
                    for (i, v) in values.iter().enumerate() {
                        if let Some(v) = v.filter(|v| *v != 0.0) {
                            let note = format!("از صورت حساب ماه {}", MONTHS[i]);
                            book.entries.push(Entry { kind: l.kind, key: l.key, month: i as u32 + 1, day: None, amount: v, note: Some(note) });
                        }
                    }
                }
            }
            None if COMPUTED.iter().any(|x| label.starts_with(x)) => {
                if label == "ضمانت کتاب" && values.iter().flatten().any(|v| *v != 0.0) {
                    book.warn("ضمانت کتاب پول امانی است، نه درآمد؛ وارد نشد. بعداً در بخش امانت کتاب ثبت می‌شود.".into());
                }
            }
            None if values.iter().flatten().any(|v| *v != 0.0) => {
                book.warn(format!("{sheet_name}: سطر «{label}» شناخته نشد و وارد نشد."));
            }
            None => {}
        }
    }
}

// ---------------------------------------------------------------------------------------
// The HTTP side.

#[derive(Deserialize)]
pub struct Params {
    year: i32,
    #[serde(default)]
    commit: bool,
    file_name: Option<String>,
}

#[derive(Serialize)]
pub struct Report {
    year: i32,
    committed: bool,
    batch_id: Option<Uuid>,
    members: usize,
    members_new: i64,
    receipts: usize,
    expenses: usize,
    withdrawals: usize,
    /// When this year was imported before; importing again replaces that run.
    replaces: Option<chrono::DateTime<chrono::Utc>>,
    lines: Vec<LineReport>,
    warnings: Vec<String>,
}

#[derive(Serialize)]
struct LineReport {
    key: &'static str,
    label: &'static str,
    kind: Kind,
    from_statement: bool,
    imported: [f64; 12],
    excel: [Option<f64>; 12],
}

/// POST /api/v1/import/excel?year=1405&commit=false with the .xlsx as the body and the
/// book's password, if it has one, URL-encoded in the X-Excel-Password header.
pub async fn import(
    State(s): State<AppState>,
    user: CurrentUser,
    Query(p): Query<Params>,
    headers: HeaderMap,
    body: Bytes,
) -> Result<Json<Report>, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    if !(1390..=1500).contains(&p.year) {
        return Err(ApiError::bad("bad_year"));
    }
    let password = headers.get("x-excel-password").and_then(|v| v.to_str().ok()).map(percent_decode).unwrap_or_default();
    let raw = body.to_vec();
    let sha = format!("{:x}", Sha256::digest(&raw));
    let book = tokio::task::spawn_blocking(move || -> Result<Book, ApiError> {
        // An .xlsx is a zip file; a password-protected one is an OLE container instead.
        let plain = if raw.starts_with(b"PK") {
            raw
        } else if password.is_empty() {
            return Err(ApiError::bad("excel_password_needed"));
        } else {
            office_crypto::decrypt_from_bytes(raw, &password).map_err(|_| ApiError::bad("wrong_excel_password"))?
        };
        parse(&plain)
    })
    .await
    .map_err(|_| ApiError::bad("not_excel"))??;

    let mut tx = begin_as(&s.db, &user).await?;
    let report = store(&mut tx, &user, &p, &sha, book).await?;
    if p.commit {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    Ok(Json(report))
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn date_of(book_year: i32, month: u32, day: Option<u32>, warnings: &mut Vec<String>) -> NaiveDate {
    let len = solar::month_len(book_year, month);
    let d = match day {
        Some(d) if d > len => {
            if warnings.len() < MAX_WARNINGS {
                warnings.push(format!("روز {d} در ماه {} وجود ندارد؛ آخر ماه ثبت شد.", MONTHS[month as usize - 1]));
            }
            len
        }
        Some(d) => d,
        None => 1,
    };
    solar::to_gregorian(book_year, month, d).expect("valid Solar date")
}

async fn store(db: &mut PgConnection, user: &CurrentUser, p: &Params, sha: &str, book: Book) -> Result<Report, ApiError> {
    let Book { members, entries, statement, mut warnings } = book;
    let year = p.year;

    // An earlier run of the same year is replaced: its rows are marked deleted.
    let replaces: Option<chrono::DateTime<chrono::Utc>> = sqlx::query_scalar(
        "SELECT max(imported_at) FROM import_batches WHERE source = $1 AND solar_year = $2 AND replaced_at IS NULL",
    )
    .bind(SOURCE)
    .bind(year)
    .fetch_one(&mut *db)
    .await?;
    for table in ["receipts", "expenses", "withdrawals"] {
        sqlx::query(&format!(
            "UPDATE {table} SET deleted_at = now() WHERE deleted_at IS NULL AND import_batch_id IN \
             (SELECT id FROM import_batches WHERE source = $1 AND solar_year = $2 AND replaced_at IS NULL)"
        ))
        .bind(SOURCE)
        .bind(year)
        .execute(&mut *db)
        .await?;
    }
    sqlx::query("UPDATE import_batches SET replaced_at = now() WHERE source = $1 AND solar_year = $2 AND replaced_at IS NULL")
        .bind(SOURCE)
        .bind(year)
        .execute(&mut *db)
        .await?;

    let batch = Uuid::new_v4();
    sqlx::query("INSERT INTO import_batches (id, source, solar_year, file_name, file_sha256, imported_by) VALUES ($1, $2, $3, $4, $5, $6)")
        .bind(batch)
        .bind(SOURCE)
        .bind(year)
        .bind(&p.file_name)
        .bind(sha)
        .bind(user.id)
        .execute(&mut *db)
        .await?;

    // Members: new numbers are added; for numbers already in the app only empty fields are filled.
    // Their join date is unknown, so they count as members from before this year.
    let before_year = solar::to_gregorian(year, 1, 1).expect("1 Hamal") - Days::new(1);
    let inserted: Vec<bool> = sqlx::query_scalar(
        r#"
        INSERT INTO members (id, member_no, first_name, father_name, phone, field_of_study, tazkira_no, joined_on, import_batch_id)
        SELECT gen_random_uuid(), m.no, m.name, m.father, m.phone, m.field, m.tazkira, $7, $8
        FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS m(no, name, father, phone, field, tazkira)
        ON CONFLICT (member_no) DO UPDATE SET
            father_name    = COALESCE(members.father_name, EXCLUDED.father_name),
            phone          = COALESCE(members.phone, EXCLUDED.phone),
            field_of_study = COALESCE(members.field_of_study, EXCLUDED.field_of_study),
            tazkira_no     = COALESCE(members.tazkira_no, EXCLUDED.tazkira_no)
        RETURNING (xmax = 0)
        "#,
    )
    .bind(members.iter().map(|m| m.no).collect::<Vec<_>>())
    .bind(members.iter().map(|m| m.name.clone()).collect::<Vec<_>>())
    .bind(members.iter().map(|m| m.father.clone()).collect::<Vec<_>>())
    .bind(members.iter().map(|m| m.phone.clone()).collect::<Vec<_>>())
    .bind(members.iter().map(|m| m.field.clone()).collect::<Vec<_>>())
    .bind(members.iter().map(|m| m.tazkira.clone()).collect::<Vec<_>>())
    .bind(before_year)
    .bind(batch)
    .fetch_all(&mut *db)
    .await?;
    let members_new = inserted.iter().filter(|x| **x).count() as i64;

    let dated: Vec<(&Entry, NaiveDate)> = entries.iter().map(|e| (e, date_of(year, e.month, e.day, &mut warnings))).collect();
    let tag = format!("اکسل {year}");
    let note = |e: &Entry| Some(match &e.note {
        Some(n) => format!("{n} ({tag})"),
        None => format!("({tag})"),
    });

    // Income: one receipt per Excel cell. Imported receipts were never printed.
    let income: Vec<_> = dated.iter().filter(|(e, _)| e.kind == Kind::Income).collect();
    let short = &batch.simple().to_string()[..6];
    sqlx::query(
        r#"
        INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category, description, import_batch_id)
        SELECT gen_random_uuid(), r.no, 'hall', r.day, r.amount, r.category, r.note, $6
        FROM unnest($1::text[], $2::date[], $3::numeric[], $4::text[], $5::text[]) AS r(no, day, amount, category, note)
        "#,
    )
    .bind(income.iter().enumerate().map(|(i, _)| format!("XL{year}-{short}-{:05}", i + 1)).collect::<Vec<_>>())
    .bind(income.iter().map(|(_, d)| *d).collect::<Vec<_>>())
    .bind(income.iter().map(|(e, _)| e.amount).collect::<Vec<f64>>())
    .bind(income.iter().map(|(e, _)| e.key.to_string()).collect::<Vec<_>>())
    .bind(income.iter().map(|(e, _)| note(e)).collect::<Vec<_>>())
    .bind(batch)
    .execute(&mut *db)
    .await?;

    // Expense categories in the statement's order.
    let mut category_ids = HashMap::new();
    for (i, l) in LINES.iter().filter(|l| l.kind == Kind::Expense).enumerate() {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO expense_categories (id, department, name, sort_order) VALUES (gen_random_uuid(), 'hall', $1, $2) \
             ON CONFLICT (department, name) DO UPDATE SET sort_order = EXCLUDED.sort_order RETURNING id",
        )
        .bind(l.key)
        .bind(i as i32 + 1)
        .fetch_one(&mut *db)
        .await?;
        category_ids.insert(l.key, id);
    }
    let spent: Vec<_> = dated.iter().filter(|(e, _)| e.kind == Kind::Expense).collect();
    sqlx::query(
        r#"
        INSERT INTO expenses (id, department, category_id, spent_on, description, amount, import_batch_id)
        SELECT gen_random_uuid(), 'hall', x.category, x.day, x.note, x.amount, $5
        FROM unnest($1::uuid[], $2::date[], $3::text[], $4::numeric[]) AS x(category, day, note, amount)
        "#,
    )
    .bind(spent.iter().map(|(e, _)| category_ids[e.key]).collect::<Vec<_>>())
    .bind(spent.iter().map(|(_, d)| *d).collect::<Vec<_>>())
    .bind(spent.iter().map(|(e, _)| note(e)).collect::<Vec<_>>())
    .bind(spent.iter().map(|(e, _)| e.amount).collect::<Vec<f64>>())
    .bind(batch)
    .execute(&mut *db)
    .await?;

    // Partners' withdrawals go to their own accounts, not into the hall's expenses.
    let mut partner_ids = HashMap::new();
    for (key, full_name) in PARTNER_NAMES {
        let surname = full_name.split(' ').last().unwrap_or(full_name);
        let existing: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM staff WHERE deleted_at IS NULL \
               AND (full_name LIKE '%' || $1 || '%' OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE a LIKE '%' || $1 || '%')) \
             ORDER BY created_at LIMIT 1",
        )
        .bind(surname)
        .fetch_optional(&mut *db)
        .await?;
        let id = match existing {
            Some(id) => id,
            None => {
                let id = Uuid::new_v4();
                sqlx::query("INSERT INTO staff (id, full_name, title, department) VALUES ($1, $2, 'شریک', NULL)")
                    .bind(id)
                    .bind(full_name)
                    .execute(&mut *db)
                    .await?;
                id
            }
        };
        partner_ids.insert(key, id);
    }
    let taken: Vec<_> = dated.iter().filter(|(e, _)| e.kind == Kind::Withdrawal).collect();
    sqlx::query(
        r#"
        INSERT INTO withdrawals (id, staff_id, department, taken_on, amount, note, import_batch_id)
        SELECT gen_random_uuid(), w.staff, 'hall', w.day, w.amount, w.note, $5
        FROM unnest($1::uuid[], $2::date[], $3::numeric[], $4::text[]) AS w(staff, day, amount, note)
        "#,
    )
    .bind(taken.iter().map(|(e, _)| partner_ids[e.key]).collect::<Vec<_>>())
    .bind(taken.iter().map(|(_, d)| *d).collect::<Vec<_>>())
    .bind(taken.iter().map(|(e, _)| e.amount).collect::<Vec<f64>>())
    .bind(taken.iter().map(|(e, _)| note(e)).collect::<Vec<_>>())
    .bind(batch)
    .execute(&mut *db)
    .await?;

    // Month-by-month totals next to the statement sheet.
    let lines: Vec<LineReport> = LINES
        .iter()
        .map(|l| {
            let mut imported = [0.0; 12];
            for e in entries.iter().filter(|e| e.kind == l.kind && e.key == l.key) {
                imported[e.month as usize - 1] += e.amount;
            }
            LineReport {
                key: l.key,
                label: l.labels[0],
                kind: l.kind,
                from_statement: l.from_statement,
                imported,
                excel: statement.get(l.key).copied().unwrap_or([None; 12]),
            }
        })
        .collect();

    let report = Report {
        year,
        committed: p.commit,
        batch_id: p.commit.then_some(batch),
        members: members.len(),
        members_new,
        receipts: income.len(),
        expenses: spent.len(),
        withdrawals: taken.len(),
        replaces,
        lines,
        warnings,
    };
    sqlx::query("UPDATE import_batches SET summary = $2 WHERE id = $1")
        .bind(batch)
        .bind(serde_json::json!({
            "members": report.members, "members_new": report.members_new, "receipts": report.receipts,
            "expenses": report.expenses, "withdrawals": report.withdrawals, "warnings": report.warnings.len(),
        }))
        .execute(&mut *db)
        .await?;
    Ok(report)
}
