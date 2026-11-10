//! Bringing a year's Excel book (دیتابیس 1405) into the database: members, every payment,
//! every expense and the partners' withdrawals. Memberships are not created: the book has
//! no start dates, so the manager enters those (the database then sets the end date).
//!
//! A dry run does the whole import inside a transaction and rolls it back, and returns
//! month-by-month totals next to the book's own statement sheet (محاسبات) so a partner
//! can check them before importing for real. Importing the same year again replaces the
//! rows of the earlier run and never touches anything typed into the app.

use std::collections::{BTreeMap, HashMap};
use std::io::Cursor;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
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

/// One person of the member sheets: a number and a name. The same number with another
/// name is another person (two people were given one ID), never merged into the first.
struct Member {
    no: i32,
    /// None: the row has a number but no name.
    name: Option<String>,
    father: Option<String>,
    phone: Option<String>,
    field: Option<String>,
    tazkira: Option<String>,
    /// Where the person is in the book: (sheet, row as Excel shows it).
    rows: Vec<(&'static str, usize)>,
}

struct Entry {
    kind: Kind,
    /// Income category, expense category name, or partner key.
    key: &'static str,
    month: u32,
    day: Option<u32>,
    amount: f64,
    note: Option<String>,
    /// The member row it was paid on (an index into `Book::members`).
    person: Option<usize>,
}

/// A supplier bill in the hotspot sheet, or a month's one summary row (Hamal to Asad).
struct HotBuy {
    month: u32,
    on: Option<NaiveDate>,
    bill_no: Option<String>,
    bill_gb: Option<f64>,
    extra_cost: f64,
    /// The sheet's purchase amount (cards' GB times the price per GB, plus extra costs).
    total: f64,
    cards: Vec<(f64, i32)>,
}

/// One day's count of cards sold, or a month's summary row.
struct HotSale {
    month: u32,
    on: Option<NaiveDate>,
    cards: Vec<(f64, i32)>,
    amount: f64,
    profit: f64,
}

#[derive(Default)]
struct Book {
    members: Vec<Member>,
    entries: Vec<Entry>,
    hot_buys: Vec<HotBuy>,
    hot_sales: Vec<HotSale>,
    /// «کارت های موجود» under a month: cards in hand at its end, per volume.
    hot_stock: BTreeMap<u32, Vec<(f64, i32)>>,
    /// Statement figures per line key, by month.
    statement: HashMap<&'static str, [Option<f64>; 12]>,
    warnings: Vec<String>,
    /// «لیست عضویت امانت دهی کتابها»: the guarantee cards.
    deposits: Vec<DepositRow>,
    /// «لیست امانت دهی کتاب»: the books lent, month by month.
    loans: Vec<LoanRow>,
}

/// A guarantee card: cash (p-101), books (k-101) or a person who vouches (z-101).
struct DepositRow {
    code: String,
    kind: &'static str,
    name: String,
    father: Option<String>,
    phone: Option<String>,
    on: NaiveDate,
    amount: Option<f64>,
    guarantee: Option<String>,
    note: Option<String>,
    /// «واپس گردید»: the guarantee went back.
    returned: bool,
}

/// A book lent. Its borrower's ID is a card, a member's number, or often left empty.
struct LoanRow {
    id: Option<String>,
    name: String,
    father: Option<String>,
    title: String,
    on: NaiveDate,
    fee: Option<f64>,
    /// The sheet's «days until today» formula is still in the row, so the book is out.
    counting: bool,
    note: Option<String>,
}

impl Book {
    fn warn(&mut self, w: String) {
        if self.warnings.len() < MAX_WARNINGS {
            self.warnings.push(w);
        }
    }
}

pub(crate) fn clean(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ").replace('ي', "ی").replace('ك', "ک")
}

pub(crate) fn text(d: &Data) -> Option<String> {
    let t = match d {
        Data::String(s) => clean(s),
        Data::Int(i) => i.to_string(),
        Data::Float(f) if f.fract() == 0.0 => format!("{}", *f as i64),
        Data::Float(f) => f.to_string(),
        _ => return None,
    };
    (!t.is_empty() && t != "-").then_some(t)
}

pub(crate) fn num(d: &Data) -> Option<f64> {
    match d {
        Data::Int(i) => Some(*i as f64),
        Data::Float(f) => Some(*f),
        Data::String(s) => s.trim().replace(',', "").parse().ok(),
        _ => None,
    }
}

pub(crate) fn cell(rg: &Range<Data>, r: usize, c: usize) -> &Data {
    rg.get((r, c)).unwrap_or(&Data::Empty)
}

/// Row number as Excel shows it, for messages.
pub(crate) fn excel_row(rg: &Range<Data>, r: usize) -> usize {
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

    // Monthly seats: one row per member, the fee paid under each month.
    let name = "عضویت ماهانه";
    let rg = sheet(&sheets, name).ok_or(ApiError::bad("sheet_missing_monthly"))?;
    let h = find_header(rg, "ID").ok_or(ApiError::bad("sheet_missing_monthly"))?;
    read_member_sheet(&mut book, rg, name, h, "monthly");

    // Monthly internet: the same layout, often the same people.
    let name = "انترنت";
    if let Some(rg) = sheet(&sheets, name) {
        if let Some(h) = find_header(rg, "ID") {
            read_member_sheet(&mut book, rg, name, h, "internet");
        }
    }
    // The same person twice in one sheet: both rows' money counts, as in the book's sums.
    let mut twice = Vec::new();
    for m in &book.members {
        for sheet_name in ["عضویت ماهانه", "انترنت"] {
            let rows: Vec<String> = m.rows.iter().filter(|(s, _)| *s == sheet_name).map(|(_, r)| r.to_string()).collect();
            if rows.len() > 1 {
                twice.push(format!("{} {} («{sheet_name}»، ردیف {})", m.no, m.name.as_deref().unwrap_or("بی‌نام"), rows.join(" و ")));
            }
        }
    }
    if !twice.is_empty() {
        book.warn(format!("{} نفر با همان آیدی و همان نام دو ردیف دارند؛ پول هر دو ردیف وارد شد: {}", twice.len(), twice.join("، ")));
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
    let name = "انترنت هاتسپات";
    if let Some(rg) = sheet(&sheets, name) {
        read_hotspot(&mut book, rg, name);
    }
    let name = "لیست عضویت امانت دهی کتابها";
    if let Some(rg) = sheet(&sheets, name) {
        read_deposits(&mut book, rg, name);
    }
    let name = "لیست امانت دهی کتاب";
    if let Some(rg) = sheet(&sheets, name) {
        read_loans(&mut book, rg, name);
    }
    let name = "محاسبات";
    let rg = sheet(&sheets, name).ok_or(ApiError::bad("sheet_missing_statement"))?;
    read_statement(&mut book, rg, name);
    Ok(book)
}

/// Whether two names in the book (or the book and the app) are one person: spelled alike,
/// or one a shortened form of the other («محمد رضا» and «محمد رضا احمدی»).
pub(crate) fn same_name(a: &str, b: &str) -> bool {
    crate::k50::same_person(a, b) || crate::k50::same_person(b, a)
}

/// A name that says nothing: an earlier import made members of rows with no name.
fn no_name(s: &str) -> bool {
    let s = clean(s);
    s.is_empty() || s == "بدون نام" || s == "بی‌نام"
}

fn read_member_sheet(book: &mut Book, rg: &Range<Data>, sheet_name: &'static str, h: usize, category: &'static str) {
    let months = month_cols(rg, h);
    let c_name = col_containing(rg, h, "نام و تخلص").unwrap_or(1);
    let c_father = col_containing(rg, h, "نام پدر");
    let c_phone = col_containing(rg, h, "تماس");
    // «وضعیت» (student, language learner…) is what the book calls it now; «رشته» before.
    let c_field = col_containing(rg, h, "وضعیت").or_else(|| col_containing(rg, h, "رشته"));
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
        let mut who_row = None;
        if let Some(no) = id {
            let row = Member {
                no,
                name: person.clone().filter(|p| !no_name(p)),
                father: opt(r, c_father),
                phone: c_phone.and_then(|c| phone(cell(rg, r, c))),
                field: opt(r, c_field),
                tazkira: opt(r, c_tazkira),
                rows: vec![(sheet_name, excel_row(rg, r))],
            };
            // The same number and the same name (or no name on either side) is the same
            // person, in this sheet or the internet one; another name is someone else.
            let same = book.members.iter().position(|m| {
                m.no == no
                    && match (&m.name, &row.name) {
                        (Some(a), Some(b)) => same_name(a, b),
                        (None, None) => true,
                        _ => false,
                    }
            });
            who_row = Some(match same {
                Some(i) => {
                    let m = &mut book.members[i];
                    m.father = m.father.take().or(row.father);
                    m.phone = m.phone.take().or(row.phone);
                    m.field = m.field.take().or(row.field);
                    m.tazkira = m.tazkira.take().or(row.tazkira);
                    m.rows.extend(row.rows);
                    i
                }
                None => {
                    book.members.push(row);
                    book.members.len() - 1
                }
            });
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
                book.entries.push(Entry {
                    kind: Kind::Income,
                    key: category,
                    month: m,
                    day: None,
                    amount: v,
                    note: Some(format!("{label} · {who}")),
                    person: who_row,
                });
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
                book.entries.push(Entry { kind: Kind::Income, key: "daily", month: m, day, amount: v, note: Some(format!("عضویت روزانه · {who}")), person: None });
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
                book.entries.push(Entry { kind: Kind::Expense, key: category, month, day: Some(day), amount: v, note, person: None });
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
                book.entries.push(Entry { kind, key, month, day: day_of(cell(rg, row, *c)), amount: v, note, person: None });
            }
        }
        r = end;
    }
}

/// A date cell: an Excel date, or its serial number.
fn excel_date(d: &Data) -> Option<NaiveDate> {
    let serial = match d {
        Data::DateTime(t) => t.as_f64(),
        Data::Float(f) if (30_000.0..80_000.0).contains(f) => *f,
        Data::Int(i) if (30_000..80_000).contains(i) => *i as f64,
        Data::DateTimeIso(t) => return NaiveDate::parse_from_str(t.get(..10)?, "%Y-%m-%d").ok(),
        _ => return None,
    };
    NaiveDate::from_ymd_opt(1899, 12, 30)?.checked_add_days(Days::new(serial.floor() as u64))
}

/// A day as the loan sheets write it: a real Excel date, or typed: "27/11/1401" (Solar) or
/// "6/5/2024". The year is whichever part looks like one; the day comes first.
fn any_date(d: &Data) -> Option<NaiveDate> {
    if let Some(day) = excel_date(d) {
        return Some(day);
    }
    let t = text(d)?;
    let parts: Vec<i32> = t.split(['/', '-', '.']).map(|p| p.trim().parse().ok()).collect::<Option<_>>()?;
    let [a, b, c] = parts.as_slice() else { return None };
    let (y, m, day) = if *c >= 1000 { (*c, *b, *a) } else if *a >= 1000 { (*a, *b, *c) } else { return None };
    if !(1..=12).contains(&m) || day < 1 {
        return None;
    }
    if y < 1700 {
        solar::to_gregorian(y, m as u32, day as u32)
    } else {
        NaiveDate::from_ymd_opt(y, m as u32, day as u32)
    }
}

/// Two tables side by side, each: ID, name, father, phone, day, guarantee, remarks. Cards
/// numbered ahead with nobody on them are left out.
fn read_deposits(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    let Some(h) = find_header(rg, "ID") else { return };
    for start in (0..rg.width()).filter(|&c| text(cell(rg, h, c)).as_deref() == Some("ID")) {
        for r in h + 1..rg.height() {
            let at = |k: usize| cell(rg, r, start + k);
            let (Some(code), Some(name)) = (text(at(0)), text(at(1))) else { continue };
            let code = code.to_lowercase();
            let kind = match code.get(..2) {
                Some("p-") => "cash",
                Some("k-") => "book",
                Some("z-") => "person",
                _ => {
                    book.warn(format!("{sheet_name}، ردیف {}: شمارهٔ کارت «{code}» شناخته نشد؛ وارد نشد.", excel_row(rg, r)));
                    continue;
                }
            };
            let Some(on) = any_date(at(4)) else {
                book.warn(format!("{sheet_name}، ردیف {}: تاریخ کارت {code} خوانده نشد؛ وارد نشد.", excel_row(rg, r)));
                continue;
            };
            let note = text(at(6));
            let returned = note.as_deref().is_some_and(|n| n.contains("واپس"));
            book.deposits.push(DepositRow {
                code,
                kind,
                name,
                father: text(at(2)),
                phone: phone(at(3)),
                on,
                amount: num(at(5)).filter(|v| *v > 0.0),
                guarantee: text(at(5)),
                note: note.filter(|_| !returned),
                returned,
            });
        }
    }
}

