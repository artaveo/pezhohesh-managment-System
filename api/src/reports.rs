//! Income and expenses over any list of date ranges. The app sends Solar (Hijri Shamsi)
//! boundaries: the days of a month, the 12 months of a year, or one range per year,
//! and builds the monthly and yearly reports from the answer.

use std::collections::BTreeMap;

use axum::extract::{Query, State};
use axum::Json;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

use crate::auth::{begin_as, ApiError, CurrentUser};
use crate::AppState;

#[derive(Deserialize)]
pub struct Params {
    /// Comma-separated ISO dates d0,d1,...,dn: ranges [d0,d1), [d1,d2), ...
    bounds: String,
    /// true: also split each range by income and expense category.
    #[serde(default)]
    categories: bool,
}

#[derive(Serialize)]
pub struct Period {
    from: chrono::NaiveDate,
    to: chrono::NaiveDate,
    income: f64,
    expenses: f64,
    /// Hand-made balance estimates of months whose detail was lost (counted as balance).
    estimated: f64,
    new_members: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    income_by_category: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    expenses_by_category: Option<BTreeMap<String, f64>>,
    /// Cash taken by each partner (staff name), as in the statement's برداشت rows.
    #[serde(skip_serializing_if = "Option::is_none")]
    withdrawals_by_person: Option<BTreeMap<String, f64>>,
}

#[derive(Serialize)]
pub struct Periods {
    periods: Vec<Period>,
    /// First day with any hall income, so the app knows which years to ask for.
    first_day: Option<chrono::NaiveDate>,
    all_time_income: f64,
    /// Expense categories in the statement's order (rent first, as in the Excel book).
    expense_order: Vec<String>,
}

#[derive(FromRow)]
struct Totals {
    i: i32,
    income: f64,
    expenses: f64,
    estimated: f64,
    new_members: i64,
}

#[derive(FromRow)]
struct CatRow {
    i: i32,
    category: String,
    amount: f64,
}

