// The core API runs next to the app (bundled in the installer) on this port.
export const API_BASE = import.meta.env.VITE_API_BASE ?? "http://127.0.0.1:8750";

export type Role = "partner" | "manager" | "pec_staff";

export type User = {
  id: string;
  staff_id: string;
  full_name: string;
  username: string;
  role: Role;
  can_see_pec_finance: boolean;
  theme_color: string | null;
  theme_mode: ThemeMode;
  must_change_password: boolean;
};

export type ThemeMode = "system" | "light" | "dark";

export type UserRow = {
  id: string;
  full_name: string;
  username: string;
  role: Role;
  can_see_pec_finance: boolean;
  active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
};

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
  income_summary: { today: number; month: number; year: number; all_time: number };
  members_attention: { member_no: number; name: string; end_date: string; days_left: number }[];
  members_due_soon: number;
  members_expired: number;
  books_attention: { book_title: string; member_no: number; member_name: string; due_on: string; days_left: number }[];
  books_due_soon: number;
  books_overdue: number;
};

/** Income and expenses for consecutive date ranges [from, to). */
export type PeriodRow = {
  from: string; to: string;
  income: number; expenses: number; new_members: number;
  income_by_category?: Record<string, number>;
  expenses_by_category?: Record<string, number>;
  withdrawals_by_person?: Record<string, number>;
};
export type Periods = { periods: PeriodRow[]; first_day: string | null; all_time_income: number; expense_order: string[] };

export type ImportLine = {
  key: string; label: string; kind: "income" | "expense" | "withdrawal"; from_statement: boolean;
  imported: number[]; excel: (number | null)[];
};
export type ImportReport = {
  year: number; committed: boolean; batch_id: string | null;
  members: number; members_new: number; receipts: number; expenses: number; withdrawals: number;
  replaces: string | null; lines: ImportLine[]; warnings: string[];
};

export type Page<T> = { total: number; rows: T[] };

export type MemberRow = {
  member_id: string;
  member_no: number;
  name: string;
  father_name: string | null;
  phone: string | null;
  plan_name: string | null;
  end_date: string | null;
  days_left: number | null;
};

export type LoanRow = {
  loan_id: string;
  book_title: string;
  member_no: number;
  member_name: string;
  phone: string | null;
  loaned_on: string;
  due_on: string;
  days_left: number;
};

export type MemberInput = {
  member_no?: number | null; first_name: string; last_name?: string | null; father_name?: string | null;
  phone?: string | null; field_of_study?: string | null; tazkira_no?: string | null; notes?: string | null;
};
export type PeriodInput = { plan_id: string; start_date?: string | null; fee?: number | null; discount?: number; record_only?: boolean };
export type Saved = { member_id: string | null; member_no: number | null; membership_id: string | null; receipt_id: string | null };
export type Member = Required<{ [K in keyof MemberInput]: Exclude<MemberInput[K], undefined> }> & { id: string; member_no: number; joined_on: string };
export type Period = {
  id: string; plan_name: string; kind: PlanKind; start_date: string; end_date: string;
  fee: number; discount: number; note: string | null; receipt_id: string | null; receipt_no: string | null; removable: boolean;
};
/** The seat and the internet plan each run on their own; a renewal starts after its own last day. */
export type Timeline = { kind: "monthly" | "internet"; end_date: string | null; days_left: number | null; next_start: string };
export type MemberDetail = { member: Member; periods: Period[]; timelines: Timeline[] };
export type PlanKind = "monthly" | "daily" | "internet";
export type Plan = { id: string; kind: PlanKind; name: string; price: number; duration_days: number; active: boolean; sort_order: number };
export type Bill = {
  id: string; receipt_no: string; issued_on: string; amount: number; currency: string; income_category: string;
  description: string | null; voided: boolean; void_reason: string | null; printed_count: number; issued_by: string | null;
  member_id: string | null; member_no: number | null; customer: string | null; father_name: string | null; phone: string | null;
  plan_name: string | null; start_date: string | null; end_date: string | null; fee: number | null; discount: number | null;
};
export type BillPage = { total: number; sum: number; rows: Bill[] };
export type Category = { id: string; name: string };
export type Lines<T> = { total: number; sum: number; rows: T[] };
export type Expense = { id: string; spent_on: string; category: string; description: string | null; amount: number; created_by: string | null; from_excel: boolean; removable: boolean };
export type Person = { id: string; full_name: string; title: string | null };
export type Withdrawal = { id: string; taken_on: string; person: string; amount: number; note: string | null; paid_by: string | null; from_excel: boolean; removable: boolean };
export type Range = { from?: string; to?: string };

const query = (r: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(r).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));

export type ListQuery = { scope: "attention" | "all"; q: string; limit?: number; offset?: number };
const listParams = (p: ListQuery) =>
  new URLSearchParams({ scope: p.scope, q: p.q, limit: String(p.limit ?? 100), offset: String(p.offset ?? 0) });