/// One block per month: ID, name, father, book, day taken, days until today (a formula while
/// the book is out), weekly fee, fine, remarks.
fn read_loans(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    for r in 0..rg.height() {
        let at = |k: usize| cell(rg, r, k);
        let (Some(name), Some(title)) = (text(at(1)), text(at(3))) else { continue };
        if text(at(0)).as_deref() == Some("ID") {
            continue;
        }
        let Some(on) = any_date(at(4)) else {
            book.warn(format!("{sheet_name}، ردیف {}: تاریخ اخذ «{title}» خوانده نشد؛ وارد نشد.", excel_row(rg, r)));
            continue;
        };
        book.loans.push(LoanRow {
            id: text(at(0)),
            name,
            father: text(at(2)),
            title,
            on,
            fee: num(at(6)).filter(|v| *v > 0.0),
            counting: num(at(5)).is_some(),
            note: text(at(8)),
        });
    }
}

/// "5GB" -> 5.
fn volume_of(t: &str) -> Option<f64> {
    t.trim().strip_suffix("GB")?.trim().parse().ok().filter(|v: &f64| *v > 0.0)
}

/// The hotspot sheet: a block per month, «ماه حمل» and so on. Each block has supplier
/// bills on the right (date, bill number, the bill's GB, cards per volume, extra costs,
/// the amount) and the daily counts of cards sold on the left (date, cards per volume,
/// sales, profit), then a totals row, «کارت های موجود» and «خلاصه مالی». The first months
/// have one summary row each and no dates.
fn read_hotspot(book: &mut Book, rg: &Range<Data>, sheet_name: &str) {
    struct Cols {
        bill_no: Option<usize>,
        bill_gb: Option<usize>,
        extra: Option<usize>,
        total: Option<usize>,
        buy_cards: Vec<(usize, f64)>,
        sale_date: usize,
        sale_cards: Vec<(usize, f64)>,
        sales: Option<usize>,
        profit: Option<usize>,
    }
    let header = |r: usize| -> Option<Cols> {
        let at = |c: usize| text(cell(rg, r, c)).unwrap_or_default();
        let dates: Vec<usize> = (0..rg.width()).filter(|&c| at(c) == "تاریخ").collect();
        let (&first, &second) = (dates.first()?, dates.get(1)?);
        let find = |from: usize, to: usize, f: &dyn Fn(&str) -> bool| (from..to).find(|&c| f(&at(c)));
        let cards = |from: usize, to: usize| (from..to).filter_map(|c| volume_of(&at(c)).map(|v| (c, v))).collect::<Vec<_>>();
        Some(Cols {
            bill_no: find(first, second, &|t| t.starts_with("شماره بل")),
            bill_gb: find(first, second, &|t| t.starts_with("حجم عمومی")),
            extra: find(first, second, &|t| t == "مصارف"),
            total: find(first, second, &|t| t.starts_with("مبلغ خرید")),
            buy_cards: cards(first, second),
            sale_date: second,
            sale_cards: cards(second, rg.width()),
            sales: find(second, rg.width(), &|t| t.starts_with("مجموع فروش")),
            profit: find(second, rg.width(), &|t| t == "سود"),
        })
    };
    let counts = |r: usize, cols: &[(usize, f64)]| -> Vec<(f64, i32)> {
        cols.iter()
            .filter_map(|&(c, v)| num(cell(rg, r, c)).filter(|n| *n > 0.0 && n.fract() == 0.0).map(|n| (v, n as i32)))
            .collect()
    };
    let amount = |r: usize, c: Option<usize>| c.and_then(|c| num(cell(rg, r, c))).unwrap_or(0.0);

    let mut month: Option<u32> = None;
    let mut cols: Option<Cols> = None;
    let mut rows: Vec<usize> = Vec::new();
    let flush = |book: &mut Book, month: Option<u32>, cols: &Option<Cols>, rows: &mut Vec<usize>| {
        let (Some(m), Some(k)) = (month, cols) else {
            rows.clear();
            return;
        };
        let bill_text = |r: usize| k.bill_no.and_then(|c| text(cell(rg, r, c)));
        let carried = |r: usize| bill_text(r).is_some_and(|t| t.contains("باقیمانده"));
        // Supplier bills: rows with a date or a bill number (not the carry-over row).
        let billed: Vec<usize> =
            rows.iter().copied().filter(|&r| !carried(r) && (excel_date(cell(rg, r, 0)).is_some() || bill_text(r).is_some())).collect();
        let buy_rows = if billed.is_empty() { rows.first().copied().into_iter().collect() } else { billed };
        let mut last_on = None;
        for r in buy_rows {
            let cards = counts(r, &k.buy_cards);
            if cards.is_empty() {
                continue;
            }
            let on = excel_date(cell(rg, r, 0)).or(last_on);
            last_on = on;
            book.hot_buys.push(HotBuy {
                month: m,
                on,
                bill_no: bill_text(r),
                bill_gb: k.bill_gb.and_then(|c| num(cell(rg, r, c))),
                extra_cost: amount(r, k.extra),
                total: amount(r, k.total),
                cards,
            });
        }
        // Daily counts: rows with a date in the sales date column.
        let dated: Vec<usize> = rows.iter().copied().filter(|&r| excel_date(cell(rg, r, k.sale_date)).is_some()).collect();
        let sale_rows = if dated.is_empty() { rows.first().copied().into_iter().collect() } else { dated };
        for r in sale_rows {
            let cards = counts(r, &k.sale_cards);
            if cards.is_empty() {
                continue;
            }
            book.hot_sales.push(HotSale {
                month: m,
                on: excel_date(cell(rg, r, k.sale_date)),
                cards,
                amount: amount(r, k.sales),
                profit: amount(r, k.profit),
            });
        }
        rows.clear();
    };
    let mut ended = true;
    for r in 0..rg.height() {
        let first = text(cell(rg, r, 0)).unwrap_or_default();
        if let Some(name) = first.strip_prefix("ماه ") {
            flush(book, month, &cols, &mut rows);
            month = month_of(name.trim());
            cols = None;
            ended = true;
        } else if first == "تاریخ" {
            cols = header(r);
            ended = cols.is_none();
            if ended {
                book.warn(format!("{sheet_name}، ردیف {}: ستون‌های جدول شناخته نشد.", excel_row(rg, r)));
            }
        } else if first.starts_with("کارت های موجود") || first.starts_with("کارت‌های موجود") {
            if let (Some(m), Some(k)) = (month, &cols) {
                book.hot_stock.insert(m, counts(r, &k.buy_cards));
            }
            ended = true;
        } else if first.starts_with("خلاصه مالی") {
            ended = true;
        } else if !ended && cols.is_some() {
            rows.push(r);
        }
        if ended && !rows.is_empty() {
            flush(book, month, &cols, &mut rows);
        }
    }
    flush(book, month, &cols, &mut rows);
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
                            book.entries.push(Entry { kind: l.kind, key: l.key, month: i as u32 + 1, day: None, amount: v, note: Some(note), person: None });
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
    /// Where a month's hotspot income comes from: "sheet" (default: the month's sales profit
    /// on the hotspot sheet, as the statement's own formula takes it), "mixed" (the
    /// statement's figure, or the sheet's profit where the statement has none) or "statement".
    #[serde(default)]
    hotspot_income: Option<String>,
    /// IDs (comma-separated) where a partner said the book is right: the member who holds
    /// the ID in the app becomes the person the book has under it (see `Clash`).
    #[serde(default)]
    take_excel: Option<String>,
}

/// One month of the hotspot sheet as imported.
#[derive(Serialize, Default, Clone, Copy)]
struct HotMonth {
    cards_bought: i64,
    gb_bought: f64,
    /// The supplier bills' amounts, extra costs included.
    bought: f64,
    cards_sold: i64,
    gb_sold: f64,
    sales: f64,
    /// The sheet's profit (sales minus what the cards sold had cost).
    profit: f64,
    /// The statement's hotspot figure.
    statement: Option<f64>,
    /// What went into the income: the statement's figure or the sheet's profit.
    income: f64,
    from_sheet: bool,
}

#[derive(Serialize, Default)]
struct HotReport {
    buys: usize,
    counts: usize,
    months: [HotMonth; 12],
}

#[derive(Serialize)]
pub struct Report {
    year: i32,
    committed: bool,
    batch_id: Option<Uuid>,
    members: usize,
    members_new: i64,
    receipts: usize,
    /// Of the book's income, expense and withdrawal rows already in the app: how many stayed as
    /// they were, how many were taken out (no longer in the book) and how many were new.
    rows_kept: i64,
    rows_removed: i64,
    rows_added: i64,
    /// Cells of a member's month the app already has a bill for: not counted a second time.
    in_app: usize,
    in_app_amount: f64,
    /// Fee cells that got a day from the member's period, or one counted back from it.
    fees_exact: usize,
    fees_counted: usize,
    /// Days of the meals cell split into breakfast, lunch and dinner, and days left whole
    /// (their parts did not add up to the cell, or it had other things in it).
    food_split: usize,
    food_whole: usize,
    /// Expense and withdrawal lines the app already has (typed there): left out of the book's.
    expenses_in_app: usize,
    expenses_in_app_amount: f64,
    withdrawals_in_app: usize,
    loans: LoanReport,
    expenses: usize,
    withdrawals: usize,
    /// When this year was imported before; importing again replaces that run.
    replaces: Option<chrono::DateTime<chrono::Utc>>,
    lines: Vec<LineReport>,
    hotspot: HotReport,
    /// IDs given to two different people; shown before anything else.
    clashes: Vec<Clash>,
    warnings: Vec<String>,
}

/// What the two loan sheets changed. They are added to what the app has, not replaced: a
/// card or a loan already in the app stays as the app has it.
#[derive(Serialize, Default)]
pub struct LoanReport {
    deposits_new: usize,
    deposits_returned: usize,
    loans_new: usize,
    loans_out: usize,
    loans_returned: usize,
    /// Borrowers with no card or member in the book: they got a card, to be checked by hand.
    no_card: Vec<String>,
}

/// One ID that the app and the book, or two rows of the book, give to different people.
/// Nothing of the book's person is joined to the app's member (no money, no father's name,
/// no phone); their payments still count in the income, under nobody.
#[derive(Serialize)]
struct Clash {
    no: i32,
    /// The member holding the ID in the app; None when only the book has it (twice).
    app: Option<AppSide>,
    /// The people of the book under this ID who are not that member.
    excel: Vec<ExcelSide>,
    /// "kept": the app member stays as it is; "excel": the app member became the book's
    /// person (`take_excel`); "none": two people in the book, so neither was added.
    outcome: &'static str,
    /// One person in the book and none of the book's rows is the app member: a partner
    /// may say the book is right.
    can_take_excel: bool,
}

#[derive(Serialize)]
struct AppSide {
    name: String,
    father: Option<String>,
    phone: Option<String>,
    /// Made by an earlier import (not typed at the desk).
    from_excel: bool,
    deleted: bool,
    /// What the app holds for this member: periods, bills and photos or scans.
    periods: i64,
    bills: i64,
    documents: i64,
}

#[derive(Serialize)]
struct ExcelSide {
    name: Option<String>,
    father: Option<String>,
    phone: Option<String>,
    /// «عضویت ماهانه، ردیف 918».
    rows: Vec<String>,
    /// What this person paid in the book, and in which months.
    paid: f64,
    months: Vec<String>,
}

#[derive(sqlx::FromRow)]
struct Held {
    id: Uuid,
    member_no: i32,
    name: String,
    father_name: Option<String>,
    phone: Option<String>,
    deleted: bool,
    from_excel: bool,
    periods: i64,
    bills: i64,
    documents: i64,
}

/// How each person of the book meets the app's members.
#[derive(Default)]
struct Matched {
    /// The app member each book person's money belongs to (by index into the book's members).
    member: Vec<Option<Uuid>>,
    /// New members to add (book people whose ID nobody holds).
    insert: Vec<usize>,
    /// Book people with no name, to join to the new member of the same ID.
    insert_unnamed: Vec<(usize, usize)>,
    /// Existing members whose empty fields (and a missing name) the book fills.
    fill: Vec<(Uuid, usize)>,
    /// Existing members that become the book's person.
    take: Vec<(Uuid, usize)>,
    clashes: Vec<Clash>,
}

