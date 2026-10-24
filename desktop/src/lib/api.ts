// The core API runs next to the app (bundled in the installer) on this port.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8750";

export type Dashboard = {
  period: string;
  kpis: {
    active_members: number; active_members_prev: number;
    new_members: number; new_members_prev: number;
    income: number; income_prev: number;
    expenses: number; expenses_prev: number;
    attendance: number; attendance_prev: number;
  };
  trend: { day: string; income: number; expenses: number }[];
  income_by_category: { category: string; amount: number }[];
  expiring: { member_no: number; name: string; end_date: string }[];
  overdue_books: number;
};

export async function fetchDashboard(params: Record<string, string>, signal?: AbortSignal): Promise<Dashboard> {
  const q = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/api/v1/dashboard?${q}`, { signal });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}
