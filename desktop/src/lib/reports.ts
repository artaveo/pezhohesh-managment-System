import { api, type PeriodRow } from "./api";

export type Range = { from: string; to: string };
export type Sum = {
  income: number; expenses: number; new_members: number;
  /** Hand-made balance estimates of months whose detail was lost (1404). */
  estimated: number;
  income_by_category: Record<string, number>;
  /** The till when the range starts (what the months before left), worked out by the API. */
  carried: number;
  /** Book guarantees held at the end of the range (money held for borrowers, not income). */
  deposits: { cash: number; books: number; people: number };
  expenses_by_category: Record<string, number>;
  withdrawals_by_person: Record<string, number>;
};

/**
 * Totals for any set of ranges (they may overlap or leave gaps): the API is asked for the
 * consecutive pieces between all their boundaries, and each range adds up its own pieces.
 */
export async function loadRanges(ranges: Range[], categories: boolean, signal?: AbortSignal) {
  const bounds = [...new Set(ranges.flatMap((r) => [r.from, r.to]))].sort();
  const res = await api.periods(bounds, categories, signal);
  const sum = (r: Range) => total(res.periods.filter((p) => p.from >= r.from && p.to <= r.to));
  return { res, sum };
}

export function total(rows: PeriodRow[]): Sum {
  const s: Sum = { income: 0, expenses: 0, estimated: 0, new_members: 0, carried: 0, deposits: { cash: 0, books: 0, people: 0 }, income_by_category: {}, expenses_by_category: {}, withdrawals_by_person: {} };
  let end = "";
  let start = "";
  for (const p of rows) {
    // The opening till is a stock, not a flow: the one at the first piece's start.
    if (!start || p.from < start) { start = p.from; s.carried = p.carried ?? 0; }
    // Guarantees are a stock, not a flow: what was held when the last piece ended.
    if (p.to > end) { end = p.to; s.deposits = { cash: p.deposits_cash ?? 0, books: p.deposits_books ?? 0, people: p.deposits_people ?? 0 }; }
    s.income += p.income;
    s.expenses += p.expenses;
    s.estimated += p.estimated ?? 0;
    s.new_members += p.new_members;
    for (const [k, v] of Object.entries(p.income_by_category ?? {})) s.income_by_category[k] = (s.income_by_category[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.expenses_by_category ?? {})) s.expenses_by_category[k] = (s.expenses_by_category[k] ?? 0) + v;
    for (const [k, v] of Object.entries(p.withdrawals_by_person ?? {})) s.withdrawals_by_person[k] = (s.withdrawals_by_person[k] ?? 0) + v;
  }
  return s;
}

/** Category map as bars, largest first. */
export const asBars = (m: Record<string, number>) =>
  Object.entries(m).map(([category, amount]) => ({ category, amount })).filter((d) => d.amount).sort((a, b) => b.amount - a.amount);

/** The balance (بیلانس): income minus expenses, plus the estimate of a month whose detail was lost. */
export const balance = (s: Sum) => s.income - s.expenses + s.estimated;