/// Joins the book's people to the app's members by ID and name. An ID's member in the app
/// is the book's person only when the names are alike; otherwise it is a clash and nothing
/// is joined, unless the partner chose the book's person for that ID (`take`).
fn match_members(members: &[Member], entries: &[Entry], held: &[Held], take: &[i32], warnings: &mut Vec<String>) -> Matched {
    let mut out = Matched { member: vec![None; members.len()], ..Default::default() };
    let mut by_no: BTreeMap<i32, Vec<usize>> = BTreeMap::new();
    for (i, m) in members.iter().enumerate() {
        by_no.entry(m.no).or_default().push(i);
    }
    let side = |i: usize| {
        let m = &members[i];
        let mut paid = 0.0;
        let mut months = Vec::new();
        for e in entries.iter().filter(|e| e.person == Some(i)) {
            paid += e.amount;
            let month = MONTHS[e.month as usize - 1];
            months.push(if e.key == "internet" { format!("{month} (انترنت)") } else { month.to_string() });
        }
        ExcelSide {
            name: m.name.clone(),
            father: m.father.clone(),
            phone: m.phone.clone(),
            rows: m.rows.iter().map(|(s, r)| format!("{s}، ردیف {r}")).collect(),
            paid,
            months,
        }
    };
    for (no, people) in by_no {
        let (named, unnamed): (Vec<usize>, Vec<usize>) = people.iter().partition(|&&i| members[i].name.is_some());
        match held.iter().find(|h| h.member_no == no) {
            Some(a) => {
                let app_named = !no_name(&a.name);
                let (mut fit, mut other): (Vec<usize>, Vec<usize>) =
                    named.iter().partition(|&&i| !app_named || same_name(members[i].name.as_deref().unwrap_or(""), &a.name));
                // A member with no name takes the book's name only when the book has one person.
                if !app_named && fit.len() > 1 {
                    other.append(&mut fit);
                }
                for &i in fit.iter().chain(&unnamed) {
                    out.member[i] = Some(a.id);
                    out.fill.push((a.id, i));
                }
                // An earlier import made a member of a row that has only a number (a note
                // such as «بابت برابرشدن حسابات», or a total).
                if !app_named && named.is_empty() && !a.deleted && a.periods + a.bills + a.documents == 0 && warnings.len() < MAX_WARNINGS {
                    warnings.push(format!(
                        "آیدی {no} نه در اکسل نام دارد نه در برنامه («بدون نام»). اگر این ردیف عضو نیست، آن عضو را از «اعضا» حذف کنید؛ پولش در درآمد می‌ماند."
                    ));
                }
                if other.is_empty() {
                    continue;
                }
                let can_take = other.len() == 1 && fit.is_empty();
                let taking = can_take && take.contains(&no);
                if taking {
                    out.member[other[0]] = Some(a.id);
                    out.take.push((a.id, other[0]));
                }
                out.clashes.push(Clash {
                    no,
                    app: Some(AppSide {
                        name: a.name.clone(),
                        father: a.father_name.clone(),
                        phone: a.phone.clone(),
                        from_excel: a.from_excel,
                        deleted: a.deleted,
                        periods: a.periods,
                        bills: a.bills,
                        documents: a.documents,
                    }),
                    excel: other.iter().map(|&i| side(i)).collect(),
                    outcome: if taking { "excel" } else { "kept" },
                    can_take_excel: can_take,
                });
            }
            None if named.len() == 1 => {
                out.insert.push(named[0]);
                out.insert_unnamed.extend(unnamed.iter().map(|&u| (u, named[0])));
            }
            None if named.is_empty() => {
                for &i in &unnamed {
                    let m = &members[i];
                    let said: Vec<&str> = [&m.father, &m.phone].into_iter().flatten().map(|s| s.as_str()).collect();
                    let said = if said.is_empty() { String::new() } else { format!(" (در ردیف نوشته: {})", said.join("، ")) };
                    if warnings.len() < MAX_WARNINGS {
                        warnings.push(format!(
                            "آیدی {no} در {} نام ندارد{said}؛ پولش در درآمد آمد ولی عضوی ساخته نشد.",
                            m.rows.iter().map(|(s, r)| format!("«{s}» ردیف {r}")).collect::<Vec<_>>().join(" و ")
                        ));
                    }
                }
            }
            None => out.clashes.push(Clash {
                no,
                app: None,
                excel: named.iter().map(|&i| side(i)).collect(),
                outcome: "none",
                can_take_excel: false,
            }),
        }
    }
    out
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
    if !user.may("import") {
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
        crate::history::ensure_1404(&s.db).await;
    } else {
        tx.rollback().await?;
    }
    Ok(Json(report))
}

