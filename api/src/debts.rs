//! Everything people owe, in one list: the rest of a membership period (monthly, daily,
//! internet), hotspot cards on credit, the unpaid part of a returned book, and books past
//! their due date with what they cost so far. Money paid counts in the month it was owed
//! (`issued_on`); the bill carries the day it was paid (`billed_on`).

use std::collections::BTreeMap;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{clean, hall_only, issue, pay_period, today, typed_today};
use crate::AppState;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

#[derive(FromRow)]
struct Row {
    /// period | debt | loan
    source: String,
    /// monthly | daily | internet | hotspot | books | other | overdue
    kind: String,
    id: Uuid,
    title: String,
    on_day: NaiveDate,
    until: Option<NaiveDate>,
    due: f64,
    paid: f64,
    owed: f64,
    weekly_fee: f64,
    receipt_id: Option<Uuid>,
    receipt_no: Option<String>,
    note: Option<String>,
    member_id: Option<Uuid>,
    deposit_id: Option<Uuid>,
    member_no: Option<i32>,
    card_no: Option<String>,
    name: String,
    phone: Option<String>,
}

#[derive(Serialize)]
pub struct Item {
    source: String,
    kind: String,
    id: Uuid,
    title: String,
    on_day: NaiveDate,
    until: Option<NaiveDate>,
    due: f64,
    paid: f64,
    owed: f64,
    receipt_id: Option<Uuid>,
    receipt_no: Option<String>,
    note: Option<String>,
    /// A book past its date: the weeks read, the days late, and what they cost today.
    weeks: Option<i64>,
    days_late: Option<i64>,
    fee: Option<f64>,
    fine: Option<f64>,
}

#[derive(Serialize)]
pub struct Group {
    /// m:<member>, d:<card>, or x:<the item> for someone with neither.
    key: String,
    member_id: Option<Uuid>,
    deposit_id: Option<Uuid>,
    member_no: Option<i32>,
    card_no: Option<String>,
    name: String,
    phone: Option<String>,
    total: f64,
    items: Vec<Item>,
}

#[derive(Serialize)]
pub struct Debts {
    /// How many debts, how many people, and how much, in everything that matches.
    items: usize,
    people: usize,
    sum: f64,
    groups: Vec<Group>,
}

#[derive(Deserialize)]
pub struct DebtQuery {
    q: Option<String>,
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
    /// One group only (its `key`).
    key: Option<String>,
}

const ROWS: &str = r#"
    SELECT 'period' AS source, pl.kind::text AS kind, ms.id, pl.name AS title, ms.start_date AS on_day, ms.end_date AS until,
           pp.due, pp.paid, pp.owed, 0::float8 AS weekly_fee, pp.receipt_id, pp.receipt_no, ms.note,
           m.id AS member_id, NULL::uuid AS deposit_id, m.member_no, NULL::text AS card_no,
           COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), ms.guest_name, '—') AS name, m.phone
    FROM v_period_paid pp JOIN memberships ms ON ms.id = pp.membership_id JOIN plans pl ON pl.id = ms.plan_id
    LEFT JOIN members m ON m.id = ms.member_id AND m.deleted_at IS NULL
    WHERE pp.owed > 0 AND pp.receipt_id IS NOT NULL
    UNION ALL
    SELECT 'debt', x.kind, x.id, x.title, x.owed_on, NULL,
           x.amount::float8, x.paid::float8, (x.amount - x.paid)::float8, 0, NULL, NULL, x.note,
           m.id, d.id, m.member_no, d.code,
           COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), d.name, x.guest_name, '—'), COALESCE(m.phone, d.phone, x.phone)
    FROM member_debts x LEFT JOIN members m ON m.id = x.member_id LEFT JOIN loan_deposits d ON d.id = x.deposit_id
    WHERE x.deleted_at IS NULL AND x.amount > x.paid
    UNION ALL
    SELECT 'loan', 'overdue', l.id, COALESCE(b.title, l.book_title, '—'), l.loaned_on, l.due_on,
           0, 0, 0, l.weekly_fee::float8, NULL, NULL, l.note,
           m.id, d.id, m.member_no, d.code,
           COALESCE(NULLIF(trim(concat_ws(' ', m.first_name, m.last_name)), ''), d.name, l.borrower_name, '—'), COALESCE(m.phone, d.phone, l.borrower_phone)
    FROM book_loans l LEFT JOIN members m ON m.id = l.member_id LEFT JOIN loan_deposits d ON d.id = l.deposit_id
    LEFT JOIN books b ON b.id = l.book_id
    WHERE l.deleted_at IS NULL AND l.returned_on IS NULL AND l.scope = 'home' AND l.due_on < $1
"#;