/** An error answer from the API: `code` is its machine-readable reason (invalid_login, locked...). */
export class ApiError extends Error {
  constructor(public status: number, public code: string, public body: Record<string, unknown> = {}) {
    super(`${status} ${code}`);
  }
}

// The session token lives only in memory and this window's session storage:
// closing the app signs the person out, which suits a shared office laptop.
const TOKEN_KEY = "pezhohesh.session";
let token: string | null = readToken();
let onExpired: () => void = () => {};

function readToken() {
  try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(t: string | null) {
  token = t;
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch { /* memory only */ }
}
export const hasToken = () => token !== null;
export function onSessionExpired(fn: () => void) { onExpired = fn; }

async function request<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: init.method ?? "GET",
    signal: init.signal,
    headers: {
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : "error";
    if (res.status === 401 && code === "unauthorized") onExpired();
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

type Session = { token: string; user: User };

export const api = {
  setupStatus: () => request<{ needs_setup: boolean }>("/setup"),
  setup: (b: { full_name: string; username: string; password: string }) => request<Session>("/setup", { method: "POST", body: b }),
  login: (username: string, password: string) => request<Session>("/auth/login", { method: "POST", body: { username, password } }),
  logout: () => request<void>("/auth/logout", { method: "POST" }),
  me: () => request<User>("/me"),
  changePassword: (current: string, next: string) => request<void>("/me/password", { method: "PUT", body: { current, new: next } }),
  setTheme: (color: string | null) => request<void>("/me/theme", { method: "PUT", body: { color } }),
  setThemeMode: (mode: ThemeMode) => request<void>("/me/theme-mode", { method: "PUT", body: { mode } }),
  users: () => request<UserRow[]>("/users"),
  createUser: (b: { full_name: string; username: string; password: string; role: Role; can_see_pec_finance: boolean }) =>
    request<{ id: string }>("/users", { method: "POST", body: b }),
  updateUser: (id: string, b: Partial<{ role: Role; active: boolean; can_see_pec_finance: boolean; reset_password: string }>) =>
    request<void>(`/users/${id}`, { method: "PUT", body: b }),
  dashboard: (params: Record<string, string>, signal?: AbortSignal) =>
    request<Dashboard>(`/dashboard?${new URLSearchParams(params)}`, { signal }),
  periods: (bounds: string[], categories: boolean, signal?: AbortSignal) =>
    request<Periods>(`/reports/periods?${new URLSearchParams({ bounds: bounds.join(","), categories: String(categories) })}`, { signal }),
  importExcel: async (file: File, o: { year: number; password: string; commit: boolean }) => {
    // The book goes up as-is; the API opens it (with its password) and reads it.
    const res = await fetch(`${API_BASE}/api/v1/import/excel?${new URLSearchParams({ year: String(o.year), commit: String(o.commit), file_name: file.name })}`, {
      method: "POST",
      headers: {
        "content-type": "application/octet-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(o.password ? { "x-excel-password": encodeURIComponent(o.password) } : {}),
      },
      body: await file.arrayBuffer(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(res.status, typeof data.error === "string" ? data.error : "error", data);
    return data as ImportReport;
  },
  members: (p: ListQuery, signal?: AbortSignal) => request<Page<MemberRow>>(`/members?${listParams(p)}`, { signal }),
  loans: (p: ListQuery, signal?: AbortSignal) => request<Page<LoanRow>>(`/loans?${listParams(p)}`, { signal }),

  nextMemberNo: () => request<number>("/members/next-no"),
  createMember: (member: MemberInput, period: PeriodInput | null) => request<Saved>("/members", { method: "POST", body: { member, period } }),
  member: (id: string, signal?: AbortSignal) => request<MemberDetail>(`/members/${id}`, { signal }),
  updateMember: (id: string, m: MemberInput) => request<void>(`/members/${id}`, { method: "PUT", body: m }),
  addPeriod: (id: string, p: PeriodInput) => request<Saved>(`/members/${id}/periods`, { method: "POST", body: p }),
  deletePeriod: (id: string) => request<void>(`/periods/${id}`, { method: "DELETE" }),
  dailySeat: (b: { member_id?: string | null; guest_name?: string | null } & PeriodInput) => request<Saved>("/daily-seats", { method: "POST", body: b }),
  otherBill: (b: { income_category: string; amount: number; description?: string }) => request<Saved>("/bills", { method: "POST", body: b }),
  bills: (p: Range & { q?: string; limit?: number; offset?: number }, signal?: AbortSignal) =>
    request<BillPage>(`/bills?${query(p)}`, { signal }),
  bill: (id: string) => request<Bill>(`/bills/${id}`),
  billPrinted: (id: string) => request<void>(`/bills/${id}/printed`, { method: "POST" }),
  voidBill: (id: string, reason: string) => request<void>(`/bills/${id}/void`, { method: "POST", body: { reason } }),
  plans: () => request<Plan[]>("/plans"),
  createPlan: (p: Omit<Plan, "id" | "sort_order"> & { sort_order?: number }) => request<string>("/plans", { method: "POST", body: p }),
  updatePlan: (id: string, p: Omit<Plan, "id">) => request<void>(`/plans/${id}`, { method: "PUT", body: p }),
  categories: () => request<Category[]>("/expense-categories"),
  createCategory: (name: string) => request<string>("/expense-categories", { method: "POST", body: { name } }),
  expenses: (r: Range, signal?: AbortSignal) => request<Lines<Expense>>(`/expenses?${query(r)}`, { signal }),
  createExpense: (e: { category_id: string; spent_on?: string; amount: number; description?: string }) => request<string>("/expenses", { method: "POST", body: e }),
  deleteExpense: (id: string) => request<void>(`/expenses/${id}`, { method: "DELETE" }),
  staff: () => request<Person[]>("/staff"),
  withdrawals: (r: Range, signal?: AbortSignal) => request<Lines<Withdrawal>>(`/withdrawals?${query(r)}`, { signal }),
  createWithdrawal: (w: { staff_id: string; taken_on?: string; amount: number; note?: string }) => request<string>("/withdrawals", { method: "POST", body: w }),
  deleteWithdrawal: (id: string) => request<void>(`/withdrawals/${id}`, { method: "DELETE" }),
};

/** Persian message for an API error code. */
export function errorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "هستهٔ سیستم در دسترس نیست. چند لحظه بعد دوباره امتحان کنید.";
  switch (e.code) {
    case "invalid_login": return "نام کاربری یا رمز درست نیست.";
    case "locked": {
      const min = Math.max(1, Math.ceil(Number(e.body.retry_after_seconds ?? 300) / 60));
      return `به خاطر چند تلاش اشتباه، این حساب برای ${new Intl.NumberFormat("en-US").format(min)} دقیقه قفل شد.`;
    }
    case "password_too_short": return "رمز باید دست‌کم 8 حرف باشد.";
    case "bad_username": return "نام کاربری 3 تا 32 حرف انگلیسی، عدد، نقطه یا خط تیره باشد.";
    case "username_taken": return "این نام کاربری قبلاً گرفته شده.";
    case "name_required": return "نام کامل را بنویسید.";
    case "wrong_password": return "رمز فعلی درست نیست.";
    case "last_partner": return "دست‌کم یک شریک فعال باید بماند.";
    case "already_set_up": return "حساب اول قبلاً ساخته شده. وارد شوید.";
    case "forbidden": return "شما به این بخش دسترسی ندارید.";
    case "member_no_taken": return "این شمارهٔ عضویت قبلاً به عضو دیگری داده شده.";
    case "bad_member_no": return "شمارهٔ عضویت باید یک عدد مثبت باشد.";
    case "bad_plan": return "این نوع عضویت پیدا نشد یا غیرفعال است.";
    case "bad_amount": return "مبلغ درست نیست (تخفیف نباید از مبلغ بیشتر باشد).";
    case "bad_category": return "نوع درآمد درست نیست.";
    case "reason_required": return "دلیل باطل کردن را بنویسید.";
    case "already_voided": return "این بل قبلاً باطل شده.";
    case "void_today_only": return "مدیر فقط بل‌های امروز را می‌تواند باطل کند. برای بل‌های قبلی از یکی از شرکا بخواهید.";
    case "remove_today_only": return "مدیر فقط چیزی را که امروز ثبت شده می‌تواند پاک کند.";
    case "void_the_bill": return "این دوره بل دارد؛ اول بل آن را باطل کنید.";
    case "not_found": return "پیدا نشد؛ شاید کسی دیگر آن را تغییر داده باشد.";
    case "no_device": return "شمارهٔ بل این کمپیوتر تنظیم نشده.";
    case "postgres_down": return "دیتابیس (PostgreSQL) جواب نمی‌دهد. چند لحظه بعد دوباره امتحان کنید.";
    case "starting": return "هستهٔ سیستم هنوز در حال آماده شدن است. چند لحظه بعد دوباره امتحان کنید.";
    case "excel_password_needed": return "این فایل اکسل رمز دارد. رمز فایل را بنویسید.";
    case "wrong_excel_password": return "رمز فایل اکسل درست نیست.";
    case "not_excel": return "این فایل اکسل (.xlsx) نیست یا خراب است.";
    case "sheet_missing_monthly": return "شیت «عضویت ماهانه» در این فایل پیدا نشد.";
    case "sheet_missing_statement": return "شیت «محاسبات» در این فایل پیدا نشد.";
    case "bad_year": return "سال را درست بنویسید، مثلاً 1405.";
    default: return "کار انجام نشد. دوباره امتحان کنید.";
  }
}

export const ROLE_LABEL: Record<Role, string> = {
  partner: "شریک",
  manager: "مدیر",
  pec_staff: "خدمات تحصیلی",
};