pub(crate) fn percent_decode(s: &str) -> String {
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
    let Book { members, mut entries, statement, mut warnings, hot_buys, hot_sales, hot_stock, deposits, loans } = book;
    let year = p.year;

    // Each month's hotspot income comes from one place only: the statement's figure, or
    // the sheet's daily counts (then each count is a receipt for its profit).
    let policy = p.hotspot_income.as_deref().unwrap_or("sheet");
    if !matches!(policy, "mixed" | "sheet" | "statement") {
        return Err(ApiError::bad("bad_hotspot_income"));
    }
    let stated = statement.get("hotspot").copied().unwrap_or([None; 12]);
    let sheet_month = |m: u32| -> bool {
        let has_sales = hot_sales.iter().any(|x| x.month == m);
        match policy {
            "sheet" => has_sales,
            "statement" => false,
            _ => has_sales && stated[m as usize - 1].is_none_or(|v| v == 0.0),
        }
    };
    entries.retain(|e| !(e.kind == Kind::Income && e.key == "hotspot" && sheet_month(e.month)));

    // The book's thousands of rows are not each written into «چه کسی چه کرد»: one line for
    // the import says it (write_audit reads this). Sync still carries every change.
    sqlx::query("SELECT set_config('pezhohesh.bulk', 'on', true)").execute(&mut *db).await?;

    // A year has one batch. Importing the book again keeps it and its rows: what is the same
    // stays as it is, only rows gone from the book are taken out and new ones put in. So a
    // new import writes tens of rows, not thousands (and the server, the backups and the log
    // stay small).
    let held_batch: Option<(Uuid, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, imported_at FROM import_batches WHERE source = $1 AND solar_year = $2 AND replaced_at IS NULL ORDER BY imported_at DESC LIMIT 1",
    )
    .bind(SOURCE)
    .bind(year)
    .fetch_optional(&mut *db)
    .await?;
    let replaces = held_batch.map(|b| b.1);
    let batch = match held_batch {
        Some((id, _)) => {
            sqlx::query("UPDATE import_batches SET file_name = $2, file_sha256 = $3, imported_by = $4, imported_at = now() WHERE id = $1")
                .bind(id)
                .bind(&p.file_name)
                .bind(sha)
                .bind(user.id)
                .execute(&mut *db)
                .await?;
            id
        }
        None => {
            let id = Uuid::new_v4();
            sqlx::query("INSERT INTO import_batches (id, source, solar_year, file_name, file_sha256, imported_by) VALUES ($1, $2, $3, $4, $5, $6)")
                .bind(id)
                .bind(SOURCE)
                .bind(year)
                .bind(&p.file_name)
                .bind(sha)
                .bind(user.id)
                .execute(&mut *db)
                .await?;
            id
        }
    };
    // Each run numbers its new rows itself, so they never meet the numbers of rows kept.
    let run = Uuid::new_v4();
    // The hotspot sheet's bills and counts depend on each other; they are written again.
    for table in ["hotspot_sales", "hotspot_purchases", "hotspot_buys"] {
        sqlx::query(&format!("DELETE FROM {table} WHERE import_batch_id = $1")).bind(batch).execute(&mut *db).await?;
    }
    sqlx::query("DELETE FROM receipts WHERE import_batch_id = $1 AND receipt_no ~ '-H[0-9]+$'").bind(batch).execute(&mut *db).await?;

    // Members: a new ID is added; an ID the app has is the same member only when the names
    // are alike, and then only its empty fields are filled (see match_members).
    let take: Vec<i32> =
        p.take_excel.as_deref().unwrap_or("").split(',').filter_map(|x| x.trim().parse().ok()).collect();
    let nos: Vec<i32> = members.iter().map(|m| m.no).collect();
    let held: Vec<Held> = sqlx::query_as(
        r#"
        SELECT m.id, m.member_no, trim(concat_ws(' ', m.first_name, m.last_name)) AS name, m.father_name, m.phone,
               m.deleted_at IS NOT NULL AS deleted, m.import_batch_id IS NOT NULL AS from_excel,
               (SELECT count(*) FROM memberships x WHERE x.member_id = m.id AND x.deleted_at IS NULL) AS periods,
               (SELECT count(*) FROM receipts r JOIN memberships x ON x.id = r.membership_id
                 WHERE x.member_id = m.id AND NOT r.voided AND r.deleted_at IS NULL) AS bills,
               (SELECT count(*) FROM member_documents d WHERE d.member_id = m.id AND d.deleted_at IS NULL) AS documents
        FROM members m WHERE m.member_no = ANY($1) AND m.no_freed_at IS NULL
        "#,
    )
    .bind(&nos)
    .fetch_all(&mut *db)
    .await?;
    let mut matched = match_members(&members, &entries, &held, &take, &mut warnings);

    // Their join date is unknown, so they count as members from before this year.
    let before_year = solar::to_gregorian(year, 1, 1).expect("1 Hamal") - Days::new(1);
    let add: Vec<&Member> = matched.insert.iter().map(|&i| &members[i]).collect();
    let added: Vec<(i32, Uuid)> = sqlx::query_as(
        r#"
        INSERT INTO members (id, member_no, first_name, father_name, phone, field_of_study, tazkira_no, joined_on, import_batch_id)
        SELECT gen_random_uuid(), m.no, m.name, m.father, m.phone, m.field, m.tazkira, $7, $8
        FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS m(no, name, father, phone, field, tazkira)
        ON CONFLICT (member_no) WHERE no_freed_at IS NULL DO NOTHING
        RETURNING member_no, id
        "#,
    )
    .bind(add.iter().map(|m| m.no).collect::<Vec<_>>())
    .bind(add.iter().map(|m| m.name.clone()).collect::<Vec<_>>())
    .bind(add.iter().map(|m| m.father.clone()).collect::<Vec<_>>())
    .bind(add.iter().map(|m| m.phone.clone()).collect::<Vec<_>>())
    .bind(add.iter().map(|m| m.field.clone()).collect::<Vec<_>>())
    .bind(add.iter().map(|m| m.tazkira.clone()).collect::<Vec<_>>())
    .bind(before_year)
    .bind(batch)
    .fetch_all(&mut *db)
    .await?;
    let members_new = added.len() as i64;
    for &i in &matched.insert {
        matched.member[i] = added.iter().find(|(no, _)| *no == members[i].no).map(|(_, id)| *id);
    }
    for &(u, i) in &matched.insert_unnamed {
        matched.member[u] = matched.member[i];
    }
    // The book fills what the app left empty, and a name for a member that had none.
    let fill: Vec<(Uuid, &Member)> = matched.fill.iter().map(|&(id, i)| (id, &members[i])).collect();
    sqlx::query(
        r#"
        UPDATE members m SET
            first_name     = CASE WHEN trim(concat_ws(' ', m.first_name, m.last_name)) IN ('', 'بدون نام', 'بی‌نام')
                                  AND x.name IS NOT NULL THEN x.name ELSE m.first_name END,
            father_name    = COALESCE(m.father_name, x.father),
            phone          = COALESCE(m.phone, x.phone),
            field_of_study = COALESCE(x.field, m.field_of_study),
            tazkira_no     = COALESCE(m.tazkira_no, x.tazkira)
        FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[]) AS x(id, name, father, phone, field, tazkira)
        WHERE m.id = x.id AND (
            (trim(concat_ws(' ', m.first_name, m.last_name)) IN ('', 'بدون نام', 'بی‌نام') AND x.name IS NOT NULL)
            OR (m.father_name IS NULL AND x.father IS NOT NULL) OR (m.phone IS NULL AND x.phone IS NOT NULL)
            OR (x.field IS NOT NULL AND m.field_of_study IS DISTINCT FROM x.field) OR (m.tazkira_no IS NULL AND x.tazkira IS NOT NULL))
        "#,
    )
    .bind(fill.iter().map(|(id, _)| *id).collect::<Vec<_>>())
    .bind(fill.iter().map(|(_, m)| m.name.clone()).collect::<Vec<_>>())
    .bind(fill.iter().map(|(_, m)| m.father.clone()).collect::<Vec<_>>())
    .bind(fill.iter().map(|(_, m)| m.phone.clone()).collect::<Vec<_>>())
    .bind(fill.iter().map(|(_, m)| m.field.clone()).collect::<Vec<_>>())
    .bind(fill.iter().map(|(_, m)| m.tazkira.clone()).collect::<Vec<_>>())
    .execute(&mut *db)
    .await?;
    // A partner said the book is right: the member becomes the book's person (what the book
    // leaves empty is kept as it was).
    for &(id, i) in &matched.take {
        let m = &members[i];
        sqlx::query(
            "UPDATE members SET first_name = $2, last_name = NULL, father_name = COALESCE($3, father_name), \
                 phone = COALESCE($4, phone), field_of_study = COALESCE($5, field_of_study), tazkira_no = COALESCE($6, tazkira_no) \
             WHERE id = $1",
        )
        .bind(id)
        .bind(&m.name)
        .bind(&m.father)
        .bind(&m.phone)
        .bind(&m.field)
        .bind(&m.tazkira)
        .execute(&mut *db)
        .await?;
    }
    let Matched { member: member_of, clashes, .. } = matched;

    let dated: Vec<(&Entry, NaiveDate)> = entries.iter().map(|e| (e, date_of(year, e.month, e.day, &mut warnings))).collect();
    let tag = format!("اکسل {year}");
    let note = |e: &Entry| Some(match &e.note {
        Some(n) => format!("{n} ({tag})"),
        None => format!("({tag})"),
    });

    // A member registered at the desk and in the book has that month's money in both: the
    // app's bill stands, and the book's cell for the same member, line and month is left out.
    // A bill belongs to the month it was paid in and to the month its period starts in.
    let of_a_member = |e: &Entry| -> Option<Uuid> {
        if e.kind == Kind::Income && matches!(e.key, "monthly" | "internet") {
            e.person.and_then(|i| member_of[i])
        } else {
            None
        }
    };
    let ids: Vec<Uuid> = entries.iter().filter_map(&of_a_member).collect();
    let billed: Vec<(Uuid, String, NaiveDate, NaiveDate)> = sqlx::query_as(
        "SELECT ms.member_id, r.income_category::text, r.issued_on, ms.start_date \
         FROM receipts r JOIN memberships ms ON ms.id = r.membership_id \
         WHERE r.import_batch_id IS NULL AND NOT r.voided AND r.deleted_at IS NULL AND ms.deleted_at IS NULL \
           AND ms.member_id = ANY($1) AND r.income_category::text IN ('monthly', 'internet')",
    )
    .bind(&ids)
    .fetch_all(&mut *db)
    .await?;
    let mut has_bill: std::collections::HashSet<(Uuid, String, i32, u32)> = std::collections::HashSet::new();
    for (member, category, paid, start) in billed {
        for d in [paid, start] {
            has_bill.insert((member, category.clone(), solar::year_of(d), solar::month_day(d).0));
        }
    }
    let in_app = |e: &Entry| of_a_member(e).is_some_and(|m| has_bill.contains(&(m, e.key.to_string(), year, e.month)));
    let (in_app_count, in_app_amount) = entries.iter().filter(|e| in_app(e)).fold((0usize, 0.0f64), |(n, s), e| (n + 1, s + e.amount));

    // Income: one receipt per Excel cell. Imported receipts were never printed.
    let income: Vec<_> = dated.iter().filter(|(e, _)| e.kind == Kind::Income && !in_app(e)).collect();
    let short_run = run.simple().to_string();
    let short = &short_run[..6];
    // Each monthly or internet cell belongs to the member of its row (v_excel_months), when
    // that row's person is a member; a clash leaves it with nobody. A cell is the same as a
    // kept one when line, month, amount, words and member are; its day may have been set since.
    sqlx::query("DROP TABLE IF EXISTS xl_rx").execute(&mut *db).await?;
    sqlx::query("CREATE TEMP TABLE xl_rx (no TEXT, day DATE, amount NUMERIC, category TEXT, note TEXT, member UUID) ON COMMIT DROP").execute(&mut *db).await?;
    sqlx::query(
        "INSERT INTO xl_rx SELECT * FROM unnest($1::text[], $2::date[], $3::numeric[], $4::text[], $5::text[], $6::uuid[])",
    )
    .bind(income.iter().enumerate().map(|(i, _)| format!("XL{year}-{short}-{:05}", i + 1)).collect::<Vec<_>>())
    .bind(income.iter().map(|(_, d)| *d).collect::<Vec<_>>())
    .bind(income.iter().map(|(e, _)| e.amount).collect::<Vec<f64>>())
    .bind(income.iter().map(|(e, _)| e.key.to_string()).collect::<Vec<_>>())
    .bind(income.iter().map(|(e, _)| note(e)).collect::<Vec<_>>())
    .bind(income.iter().map(|(e, _)| e.person.and_then(|i| member_of[i])).collect::<Vec<Option<Uuid>>>())
    .execute(&mut *db)
    .await?;
    let rx: (i64, i64, i64) = sqlx::query_as(
        r#"
        WITH n AS (SELECT x.*, sm.starts_on AS m,
                          row_number() OVER (PARTITION BY x.category, sm.starts_on, x.amount, x.note, x.member ORDER BY x.no) AS k
                   FROM xl_rx x JOIN solar_months sm ON x.day BETWEEN sm.starts_on AND sm.ends_on),
             o AS (SELECT r.id, sm.starts_on AS m, r.income_category AS c, r.amount AS a, r.description AS d, r.member_id AS mem,
                          row_number() OVER (PARTITION BY r.income_category, sm.starts_on, r.amount, r.description, r.member_id ORDER BY r.created_at, r.id) AS k
                   FROM receipts r JOIN solar_months sm ON r.issued_on BETWEEN sm.starts_on AND sm.ends_on
                   WHERE r.import_batch_id = $1 AND r.deleted_at IS NULL AND r.receipt_no !~ '-H[0-9]+$'),
             gone AS (DELETE FROM receipts WHERE id IN (
                          SELECT o.id FROM o WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.category = o.c AND n.m = o.m AND n.amount = o.a
                              AND n.note IS NOT DISTINCT FROM o.d AND n.member IS NOT DISTINCT FROM o.mem AND n.k = o.k))
                      RETURNING 1),
             added AS (INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category, description, member_id, import_batch_id)
                       SELECT gen_random_uuid(), n.no, 'hall', n.day, n.amount, n.category, n.note, n.member, $1 FROM n
                       WHERE NOT EXISTS (SELECT 1 FROM o WHERE n.category = o.c AND n.m = o.m AND n.amount = o.a
                              AND n.note IS NOT DISTINCT FROM o.d AND n.member IS NOT DISTINCT FROM o.mem AND n.k = o.k)
                       RETURNING 1)
        SELECT (SELECT count(*) FROM o), (SELECT count(*) FROM gone), (SELECT count(*) FROM added)
        "#,
    )
    .bind(batch)
    .fetch_one(&mut *db)
    .await?;

    // Expense categories in the statement's order.
    let mut category_ids = HashMap::new();
    for (i, l) in LINES.iter().filter(|l| l.kind == Kind::Expense).enumerate() {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO expense_categories (id, department, name, sort_order) VALUES (gen_random_uuid(), 'hall', $1, $2) \
             ON CONFLICT (department, name) DO UPDATE SET sort_order = EXCLUDED.sort_order, deleted_at = NULL RETURNING id",
        )
        .bind(l.key)
        .bind(i as i32 + 1)
        .fetch_one(&mut *db)
        .await?;
        category_ids.insert(l.key, id);
    }
    // Meals: the book writes a day's food in one cell («20صبحانه+چاشت60+شام80»). When the app
    // has the three lines and the parts add up to the cell, each part goes to its own line.
    let food = food_categories(db, &mut warnings).await?;
    let (mut food_split, mut food_whole) = (0usize, 0usize);
    let mut spent: Vec<(Uuid, NaiveDate, Option<String>, f64)> = Vec::new();
    for (e, d) in dated.iter().filter(|(e, _)| e.kind == Kind::Expense) {
        if e.key == "ماکولات" {
            if let Some(ids) = food {
                match e.note.as_deref().and_then(|t| meals(t, e.amount)) {
                    Some(parts) => {
                        food_split += 1;
                        for (i, v) in parts.into_iter().enumerate() {
                            if v > 0.0 {
                                spent.push((ids[i], *d, note(e), v));
                            }
                        }
                        continue;
                    }
                    None => food_whole += 1,
                }
            }
        }
        spent.push((category_ids[e.key], *d, note(e), e.amount));
    }
    // Typed in the app as well: the app's line stands and the book's is left out. A line of
    // the same kind, day and amount is the same line; for meals, a day with any meal typed in
    // the app keeps the app's meals.
    let (lo, hi) = (
        dated.iter().map(|(_, d)| *d).min().unwrap_or(NaiveDate::MIN),
        dated.iter().map(|(_, d)| *d).max().unwrap_or(NaiveDate::MIN),
    );
    let typed: Vec<(Uuid, NaiveDate, f64)> = sqlx::query_as(
        "SELECT category_id, spent_on, amount::float8 FROM expenses \
         WHERE import_batch_id IS NULL AND deleted_at IS NULL AND department = 'hall' AND spent_on BETWEEN $1 AND $2",
    )
    .bind(lo)
    .bind(hi)
    .fetch_all(&mut *db)
    .await?;
    let food_days: std::collections::HashSet<NaiveDate> =
        typed.iter().filter(|(c, _, _)| food.is_some_and(|f| f.contains(c))).map(|(_, d, _)| *d).collect();
    let mut pool: HashMap<(Uuid, NaiveDate, i64), usize> = HashMap::new();
    for (c, d, a) in &typed {
        *pool.entry((*c, *d, cents(*a))).or_default() += 1;
    }
    let (mut expenses_in_app, mut expenses_in_app_amount) = (0usize, 0.0f64);
    spent.retain(|(c, d, _, a)| {
        // The book's meals of the day, split or whole, when the app has that day's meals.
        let meal = food.is_some_and(|f| f.contains(c)) || *c == category_ids["ماکولات"];
        let left_out = if meal && food_days.contains(d) {
            true
        } else if let Some(n) = pool.get_mut(&(*c, *d, cents(*a))).filter(|n| **n > 0) {
            *n -= 1;
            true
        } else {
            false
        };
        if left_out {
            expenses_in_app += 1;
            expenses_in_app_amount += a;
        }
        !left_out
    });
    let ex: (i64, i64, i64) = sqlx::query_as(
        r#"
        WITH n AS (SELECT x.*, row_number() OVER (PARTITION BY x.category, x.day, x.note, x.amount) AS k
                   FROM unnest($1::uuid[], $2::date[], $3::text[], $4::numeric[]) AS x(category, day, note, amount)),
             o AS (SELECT e.id, e.category_id AS c, e.spent_on AS d, e.description AS t, e.amount AS a,
                          row_number() OVER (PARTITION BY e.category_id, e.spent_on, e.description, e.amount ORDER BY e.created_at, e.id) AS k
                   FROM expenses e WHERE e.import_batch_id = $5 AND e.deleted_at IS NULL),
             gone AS (DELETE FROM expenses WHERE id IN (
                          SELECT o.id FROM o WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.category = o.c AND n.day = o.d
                              AND n.note IS NOT DISTINCT FROM o.t AND n.amount = o.a AND n.k = o.k))
                      RETURNING 1),
             added AS (INSERT INTO expenses (id, department, category_id, spent_on, description, amount, import_batch_id)
                       SELECT gen_random_uuid(), 'hall', n.category, n.day, n.note, n.amount, $5 FROM n
                       WHERE NOT EXISTS (SELECT 1 FROM o WHERE n.category = o.c AND n.day = o.d
                              AND n.note IS NOT DISTINCT FROM o.t AND n.amount = o.a AND n.k = o.k)
                       RETURNING 1)
        SELECT (SELECT count(*) FROM o), (SELECT count(*) FROM gone), (SELECT count(*) FROM added)
        "#,
    )
    .bind(spent.iter().map(|x| x.0).collect::<Vec<_>>())
    .bind(spent.iter().map(|x| x.1).collect::<Vec<_>>())
    .bind(spent.iter().map(|x| x.2.clone()).collect::<Vec<_>>())
    .bind(spent.iter().map(|x| x.3).collect::<Vec<f64>>())
    .bind(batch)
    .fetch_one(&mut *db)
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
    let typed: Vec<(Uuid, NaiveDate, f64)> = sqlx::query_as(
        "SELECT staff_id, taken_on, amount::float8 FROM withdrawals \
         WHERE import_batch_id IS NULL AND deleted_at IS NULL AND taken_on BETWEEN $1 AND $2",
    )
    .bind(lo)
    .bind(hi)
    .fetch_all(&mut *db)
    .await?;
    let mut pool: HashMap<(Uuid, NaiveDate, i64), usize> = HashMap::new();
    for (s, d, a) in &typed {
        *pool.entry((*s, *d, cents(*a))).or_default() += 1;
    }
    let mut withdrawals_in_app = 0usize;
    let taken: Vec<_> = dated
        .iter()
        .filter(|(e, _)| e.kind == Kind::Withdrawal)
        .filter(|(e, d)| match pool.get_mut(&(partner_ids[e.key], *d, cents(e.amount))).filter(|n| **n > 0) {
            Some(n) => {
                *n -= 1;
                withdrawals_in_app += 1;
                false
            }
            None => true,
        })
        .collect();
    let wd: (i64, i64, i64) = sqlx::query_as(
        r#"
        WITH n AS (SELECT w.*, row_number() OVER (PARTITION BY w.staff, w.day, w.amount, w.note) AS k
                   FROM unnest($1::uuid[], $2::date[], $3::numeric[], $4::text[]) AS w(staff, day, amount, note)),
             o AS (SELECT x.id, x.staff_id AS s, x.taken_on AS d, x.amount AS a, x.note AS t,
                          row_number() OVER (PARTITION BY x.staff_id, x.taken_on, x.amount, x.note ORDER BY x.created_at, x.id) AS k
                   FROM withdrawals x WHERE x.import_batch_id = $5 AND x.deleted_at IS NULL),
             gone AS (DELETE FROM withdrawals WHERE id IN (
                          SELECT o.id FROM o WHERE NOT EXISTS (SELECT 1 FROM n WHERE n.staff = o.s AND n.day = o.d AND n.amount = o.a
                              AND n.note IS NOT DISTINCT FROM o.t AND n.k = o.k))
                      RETURNING 1),
             added AS (INSERT INTO withdrawals (id, staff_id, department, taken_on, amount, note, import_batch_id)
                       SELECT gen_random_uuid(), n.staff, 'hall', n.day, n.amount, n.note, $5 FROM n
                       WHERE NOT EXISTS (SELECT 1 FROM o WHERE n.staff = o.s AND n.day = o.d AND n.amount = o.a
                              AND n.note IS NOT DISTINCT FROM o.t AND n.k = o.k)
                       RETURNING 1)
        SELECT (SELECT count(*) FROM o), (SELECT count(*) FROM gone), (SELECT count(*) FROM added)
        "#,
    )
    .bind(taken.iter().map(|(e, _)| partner_ids[e.key]).collect::<Vec<_>>())
    .bind(taken.iter().map(|(_, d)| *d).collect::<Vec<_>>())
    .bind(taken.iter().map(|(e, _)| e.amount).collect::<Vec<f64>>())
    .bind(taken.iter().map(|(e, _)| note(e)).collect::<Vec<_>>())
    .bind(batch)
    .fetch_one(&mut *db)
    .await?;
    let (rows_before, rows_removed, rows_added) = (rx.0 + ex.0 + wd.0, rx.1 + ex.1 + wd.1, rx.2 + ex.2 + wd.2);

    let hotspot = store_hotspot(db, year, batch, short, &hot_buys, &hot_sales, &hot_stock, &stated, &sheet_month, &mut warnings).await?;

    // Month-by-month totals next to the statement sheet.
    let mut lines: Vec<LineReport> = LINES
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

    // A month whose hotspot income is the sheet's profit has it in the day's receipts.
    for l in lines.iter_mut().filter(|l| l.key == "hotspot") {
        for (i, m) in hotspot.months.iter().enumerate().filter(|(_, m)| m.from_sheet) {
            l.imported[i] += m.income;
        }
    }
    for (i, m) in hotspot.months.iter().enumerate().filter(|(_, m)| m.from_sheet) {
        if let Some(v) = m.statement.filter(|v| *v != 0.0 && (v - m.profit).abs() >= 1.0) {
            warnings.push(format!(
                "هات‌اسپات {}: در «محاسبات» {v} دستی نوشته شده، ولی سود فروش همان ماه در شیت هات‌اسپات {} است. مثل فرمول بقیهٔ ماه‌ها، سود شیت حساب شد.",
                MONTHS[i], m.profit
            ));
        }
    }

    let loans = store_loans(db, &deposits, &loans, &mut warnings).await?;
    let (fees_exact, fees_counted) = date_excel_fees(db).await?;

    let report = Report {
        year,
        committed: p.commit,
        batch_id: p.commit.then_some(batch),
        members: members.len(),
        members_new,
        receipts: income.len(),
        rows_kept: rows_before - rows_removed,
        rows_removed,
        rows_added,
        in_app: in_app_count,
        in_app_amount,
        fees_exact,
        fees_counted,
        food_split,
        food_whole,
        expenses_in_app,
        expenses_in_app_amount,
        withdrawals_in_app,
        loans,
        expenses: spent.len(),
        withdrawals: taken.len(),
        replaces,
        lines,
        hotspot,
        clashes,
        warnings,
    };
    sqlx::query("UPDATE import_batches SET summary = $2 WHERE id = $1")
        .bind(batch)
        .bind(serde_json::json!({
            "members": report.members, "members_new": report.members_new, "receipts": report.receipts,
            "expenses": report.expenses, "withdrawals": report.withdrawals, "warnings": report.warnings.len(),
            "clashes": report.clashes.len(),
            "rows_kept": report.rows_kept, "rows_removed": report.rows_removed, "rows_added": report.rows_added,
        }))
        .execute(&mut *db)
        .await?;
    // The import's one line in «چه کسی چه کرد».
    sqlx::query("SELECT set_config('pezhohesh.bulk', 'off', true)").execute(&mut *db).await?;
    sqlx::query(
        "INSERT INTO audit_log (user_id, table_name, row_id, action, after) \
         SELECT nullif(current_setting('app.user_id', true), '')::uuid, 'import_batches', $1, 'import', summary FROM import_batches WHERE id = $1",
    )
    .bind(batch)
    .execute(&mut *db)
    .await?;
    Ok(report)
}