/// GET /api/v1/debts: everyone who owes, each with their debts, oldest first.
pub async fn list(State(s): State<AppState>, user: CurrentUser, Query(p): Query<DebtQuery>) -> Result<Json<Debts>, ApiError> {
    hall_only(&user)?;
    let now = today();
    let mut tx = begin_as(&s.db, &user).await?;
    let rows: Vec<Row> = sqlx::query_as(ROWS).bind(now).fetch_all(&mut *tx).await?;
    let rules = crate::books::rules_of(&mut tx).await?;
    tx.commit().await?;
    let needle = clean(&p.q).map(|q| q.to_lowercase());
    let mut groups: BTreeMap<String, Group> = BTreeMap::new();
    for r in rows {
        if p.from.is_some_and(|d| r.on_day < d) || p.to.is_some_and(|d| r.on_day > d) {
            continue;
        }
        let key = match (r.member_id, r.deposit_id) {
            (Some(m), _) => format!("m:{m}"),
            (_, Some(d)) => format!("d:{d}"),
            _ => format!("x:{}", r.id),
        };
        if p.key.as_ref().is_some_and(|k| *k != key) {
            continue;
        }
        if let Some(n) = &needle {
            let hay = format!("{} {} {} {} {}", r.name, r.phone.as_deref().unwrap_or(""), r.member_no.map_or(String::new(), |v| v.to_string()), r.card_no.as_deref().unwrap_or(""), r.title).to_lowercase();
            if !hay.contains(n) {
                continue;
            }
        }
        let late = (r.source == "loan").then(|| crate::books::charge(r.on_day, r.until.unwrap_or(now), now, r.weekly_fee, rules.fine_per_week));
        let owed = late.map_or(r.owed, |c| c.fee + c.fine);
        let group = groups.entry(key.clone()).or_insert_with(|| Group {
            key,
            member_id: r.member_id,
            deposit_id: r.deposit_id,
            member_no: r.member_no,
            card_no: r.card_no.clone(),
            name: r.name.clone(),
            phone: r.phone.clone(),
            total: 0.0,
            items: Vec::new(),
        });
        group.total += owed;
        group.items.push(Item {
            source: r.source,
            kind: r.kind,
            id: r.id,
            title: r.title,
            on_day: r.on_day,
            until: r.until,
            due: if late.is_some() { owed } else { r.due },
            paid: r.paid,
            owed,
            receipt_id: r.receipt_id,
            receipt_no: r.receipt_no,
            note: r.note,
            weeks: late.map(|c| c.weeks),
            days_late: late.map(|c| c.days_late),
            fee: late.map(|c| c.fee),
            fine: late.map(|c| c.fine),
        });
    }
    let mut groups: Vec<Group> = groups.into_values().collect();
    for g in &mut groups {
        g.items.sort_by_key(|i| i.on_day);
    }
    groups.sort_by_key(|g| g.items.first().map(|i| i.on_day));
    let (items, sum) = groups.iter().fold((0, 0.0), |(n, t), g| (n + g.items.len(), t + g.total));
    Ok(Json(Debts { items, people: groups.len(), sum, groups }))
}

#[derive(Deserialize)]
pub struct PayItem {
    /// period | debt (a late book is settled by returning it).
    source: String,
    id: Uuid,
    amount: f64,
}

#[derive(Deserialize)]
pub struct PayInput {
    items: Vec<PayItem>,
}

#[derive(Serialize, FromRow)]
pub struct PaidBill {
    id: Uuid,
    receipt_no: String,
    amount: f64,
    description: Option<String>,
}

