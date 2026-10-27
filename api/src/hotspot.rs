//! Internet hotspot cards, as in the Excel hotspot sheet: supplier bills of cards per
//! volume, and the end-of-day count of cards sold. The statement's hotspot income is the
//! profit, so each count is one receipt for (sale price - cost) of the cards sold.

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgConnection};
use uuid::Uuid;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::hall::{clean, hall_only, issue, today, typed_today};
use crate::AppState;

const NOT_FOUND: ApiError = ApiError(StatusCode::NOT_FOUND, "not_found");

/// Text for a volume: 5 -> "5GB", 1.5 -> "1.5GB".
fn gb(v: f64) -> String {
    format!("{}GB", (v * 100.0).round() / 100.0)
}

/// Afghani to the cent, as the database keeps them.
fn cents(a: f64) -> f64 {
    (a * 100.0).round() / 100.0
}

/// Both a count and deleting a supplier bill change stock; one at a time.
async fn lock_stock(tx: &mut PgConnection) -> Result<(), ApiError> {
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('hotspot_stock'))").execute(&mut *tx).await?;
    Ok(())
}

async fn cost_per_gb(tx: &mut PgConnection) -> Result<f64, ApiError> {
    Ok(sqlx::query_scalar("SELECT COALESCE((SELECT (value #>> '{}')::float8 FROM settings WHERE key = 'hotspot_cost_per_gb'), 0)")
        .fetch_one(&mut *tx)
        .await?)
}

#[derive(Deserialize, Clone, Copy)]
pub struct Count {
    volume_gb: f64,
    quantity: i32,
}

/// Counts as typed: positive, one line per volume, at least one card.
fn counts(lines: &[Count]) -> Result<Vec<Count>, ApiError> {
    let mut out: Vec<Count> = Vec::new();
    for c in lines.iter().filter(|c| c.quantity != 0) {
        if c.quantity < 0 || !c.volume_gb.is_finite() || c.volume_gb <= 0.0 {
            return Err(ApiError::bad("bad_amount"));
        }
        match out.iter_mut().find(|o| o.volume_gb == c.volume_gb) {
            Some(o) => o.quantity += c.quantity,
            None => out.push(*c),
        }
    }
    if out.is_empty() {
        return Err(ApiError::bad("no_cards"));
    }
    Ok(out)
}

#[derive(Deserialize)]
pub struct Range {
    from: Option<NaiveDate>,
    to: Option<NaiveDate>,
}

// ---------------------------------------------------------------------------
// Cards, prices and stock

#[derive(Serialize, FromRow)]
pub struct Card {
    volume_gb: f64,
    price: f64,
    active: bool,
    bought: i64,
    sold: i64,
    in_hand: i64,
}

#[derive(Serialize)]
pub struct Cards {
    cost_per_gb: f64,
    cards: Vec<Card>,
}

pub async fn cards(State(s): State<AppState>, user: CurrentUser) -> Result<Json<Cards>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let cards = sqlx::query_as(
        "SELECT volume_gb::float8 AS volume_gb, price::float8 AS price, active, bought::int8 AS bought, sold::int8 AS sold, \
                in_hand::int8 AS in_hand \
         FROM v_hotspot_stock ORDER BY volume_gb",
    )
    .fetch_all(&mut *tx)
    .await?;
    let cost_per_gb = cost_per_gb(&mut tx).await?;
    tx.commit().await?;
    Ok(Json(Cards { cost_per_gb, cards }))
}

#[derive(Deserialize)]
pub struct CardPrice {
    volume_gb: f64,
    price: f64,
    active: bool,
}

#[derive(Deserialize)]
pub struct PriceList {
    cost_per_gb: f64,
    cards: Vec<CardPrice>,
}