/// The guarantees and the books out, from the book's two loan sheets. Run again with a newer
/// book it adds what is new and marks what came back; what the app already has stays. The
/// fees are not income here: the statement's «امانت دهی کتاب» line already counts them.
/// Money compared to the cent, as a key.
fn cents(a: f64) -> i64 {
    (a * 100.0).round() as i64
}

/// The app's breakfast, lunch and dinner lines, when it has all three.
async fn food_categories(db: &mut PgConnection, warnings: &mut Vec<String>) -> Result<Option<[Uuid; 3]>, ApiError> {
    let rows: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM expense_categories WHERE department = 'hall' AND deleted_at IS NULL").fetch_all(&mut *db).await?;
    let find = |names: &[&str]| rows.iter().find(|(_, n)| names.contains(&n.trim())).map(|(id, _)| *id);
    let found = [find(&["صبحانه", "صبح"]), find(&["چاشت"]), find(&["شام", "شب"])];
    match found {
        [Some(a), Some(b), Some(c)] => Ok(Some([a, b, c])),
        [None, None, None] => Ok(None),
        _ => {
            warnings.push("برای جدا کردن ماکولات، سه سطر مصرف «صبحانه»، «چاشت» و «شام» (یا «شب») لازم است؛ ماکولات یک‌جا ماند.".into());
            Ok(None)
        }
    }
}

/// A day's meals cell split into breakfast, lunch and dinner: «20صبحانه+چاشت60+ 40شام»,
/// each part one meal and its amount (before or after the word, any digits). None when a part
/// is not a meal or has two numbers, or when the parts do not add up to the cell's amount.
fn meals(text: &str, amount: f64) -> Option<[f64; 3]> {
    let text: String = text
        .chars()
        .map(|c| match c {
            '۰'..='۹' => char::from_digit(c as u32 - '۰' as u32, 10).unwrap_or(c),
            '٠'..='٩' => char::from_digit(c as u32 - '٠' as u32, 10).unwrap_or(c),
            _ => c,
        })
        .collect();
    let mut out = [0.0; 3];
    let mut any = false;
    for part in text.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let k = if part.contains("صب") || part.contains("صیح") {
            0
        } else if part.contains("چاش") {
            1
        } else if part.contains("شام") || part.contains("شب") || part.contains("شا") {
            2
        } else {
            return None;
        };
        let numbers: Vec<f64> = part
            .split(|c: char| !(c.is_ascii_digit() || c == '.'))
            .filter(|n| !n.is_empty())
            .map(|n| n.parse::<f64>())
            .collect::<Result<_, _>>()
            .ok()?;
        if numbers.len() > 1 {
            return None;
        }
        out[k] += numbers.first().copied().unwrap_or(0.0);
        any = true;
    }
    (any && (out.iter().sum::<f64>() - amount).abs() < 0.005).then_some(out)
}

async fn store_loans(db: &mut PgConnection, deposits: &[DepositRow], loans: &[LoanRow], warnings: &mut Vec<String>) -> Result<LoanReport, ApiError> {
    let mut out = LoanReport::default();
    for d in deposits {
        let held: Option<(Uuid, String, Option<NaiveDate>, NaiveDate)> = sqlx::query_as(
            "SELECT id, name, returned_on, received_on FROM loan_deposits WHERE lower(code) = $1 ORDER BY deleted_at NULLS FIRST LIMIT 1",
        )
        .bind(&d.code)
        .fetch_optional(&mut *db)
        .await?;
        match held {
            None => {
                sqlx::query(
                    "INSERT INTO loan_deposits (id, code, kind, name, father_name, phone, amount, deposit_book, guarantor, note, received_on, returned_on) \
                     VALUES ($1, $2, $3::deposit_kind, $4, $5, $6, $7, $8, $9, $10, $11, $12)",
                )
                .bind(Uuid::new_v4())
                .bind(&d.code)
                .bind(d.kind)
                .bind(&d.name)
                .bind(&d.father)
                .bind(&d.phone)
                .bind(if d.kind == "cash" { d.amount } else { None })
                .bind(if d.kind == "book" { d.guarantee.clone() } else { None })
                .bind(if d.kind == "person" { d.guarantee.clone() } else { None })
                .bind(&d.note)
                .bind(d.on)
                // The day it went back is not in the book.
                .bind(d.returned.then_some(d.on))
                .execute(&mut *db)
                .await?;
                out.deposits_new += 1;
            }
            Some((_, name, _, _)) if !same_name(&name, &d.name) => {
                warnings.push(format!("کارت {} در برنامه به نام «{name}» است و در اکسل «{}»؛ کارت برنامه ماند.", d.code, d.name));
            }
            Some((id, _, None, received)) if d.returned => {
                let open: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM book_loans WHERE deposit_id = $1 AND returned_on IS NULL AND deleted_at IS NULL)")
                    .bind(id)
                    .fetch_one(&mut *db)
                    .await?;
                if !open {
                    sqlx::query("UPDATE loan_deposits SET returned_on = $2 WHERE id = $1").bind(id).bind(received).execute(&mut *db).await?;
                    out.deposits_returned += 1;
                }
            }
            Some(_) => {}
        }
    }

    let rules = crate::books::rules_of(db).await?;
    let today = crate::hall::today();
    let cards: Vec<(Uuid, String, Option<String>, NaiveDate, Option<NaiveDate>)> =
        sqlx::query_as("SELECT id, name, father_name, received_on, returned_on FROM loan_deposits WHERE deleted_at IS NULL")
            .fetch_all(&mut *db)
            .await?;
    let people: Vec<(Uuid, String, Option<String>)> =
        sqlx::query_as("SELECT id, trim(concat_ws(' ', first_name, last_name)), father_name FROM members WHERE deleted_at IS NULL")
            .fetch_all(&mut *db)
            .await?;
    let same_father = |a: &Option<String>, b: &Option<String>| match (a, b) {
        (Some(a), Some(b)) => same_name(a, b),
        _ => false,
    };
    for l in loans {
        let held: Option<(Uuid, Option<NaiveDate>)> = sqlx::query_as(
            "SELECT id, returned_on FROM book_loans WHERE lower(book_title) = lower($1) AND loaned_on = $2 ORDER BY deleted_at NULLS FIRST LIMIT 1",
        )
        .bind(&l.title)
        .bind(l.on)
        .fetch_optional(&mut *db)
        .await?;
        // Whose card: the ID when it is a card or a member of that name, else the same name
        // and father on a card, else on a member.
        let mut deposit: Option<Uuid> = None;
        let mut member: Option<Uuid> = None;
        let mut card_back: Option<NaiveDate> = None;
        if let Some(id) = &l.id {
            if id.contains('-') {
                let found: Option<(Uuid, Option<NaiveDate>)> = sqlx::query_as("SELECT id, returned_on FROM loan_deposits WHERE lower(code) = lower($1) AND deleted_at IS NULL")
                    .bind(id)
                    .fetch_optional(&mut *db)
                    .await?;
                if let Some((d, back)) = found {
                    deposit = Some(d);
                    card_back = back;
                }
            } else if let Ok(no) = id.parse::<i32>() {
                let found: Option<(Uuid, String)> = sqlx::query_as("SELECT id, trim(concat_ws(' ', first_name, last_name)) FROM members WHERE member_no = $1 AND deleted_at IS NULL")
                    .bind(no)
                    .fetch_optional(&mut *db)
                    .await?;
                member = found.filter(|(_, name)| same_name(name, &l.name)).map(|(m, _)| m);
            }
        }
        if deposit.is_none() && member.is_none() {
            let card = cards
                .iter()
                .filter(|c| same_name(&c.1, &l.name) && (l.father.is_none() || c.2.is_none() || same_father(&c.2, &l.father)))
                .max_by_key(|c| (c.3 <= l.on, c.3));
            if let Some(c) = card {
                deposit = Some(c.0);
                card_back = c.4;
            } else {
                let found: Vec<&(Uuid, String, Option<String>)> =
                    people.iter().filter(|p| same_name(&p.1, &l.name) && same_father(&p.2, &l.father)).collect();
                if let [one] = found.as_slice() {
                    member = Some(one.0);
                }
            }
        }
        // The formula still counting means out; a fee with no formula means it came back and
        // was paid; nothing at all says nothing, so it is taken as out. A card that went back
        // has no book out.
        let out_now = (l.counting || l.fee.is_none()) && card_back.is_none();
        let back = (!out_now).then(|| {
            let weeks = match (l.fee, rules.weekly_fee > 0.0) {
                (Some(fee), true) => (fee / rules.weekly_fee).ceil() as u64,
                _ => 0,
            };
            (l.on + Days::new(weeks * 7)).min(today).max(l.on)
        });
        match held {
            Some((id, None)) => {
                if let Some(on) = back {
                    sqlx::query("UPDATE book_loans SET returned_on = $2, fee_paid = GREATEST(fee_paid, $3) WHERE id = $1")
                        .bind(id)
                        .bind(on)
                        .bind(l.fee.unwrap_or(0.0))
                        .execute(&mut *db)
                        .await?;
                    out.loans_returned += 1;
                }
                continue;
            }
            Some(_) => continue,
            None => {}
        }
        if deposit.is_none() && member.is_none() {
            // The app needs a card for a loan; the book names nobody's. A card that says so.
            sqlx::query("SELECT pg_advisory_xact_lock(hashtext('loan_deposits.code'))").execute(&mut *db).await?;
            let last: Option<i32> = sqlx::query_scalar("SELECT max(substring(code FROM 3)::int) FROM loan_deposits WHERE lower(left(code, 2)) = 'z-' AND substring(code FROM 3) ~ '^[0-9]{1,6}$'")
                .fetch_one(&mut *db)
                .await?;
            let code = format!("z-{}", last.map_or(101, |n| n + 1));
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO loan_deposits (id, code, kind, name, father_name, guarantor, note, received_on) \
                 VALUES ($1, $2, 'person', $3, $4, 'نامعلوم', 'از لیست امانت اکسل؛ کارت ضمانتش در اکسل نبود', $5)",
            )
            .bind(id)
            .bind(&code)
            .bind(&l.name)
            .bind(&l.father)
            .bind(l.on)
            .execute(&mut *db)
            .await?;
            deposit = Some(id);
            out.no_card.push(format!("{} ({code})", l.name));
        }
        let book_id: Option<Uuid> = sqlx::query_scalar("SELECT id FROM books WHERE deleted_at IS NULL AND lower(trim(title)) = lower($1) LIMIT 1")
            .bind(&l.title)
            .fetch_optional(&mut *db)
            .await?;
        let note = match (&l.note, l.fee.filter(|_| out_now)) {
            (Some(n), Some(f)) => Some(format!("{n}؛ {f} افغانی فیس در اکسل گرفته شده")),
            (None, Some(f)) => Some(format!("{f} افغانی فیس در اکسل گرفته شده")),
            (n, None) => n.clone(),
        };
        sqlx::query(
            "INSERT INTO book_loans (id, member_id, deposit_id, book_id, book_title, loaned_on, due_on, returned_on, weekly_fee, fee_paid, note) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(Uuid::new_v4())
        .bind(member)
        .bind(if member.is_some() { None } else { deposit })
        .bind(book_id)
        .bind(&l.title)
        .bind(l.on)
        .bind(l.on + Days::new(rules.loan_days as u64))
        .bind(back)
        .bind(rules.weekly_fee)
        .bind(l.fee.unwrap_or(0.0))
        .bind(note)
        .execute(&mut *db)
        .await?;
        out.loans_new += 1;
        if out_now {
            out.loans_out += 1;
        }
        // A returned card's day is at least the day its book came back.
        if let (Some(on), Some(d)) = (back, deposit.filter(|_| card_back.is_some())) {
            sqlx::query("UPDATE loan_deposits SET returned_on = GREATEST(returned_on, $2) WHERE id = $1").bind(d).bind(on).execute(&mut *db).await?;
        }
    }
    Ok(out)
}