/// POST /api/v1/debts/pay: one bill for each debt paid, all or nothing.
pub async fn pay(State(s): State<AppState>, user: CurrentUser, Json(b): Json<PayInput>) -> Result<Json<Vec<PaidBill>>, ApiError> {
    hall_only(&user)?;
    if b.items.is_empty() {
        return Err(ApiError::bad("nothing_owed"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    let mut ids = Vec::new();
    for i in &b.items {
        ids.push(match i.source.as_str() {
            "period" => pay_period(&mut tx, &user, i.id, i.amount).await?.0,
            "debt" => pay_debt(&mut tx, &user, i.id, i.amount).await?,
            _ => return Err(ApiError::bad("bad_kind")),
        });
    }
    let bills = sqlx::query_as("SELECT id, receipt_no, COALESCE(debt_paid, amount)::float8 AS amount, description FROM receipts WHERE id = ANY($1)")
        .bind(&ids)
        .fetch_all(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(Json(bills))
}

async fn pay_debt(tx: &mut PgConnection, user: &CurrentUser, id: Uuid, amount: f64) -> Result<Uuid, ApiError> {
    let row: Option<(f64, f64, f64, NaiveDate, String, String, Option<Uuid>)> = sqlx::query_as(
        "SELECT amount::float8, paid::float8, income_share::float8, owed_on, income_category, title, member_id \
         FROM member_debts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?;
    let (total, paid, share, owed_on, category, title, member) = row.ok_or(NOT_FOUND)?;
    let owed = total - paid;
    if owed <= 0.0 {
        return Err(ApiError::bad("nothing_owed"));
    }
    if !amount.is_finite() || amount <= 0.0 || amount > owed + 0.001 {
        return Err(ApiError::bad("bad_paid"));
    }
    let income = (amount * share * 100.0).round() / 100.0;
    let what = if share < 1.0 { format!("باقی {title} · پرداخت {amount}، سود {income}") } else { format!("باقی {title}") };
    let receipt = issue(tx, user, &category, income, &what, None, None).await?;
    let now = today();
    sqlx::query("UPDATE receipts SET issued_on = $2, billed_on = $3, debt_id = $4, debt_paid = $5, member_id = $6 WHERE id = $1")
        .bind(receipt)
        .bind(owed_on)
        .bind((owed_on != now).then_some(now))
        .bind(id)
        .bind(amount)
        .bind(member)
        .execute(&mut *tx)
        .await?;
    sqlx::query("UPDATE member_debts SET paid = paid + $2 WHERE id = $1").bind(id).bind(amount).execute(&mut *tx).await?;
    Ok(receipt)
}

#[derive(Deserialize)]
pub struct DebtInput {
    member_id: Option<Uuid>,
    deposit_id: Option<Uuid>,
    guest_name: Option<String>,
    phone: Option<String>,
    /// hotspot | books | other
    kind: String,
    title: Option<String>,
    amount: Option<f64>,
    owed_on: Option<NaiveDate>,
    note: Option<String>,
    /// Hotspot cards on credit: they leave the stock now; the income comes when they are paid.
    volume_gb: Option<f64>,
    quantity: Option<i32>,
}

/// POST /api/v1/debts: writes down a new debt.
pub async fn create(State(s): State<AppState>, user: CurrentUser, Json(b): Json<DebtInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let guest = clean(&b.guest_name);
    if b.member_id.is_none() && b.deposit_id.is_none() && guest.is_none() {
        return Err(ApiError::bad("name_required"));
    }
    let on = b.owed_on.unwrap_or_else(today);
    if on > today() {
        return Err(ApiError::bad("future_date"));
    }
    let id = Uuid::new_v4();
    let mut tx = begin_as(&s.db, &user).await?;
    let (title, amount, share, category) = match b.kind.as_str() {
        "hotspot" => {
            let (volume, quantity) = (b.volume_gb.unwrap_or(0.0), b.quantity.unwrap_or(0));
            let (title, sales, profit) = crate::hotspot::sell_on_credit(&mut tx, &user, volume, quantity, on, id).await?;
            (clean(&b.title).unwrap_or(title), sales, if sales > 0.0 { profit / sales } else { 1.0 }, "hotspot")
        }
        "books" | "other" => {
            let title = clean(&b.title).ok_or(ApiError::bad("title_required"))?;
            let amount = b.amount.filter(|a| a.is_finite() && *a > 0.0).ok_or(ApiError::bad("bad_amount"))?;
            (title, amount, 1.0, if b.kind == "books" { "books" } else { "misc" })
        }
        _ => return Err(ApiError::bad("bad_kind")),
    };
    sqlx::query(
        "INSERT INTO member_debts (id, member_id, deposit_id, guest_name, phone, kind, title, owed_on, amount, income_category, income_share, note, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)",
    )
    .bind(id)
    .bind(b.member_id)
    .bind(b.deposit_id)
    .bind(&guest)
    .bind(clean(&b.phone))
    .bind(&b.kind)
    .bind(&title)
    .bind(on)
    .bind(amount)
    .bind(category)
    .bind(share)
    .bind(clean(&b.note))
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(Json(id))
}

/// A debt written by mistake, nothing paid on it yet; hotspot cards go back into stock.
pub async fn delete(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let row: Option<(f64, DateTime<Utc>)> = sqlx::query_as("SELECT paid::float8, created_at FROM member_debts WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?;
    let (paid, created) = row.ok_or(NOT_FOUND)?;
    if paid > 0.0 {
        return Err(ApiError(StatusCode::CONFLICT, "void_the_bill"));
    }
    if !user.is_partner() && !typed_today(created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    sqlx::query("UPDATE member_debts SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE hotspot_sales SET deleted_at = now() WHERE debt_id = $1 AND deleted_at IS NULL").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

/// What a member owes outside membership periods (the member page adds it to their «باقی»).
pub async fn member_owed(tx: &mut PgConnection, member: Uuid) -> Result<f64, ApiError> {
    Ok(sqlx::query_scalar("SELECT COALESCE(sum(amount - paid), 0)::float8 FROM member_debts WHERE member_id = $1 AND deleted_at IS NULL")
        .bind(member)
        .fetch_one(&mut *tx)
        .await?)
}
