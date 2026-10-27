import type { Dashboard } from "./api";
import { iso } from "./solar";

// Shown only when the core API cannot be reached, with a visible "sample data" badge.
export function sampleDashboard(period: string): Dashboard {
  const today = new Date();
  const scale = period === "day" ? 1 : period === "month" ? 2 : 14;
  const trend = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 29 + i);
    const wave = Math.sin(i / 3.2) * 1800 + (i % 7 === 5 ? -2600 : 0);
    return { day: iso(d), income: Math.max(2500, 8200 + wave + i * 95 + (i % 9 === 0 ? 9000 : 0)), expenses: 1500 + ((i * 337) % 1400) };
  });
  return {
    period,
    kpis: {
      active_members: 124, active_members_prev: period === "day" ? 121 : 109,
      new_members: 3 * scale, new_members_prev: 2 * scale,
      income: 13730 * scale, income_prev: 11840 * scale,
      expenses: 1690 * scale, expenses_prev: 1980 * scale,
      attendance: 105 * scale, attendance_prev: 98 * scale,
    },
    trend,
    income_by_category: [
      { category: "monthly", amount: 9800 * scale },
      { category: "daily", amount: 1600 * scale },
      { category: "internet", amount: 1200 * scale },
      { category: "hotspot", amount: 830 * scale },
      { category: "books", amount: 300 * scale },
    ],
    income_summary: { today: 13730, month: 21570, year: 621730, all_time: 1840250 },
    members_attention: [
      { member_no: 51034, name: "جواد رحیمی", end_date: iso(new Date(today.getTime() - 3 * 864e5)), days_left: -3 },
      { member_no: 51069, name: "نرگس جعفری", end_date: iso(today), days_left: 0 },
      { member_no: 51102, name: "علی کریمی", end_date: iso(new Date(today.getTime() + 2 * 864e5)), days_left: 2 },
      { member_no: 51117, name: "فاطمه احمدی", end_date: iso(new Date(today.getTime() + 5 * 864e5)), days_left: 5 },
    ],
    members_due_soon: 3,
    members_expired: 1,
    books_attention: [
      { book_title: "کتاب نمونه", card_no: "51026", member_name: "علی رحیمی", due_on: iso(new Date(today.getTime() - 6 * 864e5)), days_left: -6 },
    ],
    books_due_soon: 0,
    books_overdue: 1,
  };
}