/// The day an Excel fee of the month `from`..=`to` was paid, from the first days of the
/// member's periods (which come from the device). (day, exact): a period starting in that
/// month gives its day. The device keeps only a member's last dates, so for another month the
/// day is counted back or on from the nearest period in steps of a 30-day month, not exact.
/// None: no period, or the count falls outside the month (a month skipped).
pub(crate) fn fee_day(starts: &[NaiveDate], from: NaiveDate, to: NaiveDate) -> Option<(NaiveDate, bool)> {
    if let Some(d) = starts.iter().filter(|d| **d >= from && **d <= to).min() {
        return Some((*d, true));
    }
    let gap = |d: &NaiveDate| if *d > to { (*d - to).num_days() } else { (from - *d).num_days() };
    let near = starts.iter().min_by_key(|d| gap(d))?;
    let steps = (gap(near) + 29) / 30;
    let d = if *near > to { *near - chrono::Duration::days(30 * steps) } else { *near + chrono::Duration::days(30 * steps) };
    (d >= from && d <= to).then_some((d, false))
}

/// Dates every member's Excel fee by `fee_day`, inside its own month, so the monthly totals
/// never change; with nothing to go on it stays on the first of the month. Never after today.
pub(crate) async fn date_excel_fees(db: &mut PgConnection) -> Result<(usize, usize), ApiError> {
    let cells: Vec<(Uuid, Uuid, String, NaiveDate, NaiveDate, NaiveDate)> = sqlx::query_as(
        "SELECT x.receipt_id, x.member_id, x.kind::text, x.month_start, x.month_end, r.issued_on \
         FROM v_excel_months x JOIN receipts r ON r.id = x.receipt_id WHERE x.member_id IS NOT NULL",
    )
    .fetch_all(&mut *db)
    .await?;
    let periods: Vec<(Uuid, String, NaiveDate)> = sqlx::query_as(
        "SELECT ms.member_id, p.kind::text, ms.start_date FROM memberships ms JOIN plans p ON p.id = ms.plan_id \
         WHERE ms.deleted_at IS NULL AND ms.member_id IS NOT NULL AND p.kind::text IN ('monthly', 'internet')",
    )
    .fetch_all(&mut *db)
    .await?;
    let mut starts: HashMap<(Uuid, String), Vec<NaiveDate>> = HashMap::new();
    for (m, k, d) in periods {
        starts.entry((m, k)).or_default().push(d);
    }
    let today = crate::hall::today();
    let (mut exact, mut counted) = (0, 0);
    let (mut ids, mut days): (Vec<Uuid>, Vec<NaiveDate>) = (Vec::new(), Vec::new());
    for (id, member, kind, from, to, now) in cells {
        let found = starts.get(&(member, kind)).and_then(|s| fee_day(s, from, to));
        match found {
            Some((d, true)) if d <= today => exact += 1,
            Some((d, false)) if d <= today => counted += 1,
            _ => {}
        }
        // A day counted past today is not known yet: the fee stays on its month's first day
        // (moving it to today piled a month's fees on the day of the import).
        let day = found.map(|(d, _)| d).filter(|d| *d <= today).unwrap_or(from).max(from);
        if day != now {
            ids.push(id);
            days.push(day);
        }
    }
    sqlx::query("UPDATE receipts r SET issued_on = x.day FROM unnest($1::uuid[], $2::date[]) AS x(id, day) WHERE r.id = x.id")
        .bind(&ids)
        .bind(&days)
        .execute(&mut *db)
        .await?;
    Ok((exact, counted))
}

#[derive(Deserialize)]
pub struct ExcelCell {
    kind: String,
    year: i32,
    month: u32,
    amount: f64,
}

/// PUT /api/v1/members/:id/excel-month (partners): corrects one month's money of a member's
/// row of the book. 0 takes it out. It is income like the rest, so every report follows; the
/// audit log keeps the old figure. Importing the book again brings the book's figure back.
pub async fn set_excel_month(
    State(s): State<AppState>,
    user: CurrentUser,
    Path(id): Path<Uuid>,
    Json(b): Json<ExcelCell>,
) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    if !matches!(b.kind.as_str(), "monthly" | "internet") || !b.amount.is_finite() || b.amount < 0.0 {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    set_cell(&mut tx, id, &b).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn set_cell(tx: &mut PgConnection, id: Uuid, b: &ExcelCell) -> Result<(), ApiError> {
    let day = (1..=12).contains(&b.month).then(|| solar::to_gregorian(b.year, b.month, 1)).flatten().ok_or(ApiError::bad("bad_month"))?;
    let (who, no): (String, i32) = sqlx::query_as("SELECT trim(concat_ws(' ', first_name, last_name)), member_no FROM members WHERE id = $1 AND deleted_at IS NULL")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(ApiError(StatusCode::NOT_FOUND, "not_found"))?;
    let cells: Vec<Uuid> = sqlx::query_scalar("SELECT receipt_id FROM v_excel_months WHERE member_id = $1 AND kind = $2 AND year = $3 AND month = $4 ORDER BY receipt_id")
        .bind(id)
        .bind(&b.kind)
        .bind(b.year)
        .bind(b.month as i32)
        .fetch_all(&mut *tx)
        .await?;
    let keep = if b.amount > 0.0 { cells.first().copied() } else { None };
    if let Some(cell) = keep {
        sqlx::query("UPDATE receipts SET amount = $2 WHERE id = $1").bind(cell).bind(b.amount).execute(&mut *tx).await?;
    } else if b.amount > 0.0 {
        let batch: Uuid = sqlx::query_scalar("SELECT id FROM import_batches WHERE source = $1 AND solar_year = $2 AND replaced_at IS NULL ORDER BY imported_at DESC LIMIT 1")
            .bind(SOURCE)
            .bind(b.year)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(ApiError::bad("no_excel_year"))?;
        let label = if b.kind == "internet" { "انترنت ماهانه" } else { "عضویت ماهانه" };
        let id_new = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category, description, member_id, import_batch_id) \
             VALUES ($1, $2, 'hall', $3, $4, $5, $6, $7, $8)",
        )
        .bind(id_new)
        .bind(format!("XL{}-E{}", b.year, &id_new.simple().to_string()[..8]))
        .bind(day)
        .bind(b.amount)
        .bind(&b.kind)
        .bind(format!("{label} · {who} · شمارهٔ {no} (اکسل {})", b.year))
        .bind(id)
        .bind(batch)
        .execute(&mut *tx)
        .await?;
    }
    for cell in cells.iter().filter(|c| Some(**c) != keep) {
        sqlx::query("UPDATE receipts SET deleted_at = now() WHERE id = $1").bind(cell).execute(&mut *tx).await?;
    }
    Ok(())
}