pub async fn periods(State(s): State<AppState>, user: CurrentUser, Query(p): Query<Params>) -> Result<Json<Periods>, ApiError> {
    if !user.sees_hall() {
        return Err(ApiError::FORBIDDEN);
    }
    let bounds: Vec<chrono::NaiveDate> = p
        .bounds
        .split(',')
        .map(|d| d.trim().parse())
        .collect::<Result<_, _>>()
        .map_err(|_| ApiError::bad("bad_bounds"))?;
    if bounds.len() < 2 || bounds.len() > 400 || bounds.windows(2).any(|w| w[0] >= w[1]) {
        return Err(ApiError::bad("bad_bounds"));
    }
    let lo: Vec<_> = bounds[..bounds.len() - 1].to_vec();
    let hi: Vec<_> = bounds[1..].to_vec();

    let mut tx = begin_as(&s.db, &user).await?;
    // Hall only, Afghani only: the education department reports in its own section.
    let totals: Vec<Totals> = sqlx::query_as(
        r#"
        SELECT (b.n - 1)::int AS i,
            COALESCE((SELECT sum(amount) FROM receipts r WHERE NOT r.voided AND r.deleted_at IS NULL
                AND r.department = 'hall' AND r.currency = 'AFN' AND r.issued_on >= b.lo AND r.issued_on < b.hi), 0)::float8 AS income,
            COALESCE((SELECT sum(amount) FROM expenses e WHERE e.deleted_at IS NULL
                AND e.department = 'hall' AND e.currency = 'AFN' AND e.spent_on >= b.lo AND e.spent_on < b.hi), 0)::float8 AS expenses,
            COALESCE((SELECT sum(net_balance) FROM month_summaries ms WHERE ms.deleted_at IS NULL
                AND ms.department = 'hall' AND ms.starts_on >= b.lo AND ms.starts_on < b.hi), 0)::float8 AS estimated,
            (SELECT count(*) FROM members m WHERE m.deleted_at IS NULL AND m.joined_on >= b.lo AND m.joined_on < b.hi) AS new_members
        FROM unnest($1::date[], $2::date[]) WITH ORDINALITY AS b(lo, hi, n)
        ORDER BY b.n
        "#,
    )
    .bind(&lo)
    .bind(&hi)
    .fetch_all(&mut *tx)
    .await?;

    let (mut inc_cat, mut exp_cat) = (vec![BTreeMap::new(); lo.len()], vec![BTreeMap::new(); lo.len()]);
    let mut taken = vec![BTreeMap::new(); lo.len()];
    if p.categories {
        let rows: Vec<CatRow> = sqlx::query_as(
            r#"
            SELECT (b.n - 1)::int AS i, r.income_category AS category, sum(r.amount)::float8 AS amount
            FROM unnest($1::date[], $2::date[]) WITH ORDINALITY AS b(lo, hi, n)
            JOIN receipts r ON r.issued_on >= b.lo AND r.issued_on < b.hi
            WHERE NOT r.voided AND r.deleted_at IS NULL AND r.department = 'hall' AND r.currency = 'AFN'
            GROUP BY b.n, r.income_category
            "#,
        )
        .bind(&lo)
        .bind(&hi)
        .fetch_all(&mut *tx)
        .await?;
        for r in rows {
            inc_cat[r.i as usize].insert(r.category, r.amount);
        }
        let rows: Vec<CatRow> = sqlx::query_as(
            r#"
            SELECT (b.n - 1)::int AS i, c.name AS category, sum(e.amount)::float8 AS amount
            FROM unnest($1::date[], $2::date[]) WITH ORDINALITY AS b(lo, hi, n)
            JOIN expenses e ON e.spent_on >= b.lo AND e.spent_on < b.hi
            JOIN expense_categories c ON c.id = e.category_id
            WHERE e.deleted_at IS NULL AND e.department = 'hall' AND e.currency = 'AFN'
            GROUP BY b.n, c.name
            "#,
        )
        .bind(&lo)
        .bind(&hi)
        .fetch_all(&mut *tx)
        .await?;
        for r in rows {
            exp_cat[r.i as usize].insert(r.category, r.amount);
        }
        let rows: Vec<CatRow> = sqlx::query_as(
            r#"
            SELECT (b.n - 1)::int AS i, s.full_name AS category, sum(w.amount)::float8 AS amount
            FROM unnest($1::date[], $2::date[]) WITH ORDINALITY AS b(lo, hi, n)
            JOIN withdrawals w ON w.taken_on >= b.lo AND w.taken_on < b.hi
            JOIN staff s ON s.id = w.staff_id
            WHERE w.deleted_at IS NULL AND w.department = 'hall' AND w.currency = 'AFN'
            GROUP BY b.n, s.full_name
            "#,
        )
        .bind(&lo)
        .bind(&hi)
        .fetch_all(&mut *tx)
        .await?;
        for r in rows {
            taken[r.i as usize].insert(r.category, r.amount);
        }
    }
    let expense_order: Vec<String> =
        sqlx::query_scalar("SELECT name FROM expense_categories WHERE department = 'hall' ORDER BY sort_order, name")
            .fetch_all(&mut *tx)
            .await?;

    let (first_day, all_time_income): (Option<chrono::NaiveDate>, f64) = sqlx::query_as(
        "SELECT LEAST(min(issued_on), (SELECT min(starts_on) FROM month_summaries WHERE deleted_at IS NULL AND department = 'hall')), \
                COALESCE(sum(amount), 0)::float8 FROM receipts \
         WHERE NOT voided AND deleted_at IS NULL AND department = 'hall' AND currency = 'AFN'",
    )
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;

    let periods = totals
        .into_iter()
        .map(|t| {
            let i = t.i as usize;
            Period {
                from: lo[i],
                to: hi[i],
                income: t.income,
                expenses: t.expenses,
                estimated: t.estimated,
                new_members: t.new_members,
                income_by_category: p.categories.then(|| std::mem::take(&mut inc_cat[i])),
                expenses_by_category: p.categories.then(|| std::mem::take(&mut exp_cat[i])),
                withdrawals_by_person: p.categories.then(|| std::mem::take(&mut taken[i])),
            }
        })
        .collect();
    Ok(Json(Periods { periods, first_day, all_time_income, expense_order }))
}