/// Partners set the sale price of each card and what a GB costs; a count keeps the prices it was typed with.
pub async fn set_cards(State(s): State<AppState>, user: CurrentUser, Json(p): Json<PriceList>) -> Result<StatusCode, ApiError> {
    if !user.is_partner() {
        return Err(ApiError::FORBIDDEN);
    }
    let ok = |a: f64| a.is_finite() && a >= 0.0;
    if !ok(p.cost_per_gb) || p.cards.iter().any(|c| !ok(c.price) || !c.volume_gb.is_finite() || c.volume_gb <= 0.0) {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    sqlx::query(
        "INSERT INTO settings (key, value) VALUES ('hotspot_cost_per_gb', $1) \
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()",
    )
    .bind(serde_json::json!(p.cost_per_gb))
    .execute(&mut *tx)
    .await?;
    for c in &p.cards {
        sqlx::query(
            "INSERT INTO hotspot_cards (volume_gb, price, active) VALUES ($1, $2, $3) \
             ON CONFLICT (volume_gb) DO UPDATE SET price = EXCLUDED.price, active = EXCLUDED.active, updated_at = now()",
        )
        .bind(c.volume_gb)
        .bind(c.price)
        .bind(c.active)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// Supplier bills

#[derive(Deserialize)]
pub struct BuyInput {
    purchased_on: Option<NaiveDate>,
    supplier_bill_no: Option<String>,
    bill_gb: Option<f64>,
    #[serde(default)]
    extra_cost: f64,
    note: Option<String>,
    lines: Vec<Count>,
}

pub async fn create_buy(State(s): State<AppState>, user: CurrentUser, Json(b): Json<BuyInput>) -> Result<Json<Uuid>, ApiError> {
    hall_only(&user)?;
    let lines = counts(&b.lines)?;
    let on = b.purchased_on.unwrap_or_else(today);
    if on > today() {
        return Err(ApiError::bad("future_date"));
    }
    if !b.extra_cost.is_finite() || b.extra_cost < 0.0 || b.bill_gb.is_some_and(|g| !g.is_finite() || g < 0.0) {
        return Err(ApiError::bad("bad_amount"));
    }
    let mut tx = begin_as(&s.db, &user).await?;
    for c in &lines {
        let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM hotspot_cards WHERE volume_gb = $1::numeric)")
            .bind(c.volume_gb)
            .fetch_one(&mut *tx)
            .await?;
        if !known {
            return Err(ApiError::bad("bad_card"));
        }
    }
    let per_gb = cost_per_gb(&mut tx).await?;
    let id = Uuid::new_v4();
    sqlx::query(
        "INSERT INTO hotspot_buys (id, purchased_on, supplier_bill_no, bill_gb, extra_cost, note, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6, $7)",
    )
    .bind(id)
    .bind(on)
    .bind(clean(&b.supplier_bill_no))
    .bind(b.bill_gb)
    .bind(b.extra_cost)
    .bind(clean(&b.note))
    .bind(user.id)
    .execute(&mut *tx)
    .await?;
    for c in lines {
        sqlx::query(
            "INSERT INTO hotspot_purchases (id, buy_id, purchased_on, supplier_bill_no, volume_gb, quantity, unit_cost) \
             VALUES ($1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(Uuid::new_v4())
        .bind(id)
        .bind(on)
        .bind(clean(&b.supplier_bill_no))
        .bind(c.volume_gb)
        .bind(c.quantity)
        .bind(cents(c.volume_gb * per_gb))
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(id))
}

#[derive(Serialize, FromRow)]
pub struct Buy {
    id: Uuid,
    purchased_on: NaiveDate,
    supplier_bill_no: Option<String>,
    bill_gb: Option<f64>,
    extra_cost: f64,
    note: Option<String>,
    /// "60 کارت 5GB، 9 کارت 1GB"
    cards: String,
    card_count: i64,
    gb: f64,
    cost: f64,
    created_by: Option<String>,
    #[serde(skip)]
    created_at: DateTime<Utc>,
    #[sqlx(skip)]
    removable: bool,
}

pub async fn buys(State(s): State<AppState>, user: CurrentUser, Query(r): Query<Range>) -> Result<Json<Vec<Buy>>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let mut rows: Vec<Buy> = sqlx::query_as(
        "SELECT h.id, h.purchased_on, h.supplier_bill_no, h.bill_gb::float8 AS bill_gb, h.extra_cost::float8 AS extra_cost, h.note, \
                string_agg(p.quantity || ' کارت ' || trim(trailing '.' FROM trim(trailing '0' FROM p.volume_gb::text)) || 'GB', '، ' ORDER BY p.volume_gb) AS cards, \
                sum(p.quantity)::int8 AS card_count, sum(p.quantity * p.volume_gb)::float8 AS gb, \
                (sum(p.quantity * p.unit_cost) + h.extra_cost)::float8 AS cost, \
                st.full_name AS created_by, h.created_at \
         FROM hotspot_buys h JOIN hotspot_purchases p ON p.buy_id = h.id AND p.deleted_at IS NULL \
         LEFT JOIN app_users u ON u.id = h.created_by LEFT JOIN staff st ON st.id = u.staff_id \
         WHERE h.deleted_at IS NULL AND ($1::date IS NULL OR h.purchased_on >= $1) AND ($2::date IS NULL OR h.purchased_on <= $2) \
         GROUP BY h.id, st.full_name ORDER BY h.purchased_on DESC, h.created_at DESC LIMIT 500",
    )
    .bind(r.from)
    .bind(r.to)
    .fetch_all(&mut *tx)
    .await?;
    tx.commit().await?;
    for b in &mut rows {
        b.removable = user.is_partner() || typed_today(b.created_at);
    }
    Ok(Json(rows))
}

/// A supplier bill typed in by mistake: partners any time, the manager the same day.
pub async fn delete_buy(State(s): State<AppState>, user: CurrentUser, Path(id): Path<Uuid>) -> Result<StatusCode, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    lock_stock(&mut tx).await?;
    let created: DateTime<Utc> = sqlx::query_scalar("SELECT created_at FROM hotspot_buys WHERE id = $1 AND deleted_at IS NULL FOR UPDATE")
        .bind(id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(NOT_FOUND)?;
    if !user.is_partner() && !typed_today(created) {
        return Err(ApiError(StatusCode::FORBIDDEN, "remove_today_only"));
    }
    // Cards of this bill that are already sold cannot be taken out of stock.
    let short: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM hotspot_purchases p JOIN v_hotspot_stock s ON s.volume_gb = p.volume_gb \
                        WHERE p.buy_id = $1 AND p.deleted_at IS NULL GROUP BY p.volume_gb, s.in_hand HAVING sum(p.quantity) > s.in_hand)",
    )
    .bind(id)
    .fetch_one(&mut *tx)
    .await?;
    if short {
        return Err(ApiError(StatusCode::CONFLICT, "cards_sold"));
    }
    sqlx::query("UPDATE hotspot_buys SET deleted_at = now() WHERE id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("UPDATE hotspot_purchases SET deleted_at = now() WHERE buy_id = $1").bind(id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

// ---------------------------------------------------------------------------
// The end-of-day count

#[derive(Deserialize)]
pub struct SaleInput {
    lines: Vec<Count>,
}

#[derive(Serialize)]
pub struct SavedSale {
    receipt_id: Uuid,
    sales: f64,
    cost: f64,
    profit: f64,
}

/// Today's cards sold: one receipt for their profit. A count is undone by voiding its bill.
pub async fn create_sale(State(s): State<AppState>, user: CurrentUser, Json(b): Json<SaleInput>) -> Result<Json<SavedSale>, ApiError> {
    hall_only(&user)?;
    let lines = counts(&b.lines)?;
    let mut tx = begin_as(&s.db, &user).await?;
    // Two desks counting at once must not both sell the last cards.
    lock_stock(&mut tx).await?;
    let per_gb = cost_per_gb(&mut tx).await?;
    let (mut sales, mut cost) = (0.0, 0.0);
    let mut what = Vec::new();
    let mut priced = Vec::new();
    for c in &lines {
        // Cost: what this volume's cards were bought for on average (the price per GB of
        // the supplier bills), so a later change of the price per GB does not move it.
        let row: Option<(f64, i64, Option<f64>)> = sqlx::query_as(
            "SELECT s.price::float8, s.in_hand::int8, \
                    (SELECT (sum(p.quantity * p.unit_cost) / nullif(sum(p.quantity), 0))::float8 \
                     FROM hotspot_purchases p JOIN hotspot_buys h ON h.id = p.buy_id \
                     WHERE p.volume_gb = s.volume_gb AND p.deleted_at IS NULL AND h.deleted_at IS NULL) \
             FROM v_hotspot_stock s WHERE s.volume_gb = $1::numeric",
        )
        .bind(c.volume_gb)
        .fetch_optional(&mut *tx)
        .await?;
        let (price, in_hand, bought_at) = row.ok_or(ApiError::bad("bad_card"))?;
        if (c.quantity as i64) > in_hand {
            return Err(ApiError(StatusCode::CONFLICT, "not_enough_cards"));
        }
        let unit_cost = cents(bought_at.unwrap_or(c.volume_gb * per_gb));
        sales += price * c.quantity as f64;
        cost += unit_cost * c.quantity as f64;
        what.push(format!("{} کارت {}", c.quantity, gb(c.volume_gb)));
        priced.push((*c, price, unit_cost));
    }
    let (sales, cost) = (cents(sales), cents(cost));
    let profit = cents(sales - cost);
    if profit < 0.0 {
        return Err(ApiError::bad("price_below_cost"));
    }
    let description = format!("فروش کارت هاتسپات: {} · فروش {sales}، قیمت خرید {cost}", what.join("، "));
    let receipt_id = issue(&mut tx, &user, "hotspot", profit, &description, None, None).await?;
    for (c, price, unit_cost) in priced {
        sqlx::query(
            "INSERT INTO hotspot_sales (id, sold_on, volume_gb, quantity, unit_price, unit_cost, receipt_id, created_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
        )
        .bind(Uuid::new_v4())
        .bind(today())
        .bind(c.volume_gb)
        .bind(c.quantity)
        .bind(price)
        .bind(unit_cost)
        .bind(receipt_id)
        .bind(user.id)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(Json(SavedSale { receipt_id, sales, cost, profit }))
}

#[derive(Serialize, FromRow)]
pub struct Sale {
    receipt_id: Uuid,
    receipt_no: String,
    sold_on: NaiveDate,
    cards: String,
    card_count: i64,
    gb: f64,
    sales: f64,
    cost: f64,
    profit: f64,
    voided: bool,
    created_by: Option<String>,
}

#[derive(Serialize, Default)]
pub struct Summary {
    /// Supplier bills in the range, with their extra costs.
    bought: f64,
    sales: f64,
    /// What the cards sold had cost.
    cost: f64,
    profit: f64,
    cards_sold: i64,
    gb_sold: f64,
}

#[derive(Serialize)]
pub struct Sales {
    summary: Summary,
    rows: Vec<Sale>,
}

pub async fn sales(State(s): State<AppState>, user: CurrentUser, Query(r): Query<Range>) -> Result<Json<Sales>, ApiError> {
    hall_only(&user)?;
    let mut tx = begin_as(&s.db, &user).await?;
    let rows: Vec<Sale> = sqlx::query_as(
        "SELECT r.id AS receipt_id, r.receipt_no, min(x.sold_on) AS sold_on, \
                string_agg(x.quantity || ' کارت ' || trim(trailing '.' FROM trim(trailing '0' FROM x.volume_gb::text)) || 'GB', '، ' ORDER BY x.volume_gb) AS cards, \
                sum(x.quantity)::int8 AS card_count, sum(x.quantity * x.volume_gb)::float8 AS gb, \
                sum(x.quantity * x.unit_price)::float8 AS sales, sum(x.quantity * x.unit_cost)::float8 AS cost, \
                r.amount::float8 AS profit, r.voided, st.full_name AS created_by \
         FROM hotspot_sales x JOIN receipts r ON r.id = x.receipt_id \
         LEFT JOIN app_users u ON u.id = r.issued_by LEFT JOIN staff st ON st.id = u.staff_id \
         WHERE r.deleted_at IS NULL AND ($1::date IS NULL OR x.sold_on >= $1) AND ($2::date IS NULL OR x.sold_on <= $2) \
         GROUP BY r.id, st.full_name ORDER BY min(x.sold_on) DESC, r.created_at DESC LIMIT 500",
    )
    .bind(r.from)
    .bind(r.to)
    .fetch_all(&mut *tx)
    .await?;
    let bought: f64 = sqlx::query_scalar(
        "SELECT COALESCE(sum(p.quantity * p.unit_cost), 0)::float8 \
              + COALESCE((SELECT sum(extra_cost) FROM hotspot_buys WHERE deleted_at IS NULL \
                          AND ($1::date IS NULL OR purchased_on >= $1) AND ($2::date IS NULL OR purchased_on <= $2)), 0)::float8 \
         FROM hotspot_purchases p JOIN hotspot_buys h ON h.id = p.buy_id \
         WHERE p.deleted_at IS NULL AND h.deleted_at IS NULL \
           AND ($1::date IS NULL OR h.purchased_on >= $1) AND ($2::date IS NULL OR h.purchased_on <= $2)",
    )
    .bind(r.from)
    .bind(r.to)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    let mut summary = Summary { bought, ..Summary::default() };
    for s in rows.iter().filter(|s| !s.voided) {
        summary.sales += s.sales;
        summary.cost += s.cost;
        summary.profit += s.profit;
        summary.cards_sold += s.card_count;
        summary.gb_sold += s.gb;
    }
    Ok(Json(Sales { summary, rows }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counting() {
        let c = |v, q| Count { volume_gb: v, quantity: q };
        let Ok(merged) = counts(&[c(5.0, 60), c(1.0, 0), c(5.0, 2), c(1.0, 9)]) else { panic!("counts") };
        assert_eq!(merged.iter().map(|c| (c.volume_gb, c.quantity)).collect::<Vec<_>>(), vec![(5.0, 62), (1.0, 9)]);
        assert!(counts(&[c(5.0, 0)]).is_err());
        assert!(counts(&[c(5.0, -1)]).is_err());
        assert_eq!(gb(5.0), "5GB");
        assert_eq!(gb(1.5), "1.5GB");
    }
}