/// The hotspot sheet's supplier bills and daily counts, as the app keeps its own: a bill
/// with its cards per volume, and the cards sold each day at the card prices. Months whose
/// income comes from the sheet get a receipt per day for its profit, as the desk's count.
#[allow(clippy::too_many_arguments)]
async fn store_hotspot(
    db: &mut PgConnection,
    year: i32,
    batch: Uuid,
    short: &str,
    buys: &[HotBuy],
    sales: &[HotSale],
    stock: &BTreeMap<u32, Vec<(f64, i32)>>,
    stated: &[Option<f64>; 12],
    sheet_month: &(dyn Fn(u32) -> bool + Sync),
    warnings: &mut Vec<String>,
) -> Result<HotReport, ApiError> {
    let mut report = HotReport { buys: buys.len(), counts: sales.len(), ..Default::default() };
    for (i, m) in report.months.iter_mut().enumerate() {
        m.statement = stated[i];
    }
    let mut warn = |w: String| {
        if warnings.len() < MAX_WARNINGS {
            warnings.push(w);
        }
    };
    let prices: HashMap<String, f64> = sqlx::query_as::<_, (f64, f64)>("SELECT volume_gb::float8, price::float8 FROM hotspot_cards")
        .fetch_all(&mut *db)
        .await?
        .into_iter()
        .map(|(v, p)| (v.to_string(), p))
        .collect();
    let per_gb_setting: f64 = sqlx::query_scalar(
        "SELECT COALESCE((SELECT (value #>> '{}')::float8 FROM settings WHERE key = 'hotspot_cost_per_gb'), 10)",
    )
    .fetch_one(&mut *db)
    .await?;
    let day = |m: u32, on: Option<NaiveDate>| on.unwrap_or_else(|| solar::to_gregorian(year, m, 1).expect("valid Solar date"));
    let tag = format!("(اکسل {year})");

    for b in buys {
        let gb: f64 = b.cards.iter().map(|(v, n)| v * *n as f64).sum();
        // The sheet's amount is the cards' GB at the price per GB, plus the extra costs.
        let per_gb = if gb > 0.0 && b.total > b.extra_cost { (b.total - b.extra_cost) / gb } else { per_gb_setting };
        let id = Uuid::new_v4();
        let on = day(b.month, b.on);
        sqlx::query(
            "INSERT INTO hotspot_buys (id, purchased_on, supplier_bill_no, bill_gb, extra_cost, note, import_batch_id) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(id)
        .bind(on)
        .bind(&b.bill_no)
        .bind(b.bill_gb)
        .bind(b.extra_cost)
        .bind(&tag)
        .bind(batch)
        .execute(&mut *db)
        .await?;
        for &(v, n) in &b.cards {
            if !prices.contains_key(&v.to_string()) {
                warn(format!("هاتسپات، {}: کارت {v}GB در فهرست کارت‌ها نیست و وارد نشد.", MONTHS[b.month as usize - 1]));
                continue;
            }
            sqlx::query(
                "INSERT INTO hotspot_purchases (id, buy_id, purchased_on, supplier_bill_no, volume_gb, quantity, unit_cost, import_batch_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(Uuid::new_v4())
            .bind(id)
            .bind(on)
            .bind(&b.bill_no)
            .bind(v)
            .bind(n)
            .bind((v * per_gb * 100.0).round() / 100.0)
            .bind(batch)
            .execute(&mut *db)
            .await?;
        }
        let m = &mut report.months[b.month as usize - 1];
        m.cards_bought += b.cards.iter().map(|(_, n)| *n as i64).sum::<i64>();
        m.gb_bought += gb;
        m.bought += b.total;
    }

    for (i, x) in sales.iter().enumerate() {
        let on = day(x.month, x.on);
        let mut priced = 0.0;
        let mut cost = 0.0;
        let mut what = Vec::new();
        for &(v, n) in &x.cards {
            priced += prices.get(&v.to_string()).copied().unwrap_or(0.0) * n as f64;
            cost += v * per_gb_setting * n as f64;
            what.push(format!("{n} کارت {v}GB"));
        }
        if (priced - x.amount).abs() > 0.5 {
            warn(format!(
                "هاتسپات، {} {}: فروش در اکسل {} است ولی با قیمت کارت‌ها {} می‌شود؛ عدد اکسل نگه داشته شد.",
                solar::month_day(on).1,
                MONTHS[solar::month_day(on).0 as usize - 1],
                x.amount,
                priced
            ));
        }
        let from_sheet = sheet_month(x.month);
        let receipt: Option<Uuid> = if from_sheet && x.profit > 0.0 {
            let id = Uuid::new_v4();
            sqlx::query(
                "INSERT INTO receipts (id, receipt_no, department, issued_on, amount, income_category, description, import_batch_id) \
                 VALUES ($1, $2, 'hall', $3, $4, 'hotspot', $5, $6)",
            )
            .bind(id)
            .bind(format!("XL{year}-{short}-H{:04}", i + 1))
            .bind(on)
            .bind(x.profit)
            .bind(format!("فروش کارت هاتسپات: {} · فروش {}، سود {} {tag}", what.join("، "), x.amount, x.profit))
            .bind(batch)
            .execute(&mut *db)
            .await?;
            Some(id)
        } else {
            None
        };
        // The sheet's sales and profit stand; the cards' prices and costs are spread to match.
        let scale_price = if priced > 0.0 { x.amount / priced } else { 1.0 };
        let scale_cost = if cost > 0.0 { (x.amount - x.profit) / cost } else { 1.0 };
        for &(v, n) in &x.cards {
            let Some(price) = prices.get(&v.to_string()) else { continue };
            sqlx::query(
                "INSERT INTO hotspot_sales (id, sold_on, volume_gb, quantity, unit_price, unit_cost, receipt_id, import_batch_id) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .bind(Uuid::new_v4())
            .bind(on)
            .bind(v)
            .bind(n)
            .bind((price * scale_price * 100.0).round() / 100.0)
            .bind((v * per_gb_setting * scale_cost * 100.0).round() / 100.0)
            .bind(receipt)
            .bind(batch)
            .execute(&mut *db)
            .await?;
        }
        let m = &mut report.months[x.month as usize - 1];
        m.cards_sold += x.cards.iter().map(|(_, n)| *n as i64).sum::<i64>();
        m.gb_sold += x.cards.iter().map(|(v, n)| v * *n as f64).sum::<f64>();
        m.sales += x.amount;
        m.profit += x.profit;
    }
    for (i, m) in report.months.iter_mut().enumerate() {
        m.from_sheet = sheet_month(i as u32 + 1);
        m.income = if m.from_sheet { m.profit } else { m.statement.unwrap_or(0.0) };
    }

    // The cards in hand at the end of each month, against the sheet's «کارت های موجود».
    for (&month, listed) in stock {
        let mut held: BTreeMap<String, i64> = BTreeMap::new();
        for b in buys.iter().filter(|b| b.month <= month) {
            for &(v, n) in &b.cards {
                *held.entry(v.to_string()).or_default() += n as i64;
            }
        }
        for x in sales.iter().filter(|x| x.month <= month) {
            for &(v, n) in &x.cards {
                *held.entry(v.to_string()).or_default() -= n as i64;
            }
        }
        let mut off = Vec::new();
        for (v, n) in &held {
            let want = listed.iter().find(|(lv, _)| lv.to_string() == *v).map(|(_, c)| *c as i64).unwrap_or(0);
            if *n != want {
                off.push(format!("{v}GB: برنامه {n}، اکسل {want}"));
            }
        }
        if !off.is_empty() {
            warn(format!("هاتسپات، آخر {}: کارت‌های موجود با اکسل فرق دارد ({}).", MONTHS[month as usize - 1], off.join("، ")));
        }
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meals_split() {
        assert_eq!(meals("20صبحانه+چاشت80+ 10شام", 110.0), Some([20.0, 80.0, 10.0]));
        assert_eq!(meals("صبحانه30+چاشت180+شب", 210.0), Some([30.0, 180.0, 0.0]));
        assert_eq!(meals("30صبحانه+ چاشت120", 150.0), Some([30.0, 120.0, 0.0]));
        assert_eq!(meals("صبجانه30+چاشت60+شب50", 140.0), Some([30.0, 60.0, 50.0]));
        assert_eq!(meals("20صبحانه+چاشت200+ شا170", 390.0), Some([20.0, 200.0, 170.0]));
        assert_eq!(meals("۲۰صبحانه+چاشت۶۰", 80.0), Some([20.0, 60.0, 0.0]));
        // Does not add up, or has other things in it: left whole.
        assert_eq!(meals("صبحانه80+چاشت60+شام", 130.0), None);
        assert_eq!(meals("تانکر آب+ کرایه موتر60+چاشت 80", 310.0), None);
        assert_eq!(meals("50صبحانه+چاشت 120+80انرژی", 250.0), None);
    }

    fn person(no: i32, name: Option<&str>, row: usize) -> Member {
        Member {
            no,
            name: name.map(String::from),
            father: Some(format!("پدر {row}")),
            phone: None,
            field: None,
            tazkira: None,
            rows: vec![("عضویت ماهانه", row)],
        }
    }

    fn paid(person: usize, month: u32) -> Entry {
        Entry { kind: Kind::Income, key: "monthly", month, day: None, amount: 250.0, note: None, person: Some(person) }
    }

    fn app(no: i32, name: &str) -> Held {
        Held {
            id: Uuid::new_v4(),
            member_no: no,
            name: name.into(),
            father_name: None,
            phone: None,
            deleted: false,
            from_excel: true,
            periods: 0,
            bills: 0,
            documents: 0,
        }
    }

    #[test]
    fn an_id_with_another_name_is_not_joined() {
        // The app's 30052 is Zeinab; the book has Abdulrashid under 30052 and Zeinab under 20002.
        let members = vec![person(20002, Some("زینب جعفری"), 7), person(30052, Some("عبدالرشید رحیمی"), 918)];
        let entries = vec![paid(0, 6), paid(1, 1), paid(1, 2)];
        let held = vec![app(30052, "زینب جعفری")];
        let mut w = Vec::new();
        let m = match_members(&members, &entries, &held, &[], &mut w);
        assert_eq!(m.insert, vec![0]);
        assert!(m.fill.is_empty() && m.take.is_empty());
        assert_eq!(m.member[1], None, "Abdulrashid's money must not go to Zeinab");
        assert_eq!(m.clashes.len(), 1);
        let c = &m.clashes[0];
        assert_eq!((c.no, c.outcome, c.can_take_excel), (30052, "kept", true));
        assert_eq!(c.excel[0].paid, 500.0);
        assert_eq!(c.excel[0].months, vec!["حمل", "ثور"]);

        // The partner says the book is right: the app's 30052 becomes Abdulrashid.
        let m = match_members(&members, &entries, &held, &[30052], &mut w);
        assert_eq!(m.take, vec![(held[0].id, 1)]);
        assert_eq!(m.member[1], Some(held[0].id));
        assert_eq!(m.clashes[0].outcome, "excel");
    }

    #[test]
    fn two_people_under_one_id_in_the_book() {
        let members = vec![person(30052, Some("زینب جعفری"), 7), person(30052, Some("عبدالرشید رحیمی"), 918)];
        let mut w = Vec::new();
        let m = match_members(&members, &[], &[], &[30052], &mut w);
        assert!(m.insert.is_empty(), "neither is made a member until the book is fixed");
        assert_eq!((m.clashes[0].outcome, m.clashes[0].can_take_excel, m.clashes[0].excel.len()), ("none", false, 2));

        // One of them is the app's member: that one is joined, the other is the clash.
        let held = vec![app(30052, "زینب جعفری")];
        let m = match_members(&members, &[], &held, &[], &mut w);
        assert_eq!(m.member, vec![Some(held[0].id), None]);
        assert_eq!(m.clashes[0].excel[0].name.as_deref(), Some("عبدالرشید رحیمی"));
        assert!(!m.clashes[0].can_take_excel);
    }

    #[test]
    fn alike_names_and_missing_names() {
        let members = vec![
            person(1, Some("محمد رضا"), 10),
            person(2, Some("مبارکه فراسو"), 11),
            person(3, None, 12),
            person(4, None, 13),
            person(5, Some("Ramazan Nawid"), 14),
        ];
        let held = vec![app(1, "محمد رضا احمدی"), app(2, "بدون نام"), app(3, "حسین"), app(5, "رضا سخایی")];
        let mut w = Vec::new();
        let m = match_members(&members, &[], &held, &[], &mut w);
        // A shortened name is the same person; a member with no name takes the book's.
        assert_eq!(m.fill, vec![(held[0].id, 0), (held[1].id, 1), (held[2].id, 2)]);
        // A row with only a number joins the member who has it, and makes nobody new.
        assert_eq!(m.member[3], None);
        assert!(m.insert.is_empty());
        assert_eq!(w.len(), 1);
        assert_eq!(m.clashes.iter().map(|c| c.no).collect::<Vec<_>>(), vec![5]);
    }

    #[test]
    fn the_sheet_keeps_two_people_of_one_id_apart() {
        let mut rg: Range<Data> = Range::new((0, 0), (4, 3));
        for (c, h) in ["ID", "نام و تخلص", "نام پدر", "حمل"].iter().enumerate() {
            rg.set_value((0, c as u32), Data::String(h.to_string()));
        }
        let rows = [(30052.0, "زینب جعفری", "", 250.0), (20003.0, "جمشید حسین", "", 0.0), (30052.0, "عبدالرشید رحیمی", "ظفرعلی", 250.0), (30052.0, "زینب جعفری", "علی", 300.0)];
        for (r, (id, name, father, fee)) in rows.iter().enumerate() {
            let r = r as u32 + 1;
            rg.set_value((r, 0), Data::Float(*id));
            rg.set_value((r, 1), Data::String(name.to_string()));
            if !father.is_empty() {
                rg.set_value((r, 2), Data::String(father.to_string()));
            }
            rg.set_value((r, 3), Data::Float(*fee));
        }
        let mut book = Book::default();
        read_member_sheet(&mut book, &rg, "عضویت ماهانه", 0, "monthly");
        let names: Vec<_> = book.members.iter().map(|m| (m.no, m.name.clone().unwrap(), m.father.clone())).collect();
        assert_eq!(names, vec![
            (30052, "زینب جعفری".into(), Some("علی".into())),
            (20003, "جمشید حسین".into(), None),
            (30052, "عبدالرشید رحیمی".into(), Some("ظفرعلی".into())),
        ]);
        let people: Vec<_> = book.entries.iter().map(|e| e.person).collect();
        assert_eq!(people, vec![Some(0), Some(2), Some(0)]);
    }
    /// Runs the import's database side on a scratch copy (never the real one):
    /// PZ_SCRATCH_URL=postgres://…/pz_scratch cargo test store_on_a_copy -- --ignored
    #[tokio::test]
    #[ignore]
    async fn store_on_a_copy() {
        let url = std::env::var("PZ_SCRATCH_URL").expect("PZ_SCRATCH_URL");
        assert!(url.ends_with("/pz_scratch"));
        let db = sqlx::PgPool::connect(&url).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        let user: CurrentUser = sqlx::query_as(
            "SELECT u.id, u.staff_id, s.full_name, u.username, u.role::text AS role, u.can_see_pec_finance, u.theme_color, \
                    u.theme_mode::text AS theme_mode, u.must_change_password \
             FROM app_users u JOIN staff s ON s.id = u.staff_id WHERE u.role = 'partner' LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let book = Book {
            members: vec![person(20002, Some("زینب جعفری"), 7), person(30052, Some("عبدالرشید رحیمی"), 918), person(999001, Some("عضو تازه"), 2000)],
            entries: vec![paid(0, 6), paid(1, 1), paid(1, 2), paid(2, 3)],
            ..Default::default()
        };
        let p = Params { year: 1405, commit: false, file_name: None, hotspot_income: None, take_excel: None };
        let r = store(&mut tx, &user, &p, "test", book).await.ok().expect("store");
        assert_eq!(r.clashes.len(), 1);
        assert_eq!(r.clashes[0].app.as_ref().unwrap().name, "زینب جعفری");
        let linked: Vec<(i32, Option<i32>)> = sqlx::query_as(
            "SELECT (r.amount)::int, m.member_no FROM receipts r LEFT JOIN members m ON m.id = r.member_id \
             WHERE r.deleted_at IS NULL AND r.import_batch_id = (SELECT id FROM import_batches WHERE replaced_at IS NULL AND file_sha256 = 'test') \
             ORDER BY r.receipt_no",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        assert_eq!(linked, vec![(250, Some(20002)), (250, None), (250, None), (250, Some(999001))]);
        let father: Option<String> = sqlx::query_scalar("SELECT father_name FROM members WHERE member_no = 999001").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(father.as_deref(), Some("پدر 2000"));

        // «اکسل درست است» for 30052.
        let book = Book {
            members: vec![person(20002, Some("زینب جعفری"), 7), person(30052, Some("عبدالرشید رحیمی"), 918)],
            entries: vec![paid(0, 6), paid(1, 1)],
            ..Default::default()
        };
        let p = Params { year: 1405, commit: false, file_name: None, hotspot_income: None, take_excel: Some("30052".into()) };
        let r = store(&mut tx, &user, &p, "test2", book).await.ok().expect("store");
        assert_eq!(r.clashes[0].outcome, "excel");
        let who: (String, Option<String>) = sqlx::query_as("SELECT first_name, father_name FROM members WHERE member_no = 30052 AND no_freed_at IS NULL")
            .fetch_one(&mut *tx)
            .await
            .unwrap();
        assert_eq!(who.0, "عبدالرشید رحیمی");
        tx.rollback().await.unwrap();
    }

    #[test]
    fn days_in_the_loan_sheets() {
        let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day);
        assert_eq!(any_date(&Data::String("27/11/1401".into())), solar::to_gregorian(1401, 11, 27));
        assert_eq!(any_date(&Data::String("17/5/1402".into())), solar::to_gregorian(1402, 5, 17));
        assert_eq!(any_date(&Data::String("6/5/2024".into())), d(2024, 5, 6));
        assert_eq!(any_date(&Data::String("چند روز".into())), None);
    }

    #[test]
    fn fee_days_from_the_periods() {
        let d = |y, m, day| NaiveDate::from_ymd_opt(y, m, day).unwrap();
        // Mizan 1405 is 2026-09-23 to 2026-10-22, Aqrab from 2026-10-23.
        let (mizan, mizan_end) = (d(2026, 9, 23), d(2026, 10, 22));
        // A period starting in the month: that day, exact.
        assert_eq!(fee_day(&[d(2026, 10, 1)], mizan, mizan_end), Some((d(2026, 10, 1), true)));
        // Only the next month's: counted back 30 days.
        assert_eq!(fee_day(&[d(2026, 11, 3)], mizan, mizan_end), Some((d(2026, 10, 4), false)));
        // Only an earlier month's: counted on.
        assert_eq!(fee_day(&[d(2026, 9, 10)], mizan, mizan_end), Some((d(2026, 10, 10), false)));
        // Nothing to go on.
        assert_eq!(fee_day(&[], mizan, mizan_end), None);
    }

    /// The real book on a scratch copy: PZ_SCRATCH_URL=…/pz_scratch PZ_XL=<book> PZ_XL_PASS=<its
    /// password> cargo test real_book_on_a_copy -- --ignored --nocapture
    #[tokio::test]
    #[ignore]
    async fn real_book_on_a_copy() {
        let url = std::env::var("PZ_SCRATCH_URL").expect("PZ_SCRATCH_URL");
        assert!(url.ends_with("/pz_scratch"));
        let raw = std::fs::read(std::env::var("PZ_XL").unwrap()).unwrap();
        let plain = office_crypto::decrypt_from_bytes(raw, &std::env::var("PZ_XL_PASS").unwrap()).unwrap();
        let book = parse(&plain).ok().expect("parse");
        let db = sqlx::PgPool::connect(&url).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        let user: CurrentUser = sqlx::query_as(
            "SELECT u.id, u.staff_id, s.full_name, u.username, u.role::text AS role, u.can_see_pec_finance, u.theme_color, \
                    u.theme_mode::text AS theme_mode, u.must_change_password \
             FROM app_users u JOIN staff s ON s.id = u.staff_id WHERE u.role = 'partner' LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        let p = Params { year: 1405, commit: false, file_name: None, hotspot_income: None, take_excel: None };
        let total = |t: &'static str| format!("SELECT COALESCE(sum(amount), 0)::float8 FROM receipts WHERE NOT voided AND deleted_at IS NULL AND {t}");
        let r = store(&mut tx, &user, &p, "real", book).await.ok().expect("store");
        println!("loans: new cards {} back {}; new loans {} out {} back {}; no card {:?}", r.loans.deposits_new, r.loans.deposits_returned, r.loans.loans_new, r.loans.loans_out, r.loans.loans_returned, r.loans.no_card);
        println!("fees: exact {} counted {}; receipts {}", r.fees_exact, r.fees_counted, r.receipts);
        println!("food: split {} whole {}; in app: expenses {} ({}), withdrawals {}", r.food_split, r.food_whole, r.expenses_in_app, r.expenses_in_app_amount, r.withdrawals_in_app);
        let rows: Vec<(String, Option<String>, Option<f64>, Option<String>, Option<String>, chrono::NaiveDate, Option<chrono::NaiveDate>)> = sqlx::query_as(
            "SELECT code, kind::text, amount::float8, deposit_book, guarantor, received_on, returned_on FROM loan_deposits WHERE deleted_at IS NULL ORDER BY returned_on IS NULL DESC, code",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        for x in rows.iter().take(12) {
            println!("card {x:?}");
        }
        let held: f64 = sqlx::query_scalar("SELECT COALESCE(sum(amount), 0)::float8 FROM loan_deposits WHERE returned_on IS NULL AND deleted_at IS NULL AND kind = 'cash'").fetch_one(&mut *tx).await.unwrap();
        println!("cash held {held}");
        let out: Vec<(String, chrono::NaiveDate, chrono::NaiveDate, Option<chrono::NaiveDate>, f64, Option<String>)> = sqlx::query_as(
            "SELECT l.book_title, l.loaned_on, l.due_on, l.returned_on, l.fee_paid::float8, COALESCE(d.code, m.member_no::text) \
             FROM book_loans l LEFT JOIN loan_deposits d ON d.id = l.deposit_id LEFT JOIN members m ON m.id = l.member_id ORDER BY loaned_on",
        )
        .fetch_all(&mut *tx)
        .await
        .unwrap();
        for x in &out {
            println!("loan {x:?}");
        }
        // Dating moves a fee inside its month only: every month's Excel total stays the same.
        let by_month: f64 = sqlx::query_scalar(&total("issued_on >= '2026-09-23' AND issued_on < '2026-10-23' AND department = 'hall' AND currency = 'AFN'")).fetch_one(&mut *tx).await.unwrap();
        println!("Mizan income {by_month}");
        // Periods as the device gives them, on every member with a fee in both Mizan and Aqrab.
        let plan: Uuid = sqlx::query_scalar("SELECT id FROM plans WHERE kind = 'monthly' ORDER BY active DESC LIMIT 1").fetch_one(&mut *tx).await.unwrap();
        let both = sqlx::query(
            "INSERT INTO memberships (id, member_id, plan_id, start_date, fee, discount) \
             SELECT gen_random_uuid(), a.member_id, $1, DATE '2026-10-23' + (abs(hashtext(a.member_id::text)) % 13), 0, 0 \
             FROM v_excel_months a JOIN v_excel_months b ON a.member_id = b.member_id AND b.kind = 'monthly' AND b.year = 1405 AND b.month = 7 \
             WHERE a.kind = 'monthly' AND a.year = 1405 AND a.month = 8 \
               AND NOT EXISTS (SELECT 1 FROM memberships x WHERE x.member_id = a.member_id AND x.deleted_at IS NULL)",
        )
        .bind(plan)
        .execute(&mut *tx)
        .await
        .unwrap();
        let (exact, counted) = date_excel_fees(&mut tx).await.ok().expect("dating");
        println!("{} members dated; fees exact {exact} counted {counted}", both.rows_affected());
        assert!(exact > 0 && counted > 0);
        let after: f64 = sqlx::query_scalar(&total("issued_on >= '2026-09-23' AND issued_on < '2026-10-23' AND department = 'hall' AND currency = 'AFN'")).fetch_one(&mut *tx).await.unwrap();
        assert_eq!(by_month, after, "a month's total stays the same");
        let first_14: f64 = sqlx::query_scalar(&total("issued_on >= '2026-09-23' AND issued_on < '2026-10-07' AND department = 'hall' AND currency = 'AFN'")).fetch_one(&mut *tx).await.unwrap();
        println!("Mizan first 14 days now {first_14} of {after}");
        let cells: i64 = sqlx::query_scalar("SELECT count(*) FROM v_excel_months WHERE year = 1405 AND month = 7 AND kind = 'monthly'").fetch_one(&mut *tx).await.unwrap();
        println!("Mizan cells still seen {cells}");
        let outside: i64 = sqlx::query_scalar("SELECT count(*) FROM v_excel_months x JOIN receipts r ON r.id = x.receipt_id WHERE r.issued_on NOT BETWEEN x.month_start AND x.month_end").fetch_one(&mut *tx).await.unwrap();
        assert_eq!(outside, 0);
        // A second run with the same book adds nothing and changes nothing.
        let book = parse(&plain).ok().expect("parse");
        let p = Params { year: 1405, commit: false, file_name: None, hotspot_income: None, take_excel: None };
        let again = match store(&mut tx, &user, &p, "real2", book).await { Ok(r) => r, Err(e) => panic!("store again: {} {}", e.0, e.1) };
        assert_eq!((again.loans.deposits_new, again.loans.loans_new, again.loans.no_card.len()), (0, 0, 0));
        println!("first run: kept {} removed {} added {}; second run: kept {} removed {} added {}", r.rows_kept, r.rows_removed, r.rows_added, again.rows_kept, again.rows_removed, again.rows_added);
        assert_eq!((again.rows_removed, again.rows_added), (0, 0), "the same book again writes nothing");
        let audit: i64 = sqlx::query_scalar("SELECT count(*) FROM audit_log WHERE at > now() - interval '1 hour'").fetch_one(&mut *tx).await.unwrap();
        println!("audit lines written by both runs: {audit}");
        println!("second run: fees exact {} counted {}", again.fees_exact, again.fees_counted);
        tx.rollback().await.unwrap();
    }

    /// A month paid at the desk and written in the book counts once; other months still come in.
    /// A book's cell can then be corrected, added and taken out.
    /// PZ_SCRATCH_URL=postgres://…/pz_scratch cargo test billed_month_on_a_copy -- --ignored
    #[tokio::test]
    #[ignore]
    async fn billed_month_on_a_copy() {
        let url = std::env::var("PZ_SCRATCH_URL").expect("PZ_SCRATCH_URL");
        assert!(url.ends_with("/pz_scratch"));
        let db = sqlx::PgPool::connect(&url).await.unwrap();
        let mut tx = db.begin().await.unwrap();
        let user: CurrentUser = sqlx::query_as(
            "SELECT u.id, u.staff_id, s.full_name, u.username, u.role::text AS role, u.can_see_pec_finance, u.theme_color, \
                    u.theme_mode::text AS theme_mode, u.must_change_password \
             FROM app_users u JOIN staff s ON s.id = u.staff_id WHERE u.role = 'partner' LIMIT 1",
        )
        .fetch_one(&mut *tx)
        .await
        .unwrap();
        // The member, registered at the desk in Aqrab 1405 with a bill.
        let member = Uuid::new_v4();
        sqlx::query("INSERT INTO members (id, member_no, first_name, joined_on) VALUES ($1, 999002, 'عضو دو جایی', '2026-10-25')").bind(member).execute(&mut *tx).await.unwrap();
        let plan: Uuid = sqlx::query_scalar("SELECT id FROM plans WHERE kind = 'monthly' ORDER BY active DESC LIMIT 1").fetch_one(&mut *tx).await.unwrap();
        let period = Uuid::new_v4();
        sqlx::query("INSERT INTO memberships (id, member_id, plan_id, start_date, fee, discount) VALUES ($1, $2, $3, '2026-10-25', 250, 0)")
            .bind(period).bind(member).bind(plan).execute(&mut *tx).await.unwrap();
        sqlx::query("INSERT INTO receipts (id, receipt_no, department, issued_on, amount, membership_id, income_category, description) VALUES ($1, 'T-1', 'hall', '2026-10-25', 250, $2, 'monthly', 'desk')")
            .bind(Uuid::new_v4()).bind(period).execute(&mut *tx).await.unwrap();

        // The book has him in Aqrab (8) and Mizan (7).
        let book = Book {
            members: vec![person(999002, Some("عضو دو جایی"), 3)],
            entries: vec![paid(0, 8), paid(0, 7)],
            ..Default::default()
        };
        let p = Params { year: 1405, commit: false, file_name: None, hotspot_income: None, take_excel: None };
        let r = store(&mut tx, &user, &p, "test3", book).await.ok().expect("store");
        assert_eq!((r.in_app, r.in_app_amount, r.receipts), (1, 250.0, 1));
        let cells: Vec<(i32, i32)> = sqlx::query_as("SELECT month, amount::int FROM v_excel_months WHERE member_id = $1 ORDER BY month").bind(member).fetch_all(&mut *tx).await.unwrap();
        assert_eq!(cells, vec![(7, 250)], "only Mizan comes from the book");

        // Corrected, then a new month, then taken out.
        let cell = |month, amount| ExcelCell { kind: "monthly".into(), year: 1405, month, amount };
        set_cell(&mut tx, member, &cell(7, 300.0)).await.ok().expect("correct");
        set_cell(&mut tx, member, &cell(6, 150.0)).await.ok().expect("add");
        let cells: Vec<(i32, i32)> = sqlx::query_as("SELECT month, amount::int FROM v_excel_months WHERE member_id = $1 ORDER BY month").bind(member).fetch_all(&mut *tx).await.unwrap();
        assert_eq!(cells, vec![(6, 150), (7, 300)]);
        set_cell(&mut tx, member, &cell(7, 0.0)).await.ok().expect("take out");
        let cells: Vec<(i32, i32)> = sqlx::query_as("SELECT month, amount::int FROM v_excel_months WHERE member_id = $1 ORDER BY month").bind(member).fetch_all(&mut *tx).await.unwrap();
        assert_eq!(cells, vec![(6, 150)]);
        tx.rollback().await.unwrap();
    }
}
