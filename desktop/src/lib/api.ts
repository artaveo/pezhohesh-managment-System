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
  /** The sections of the app this person sees; partners see all. */
  sections: Section[];
};

/** Sections a partner can give the manager or the education staff (see the users page). */
export type Section =
  | "dashboard" | "memberships" | "members" | "registrations" | "books" | "hotspot" | "inbox"
  | "receipts" | "expenses" | "salaries" | "shares" | "reports" | "pec";
export const SECTION_LABEL: Record<Section, string> = {
  dashboard: "داشبورد (درآمد و مصرف)", memberships: "پذیرش و تمدید", members: "اعضا", registrations: "ثبت‌نام‌ها",
  books: "امانت کتاب", hotspot: "کارت هاتسپات", inbox: "رسیده از موبایل", receipts: "بل‌ها",
  expenses: "مصارف و برداشت‌ها", salaries: "معاش کارمندان", shares: "سهم شرکا", reports: "گزارش مالی", pec: "خدمات تحصیلی",
};
export type RoleAccess = { roles: { role: Role; possible: Section[]; sections: Section[] }[] };

/** A photo or tazkira a member sent from their phone, waiting at the desk. */
export type Arrived = {
  id: string; received_at: string; member_no: number | null; phone: string | null; kind: DocKind;
  mime_type: string; size_bytes: number;
  member_id: string | null; member_name: string | null; member_phone: string | null; phone_matches: boolean;
  by_phone_id: string | null; by_phone_name: string | null; by_phone_no: number | null;
};
export type PhoneUpload = { enabled: boolean; port: number; addresses: { url: string; hotspot: boolean }[]; hotspot_url: string };
export type K50Config = { enabled: boolean; ip: string; port: number; machine: number; comm_key: number; digits: number };
export type K50Comparison = {
  device_users: number; in_app: number; not_in_app: number; differs: number; admins: number; zero_padded: number; padded_width: number | null;
  rows: { no: string; device_name: string; app_name: string | null; admin: boolean; state: "same" | "differs" | "missing" }[];
};
export type K50Round = { at: string | null; ok: boolean; error: string | null; pushed: number; failed: number; punches: number };
export type K50Status = {
  config: K50Config; last: K50Round | null; pending: number; sent: number; punches_today: number;
  errors: { member_no: number; name: string; error: string; error_at: string }[];
};
/** What the device answered (the rest of the fields depend on the question). */
export type K50Answer = { ok: boolean; error: string | null; [k: string]: unknown };
export type K50Info = K50Answer & { serial?: string; firmware?: string; users?: number; fingers?: number; logs?: number; time?: string };
export type K50User = K50Answer & { exists?: boolean; enabled?: boolean; fingers?: number; valid?: { start: string; end: string } | null };
export type MemberK50 = {
  configured: boolean; auto: boolean; enabled: boolean; start_date: string | null; end_date: string | null;
  sent: { member_no: number; pushed_start: string | null; pushed_end: string | null; pushed_enabled: boolean | null; pushed_at: string | null;
    valid_dates: boolean | null; fingers: number | null; error: string | null; error_at: string | null } | null;
  visits: string[];
};
export type RestorePoint = { path: string; name: string; kind: "folder" | "usb" | "gdrive"; folder: string; size: number; modified: string | null };

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
  books_attention: { book_title: string; card_no: string; member_name: string; due_on: string; days_left: number }[];
  books_due_soon: number;
  books_overdue: number;
};

/** Income and expenses for consecutive date ranges [from, to). */
export type PeriodRow = {
  from: string; to: string;
  income: number; expenses: number; estimated: number; new_members: number;
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
export type PersonRow = { id: string; full_name: string; title: string | null; usernames: string[]; withdrawals: number; withdrawn: number };

export type RegKind = "monthly" | "daily" | "internet";
export type Registration = {
  id: string; day: string; kind: RegKind; plan_name: string;
  member_id: string | null; member_no: number | null; name: string; phone: string | null;
  start_date: string; end_date: string; amount: number;
  receipt_id: string | null; receipt_no: string | null; first: boolean; record_only: boolean;
};
export type RegSummary = { daily: number; monthly_new: number; monthly_renewed: number; internet: number; amount: number };
export type RegQuery = { from?: string; to?: string; kind?: RegKind; q?: string; limit?: number; offset?: number };

export type MemberRow = {
  /** null: a guest's daily seat (only on the full list, with `guests`). */
  member_id: string | null;
  member_no: number | null;
  name: string;
  father_name: string | null;
  phone: string | null;
  plan_name: string | null;
  end_date: string | null;
  days_left: number | null;
  /** Start of the latest period of any kind, daily seats too. */
  last_start: string | null;
  /** A guest's daily seat: its bill. */
  receipt_id: string | null;
};

export type LoanRow = {
  loan_id: string;
  book_title: string;
  /** Member number, or the lending card (p-105) of a guarantee. */
  card_no: string;
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
export type PeriodInput = { plan_id: string; start_date?: string | null; fee?: number | null; discount?: number; record_only?: boolean; ahead?: boolean };
export type Saved = { member_id: string | null; member_no: number | null; membership_id: string | null; receipt_id: string | null };
export type Member = Required<{ [K in keyof MemberInput]: Exclude<MemberInput[K], undefined> }> & { id: string; member_no: number; joined_on: string };
export type Period = {
  id: string; plan_name: string; kind: PlanKind; start_date: string; end_date: string;
  fee: number; discount: number; note: string | null; receipt_id: string | null; receipt_no: string | null; removable: boolean;
};
/** The seat and the internet plan each run on their own; a renewal starts after its own last day. */
export type Timeline = { kind: "monthly" | "internet"; end_date: string | null; days_left: number | null; next_start: string };
export type DocKind = "photo" | "tazkira_front" | "tazkira_back" | "other";
export type MemberDocument = { id: string; kind: DocKind; mime_type: string; size_bytes: number; created_at: string };
export type MemberDetail = { member: Member; periods: Period[]; timelines: Timeline[]; documents: MemberDocument[] };
export type PlanKind = "monthly" | "daily" | "internet";
export type Plan = { id: string; kind: PlanKind; name: string; price: number; duration_days: number; active: boolean; sort_order: number };
export type Bill = {
  id: string; receipt_no: string; issued_on: string; amount: number; currency: string; income_category: string;
  description: string | null; voided: boolean; void_reason: string | null; printed_count: number; issued_by: string | null;
  member_id: string | null; member_no: number | null; customer: string | null; father_name: string | null; phone: string | null;
  card_no: string | null; book_loan_id: string | null;
  plan_name: string | null; start_date: string | null; end_date: string | null; fee: number | null; discount: number | null;
};
export type BillPage = { total: number; sum: number; rows: Bill[] };
export type Category = { id: string; name: string };
export type Lines<T> = { total: number; sum: number; rows: T[] };
export type Expense = { id: string; spent_on: string; category_id: string; category: string; description: string | null; amount: number; created_by: string | null; from_excel: boolean; removable: boolean };
export type Person = { id: string; full_name: string; title: string | null };
export type SalaryMonth = { year: number; month: number; accrued: number; taken: number };
export type SalaryPayment = { id: string; day: string; amount: number; note: string | null; source: "expense" | "withdrawal" };
export type SalaryPerson = {
  id: string; full_name: string; title: string | null; monthly_salary: number;
  category_id: string | null; category: string | null;
  /** First day of the Solar month the salary starts. */
  salary_from: string | null; active: boolean;
  /** Every month of the range from the first salary month up to this month, oldest first. */
  months: SalaryMonth[];
  /** Payments of the range, oldest first. */
  payments: SalaryPayment[];
  /** Salary minus what was paid before the range (positive: owed to the person), and up to today. */
  opening: number; balance: number; last_paid: string | null;
};
export type SalaryPage = { this_year: number; this_month: number; people: SalaryPerson[]; categories: { id: string; name: string }[] };
export type SalaryInput = {
  full_name?: string; title?: string; monthly_salary: number; category_id: string; from: string; active: boolean;
  /** On a change: a day of the first month the new amount counts from. */
  amount_from?: string;
};
export type ExpenseInput = { category_id: string; spent_on?: string; amount: number; description?: string };
export type WithdrawalInput = { staff_id: string; taken_on?: string; amount: number; note?: string };
export type AuditFilter = { from?: string; to?: string; table?: string; user?: string; q?: string; import?: boolean; before?: number };
export type AuditChange = { field: string; before: unknown; after: unknown };
export type AuditLine = {
  id: number; at: string; user: string | null; table: string; row_id: string | null;
  kind: "insert" | "update" | "remove" | "restore" | "void";
  label: string; amount: unknown; reason: string | null; member_id: string | null; changes: AuditChange[]; restorable: boolean;
};
export type AuditPage = { lines: AuditLine[]; more: boolean; users: { id: string; name: string }[] };
export type MonthSummary = { id: string; solar_year: number; solar_month: number; starts_on: string; net_balance: number; note: string | null };
export type Withdrawal = { id: string; taken_on: string; staff_id: string; person: string; amount: number; note: string | null; paid_by: string | null; from_excel: boolean; removable: boolean };
export type Range = { from?: string; to?: string };
export type BackupPlan = { folders: string[]; usb: boolean; gdrive: boolean; every_hours: number; keep: number; usb_drive?: string | null };
export type BackupOutcome = {
  at: string | null; ok: boolean;
  folders: { kind: "folder" | "usb" | "gdrive"; folder: string; file: string | null; error: string | null }[];
};
export type OnlineOutcome = { at: string | null; ok: boolean; error: string | null; seconds: number | null };
export type OnlineStatus = { host: string | null; every_hours: number; last: OnlineOutcome | null };
export type BackupStatus = {
  plan: BackupPlan; last: BackupOutcome | null; pg_dump: string;
  usb: string | null; gdrive: string | null; drives: { root: string; prepared: boolean; picked: boolean; removable: boolean }[];
  files: { name: string; size: number; modified: string | null }[];
};
export type HotspotCard = { volume_gb: number; price: number; active: boolean; bought: number; sold: number; in_hand: number };
export type HotspotCards = { cost_per_gb: number; cards: HotspotCard[] };
export type CardCount = { volume_gb: number; quantity: number };
export type HotspotBuy = {
  id: string; purchased_on: string; supplier_bill_no: string | null; bill_gb: number | null; extra_cost: number; note: string | null;
  cards: string; card_count: number; gb: number; cost: number; created_by: string | null; removable: boolean;
};
export type HotspotSale = {
  receipt_id: string; receipt_no: string; sold_on: string; cards: string; card_count: number; gb: number;
  sales: number; cost: number; profit: number; voided: boolean; created_by: string | null;
};
export type HotspotSales = {
  summary: { bought: number; sales: number; cost: number; profit: number; cards_sold: number; gb_sold: number };
  rows: HotspotSale[];
};
export type BookRules = { loan_days: number; weekly_fee: number; fine_per_day: number };
export type DepositKind = "cash" | "book" | "person";
export type Deposit = {
  id: string; code: string; kind: DepositKind; name: string; father_name: string | null; phone: string | null;
  member_id: string | null; member_no: number | null; amount: number | null; deposit_book: string | null; guarantor: string | null;
  note: string | null; received_on: string; returned_on: string | null; open_loans: number; removable: boolean;
};
export type DepositPage = { total: number; cash_held: number; rows: Deposit[] };
export type DepositInput = {
  kind: DepositKind; code?: string; name: string; father_name?: string; phone?: string;
  amount?: number; deposit_book?: string; guarantor?: string; note?: string; received_on?: string;
};
/** Who may borrow: an open guarantee (its card) or a study-hall member. */
export type Borrower = {
  kind: "deposit" | "member"; id: string; card_no: string; name: string; father_name: string | null; phone: string | null;
  guarantee: string | null; open_loans: number;
  /** Members: a seat or internet period running today. */
  active: boolean;
};
export type LoanInput = { deposit_id?: string; member_id?: string; book_title: string; loaned_on?: string; due_on?: string; weekly_fee?: number; note?: string };
export type Charge = { weeks: number; days_late: number; fee: number; fine: number };
export type Loan = {
  id: string; book_title: string; card_no: string; borrower: string; phone: string | null;
  loaned_on: string; due_on: string; returned_on: string | null; weekly_fee: number; fee_paid: number; fine: number;
  note: string | null; receipt_id: string | null; removable: boolean; charge: Charge | null;
};

const query = (r: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(r).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));

export type ListQuery = { scope: "attention" | "all"; q: string; limit?: number; offset?: number; guests?: boolean };
const listParams = (p: ListQuery) =>
  new URLSearchParams({ scope: p.scope, q: p.q, limit: String(p.limit ?? 100), offset: String(p.offset ?? 0), guests: String(!!p.guests) });

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

/** `file` sends a file as it is (instead of JSON); `blob` returns the answer as a file. */
async function request<T>(path: string, init: { method?: string; body?: unknown; file?: Blob; blob?: boolean; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`${API_BASE}/api/v1${path}`, {
    method: init.method ?? "GET",
    signal: init.signal,
    headers: {
      ...(init.file ? { "content-type": init.file.type || "application/octet-stream" } : init.body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: init.file ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined),
  });
  if (res.status === 204) return undefined as T;
  if (res.ok && init.blob) return (await res.blob()) as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = typeof data.error === "string" ? data.error : res.status === 413 ? "file_too_large" : "error";
    if (res.status === 401 && code === "unauthorized") onExpired();
    throw new ApiError(res.status, code, data);
  }
  return data as T;
}

type Session = { token: string; user: User };

const why = (reason?: string) => reason ? `?${query({ reason })}` : "";

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
  people: () => request<PersonRow[]>("/people"),
  mergePeople: (from: string, into: string) => request<void>("/people/merge", { method: "POST", body: { from, into } }),
  createUser: (b: { full_name: string; username: string; password: string; role: Role; can_see_pec_finance: boolean; staff_id?: string }) =>
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
  addDocument: (member: string, kind: DocKind, file: Blob) =>
    request<{ id: string }>(`/members/${member}/documents/${kind}`, { method: "POST", file }),
  /** The file itself (a photo or a scan); the page shows it through an object URL. */
  documentFile: (id: string) => request<Blob>(`/documents/${id}`, { blob: true }),
  deleteDocument: (id: string) => request<void>(`/documents/${id}`, { method: "DELETE" }),
  members: (p: ListQuery, signal?: AbortSignal) => request<Page<MemberRow>>(`/members?${listParams(p)}`, { signal }),
  loans: (p: ListQuery, signal?: AbortSignal) => request<Page<LoanRow>>(`/loans?${listParams(p)}`, { signal }),

  registrations: (p: RegQuery, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ limit: String(p.limit ?? 100), offset: String(p.offset ?? 0) });
    if (p.from) qs.set("from", p.from);
    if (p.to) qs.set("to", p.to);
    if (p.kind) qs.set("kind", p.kind);
    if (p.q?.trim()) qs.set("q", p.q.trim());
    return request<Page<Registration> & { summary: RegSummary }>(`/registrations?${qs}`, { signal });
  },
  nextMemberNo: () => request<number>("/members/next-no"),
  createMember: (member: MemberInput, period: PeriodInput | null) => request<Saved>("/members", { method: "POST", body: { member, period } }),
  member: (id: string, signal?: AbortSignal) => request<MemberDetail>(`/members/${id}`, { signal }),
  updateMember: (id: string, m: MemberInput) => request<void>(`/members/${id}`, { method: "PUT", body: m }),
  addPeriod: (id: string, p: PeriodInput) => request<Saved>(`/members/${id}/periods`, { method: "POST", body: p }),
  deletePeriod: (id: string, reason?: string) => request<void>(`/periods/${id}${why(reason)}`, { method: "DELETE" }),
  updatePeriod: (id: string, p: { start_date: string; end_date: string; note?: string | null }) => request<void>(`/periods/${id}`, { method: "PUT", body: p }),
  deleteMember: (id: string, reason?: string) => request<void>(`/members/${id}${why(reason)}`, { method: "DELETE" }),
  restoreMember: (id: string) => request<void>(`/members/${id}/restore`, { method: "POST" }),
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
  expenses: (r: Range & { offset?: number }, signal?: AbortSignal) => request<Lines<Expense>>(`/expenses?${query(r)}`, { signal }),
  createExpense: (e: ExpenseInput) => request<string>("/expenses", { method: "POST", body: e }),
  updateExpense: (id: string, e: ExpenseInput) => request<void>(`/expenses/${id}`, { method: "PUT", body: e }),
  deleteExpense: (id: string, reason?: string) => request<void>(`/expenses/${id}${why(reason)}`, { method: "DELETE" }),
  restoreExpense: (id: string) => request<void>(`/expenses/${id}/restore`, { method: "POST" }),
  staff: () => request<Person[]>("/staff"),
  salaries: (r: Range = {}, signal?: AbortSignal) => request<SalaryPage>(`/salaries?${query(r)}`, { signal }),
  setSalaryMonth: (id: string, m: { year: number; month: number; amount: number }) => request<void>(`/salaries/${id}/month`, { method: "PUT", body: m }),
  createSalary: (s: SalaryInput) => request<string>("/salaries", { method: "POST", body: s }),
  updateSalary: (id: string, s: SalaryInput) => request<void>(`/salaries/${id}`, { method: "PUT", body: s }),
  withdrawals: (r: Range & { staff_id?: string; offset?: number }, signal?: AbortSignal) => request<Lines<Withdrawal>>(`/withdrawals?${query(r)}`, { signal }),
  createWithdrawal: (w: WithdrawalInput) => request<string>("/withdrawals", { method: "POST", body: w }),
  updateWithdrawal: (id: string, w: WithdrawalInput) => request<void>(`/withdrawals/${id}`, { method: "PUT", body: w }),
  deleteWithdrawal: (id: string, reason?: string) => request<void>(`/withdrawals/${id}${why(reason)}`, { method: "DELETE" }),
  restoreWithdrawal: (id: string) => request<void>(`/withdrawals/${id}/restore`, { method: "POST" }),
  audit: (f: AuditFilter, signal?: AbortSignal) => request<AuditPage>(`/audit?${query({ ...f, import: f.import ? "true" : undefined })}`, { signal }),
  monthSummaries: (year: number, signal?: AbortSignal) => request<MonthSummary[]>(`/month-summaries?year=${year}`, { signal }),
  updateMonthSummary: (id: string, b: { net_balance: number; note?: string | null }) => request<void>(`/month-summaries/${id}`, { method: "PUT", body: b }),
  bookRules: () => request<BookRules>("/book-rules"),
  setBookRules: (r: BookRules) => request<void>("/book-rules", { method: "PUT", body: r }),
  bookTitles: () => request<string[]>("/book-titles"),
  borrowers: (q: string, signal?: AbortSignal) => request<Borrower[]>(`/borrowers?${query({ q })}`, { signal }),
  deposits: (p: { scope: "open" | "all"; q: string }, signal?: AbortSignal) => request<DepositPage>(`/deposits?${query(p)}`, { signal }),
  nextDepositCode: (kind: DepositKind) => request<string>(`/deposits/next-code?${query({ kind })}`),
  createDeposit: (d: DepositInput) => request<{ id: string; code: string }>("/deposits", { method: "POST", body: d }),
  returnDeposit: (id: string, returned_on?: string) => request<void>(`/deposits/${id}/return`, { method: "POST", body: { returned_on } }),
  deleteDeposit: (id: string) => request<void>(`/deposits/${id}`, { method: "DELETE" }),
  lend: (l: LoanInput) => request<string>("/book-loans", { method: "POST", body: l }),
  loan: (id: string, on?: string, signal?: AbortSignal) => request<Loan>(`/book-loans/${id}?${query({ on })}`, { signal }),
  returnLoan: (id: string, b: { returned_on?: string; fee: number; fine: number }) =>
    request<{ receipt_id: string | null }>(`/book-loans/${id}/return`, { method: "POST", body: b }),
  deleteLoan: (id: string) => request<void>(`/book-loans/${id}`, { method: "DELETE" }),
  backup: () => request<BackupStatus>("/backup"),
  setBackupPlan: (p: BackupPlan) => request<void>("/backup", { method: "PUT", body: p }),
  prepareUsb: (root: string) => request<void>("/backup/usb", { method: "POST", body: { root } }),
  backupNow: () => request<BackupOutcome>("/backup", { method: "POST" }),
  restorePoints: () => request<RestorePoint[]>("/backup/restore"),
  restore: (path: string) => request<{ before: string | null; files: number }>("/backup/restore", { method: "POST", body: { path, confirm: true } }),
  roleAccess: () => request<RoleAccess>("/role-access"),
  setRoleAccess: (role: Role, sections: Section[]) => request<void>("/role-access", { method: "PUT", body: { role, sections } }),
  inbox: (signal?: AbortSignal) => request<Arrived[]>("/inbox", { signal }),
  inboxCount: () => request<number>("/inbox/count"),
  inboxFile: (id: string) => request<Blob>(`/inbox/${id}/file`, { blob: true }),
  acceptArrived: (id: string, member_id: string, kind?: DocKind) => request<void>(`/inbox/${id}/accept`, { method: "POST", body: { member_id, kind } }),
  rejectArrived: (id: string) => request<void>(`/inbox/${id}/reject`, { method: "POST" }),
  phoneUpload: () => request<PhoneUpload>("/phone-upload"),
  setPhoneUpload: (enabled: boolean) => request<void>("/phone-upload", { method: "PUT", body: { enabled } }),
  /** A QR code (SVG) for the sticker. */
  qr: (text: string) => request<Blob>(`/qr?${new URLSearchParams({ text })}`, { blob: true }),
  online: () => request<OnlineStatus>("/online"),
  k50: () => request<K50Status>("/k50"),
  setK50: (c: K50Config) => request<void>("/k50", { method: "PUT", body: c }),
  testK50: (c: K50Config) => request<K50Info>("/k50/test", { method: "POST", body: c }),
  scanK50: () => request<{ ip: string; via: string }[]>("/k50/scan", { method: "POST" }),
  syncK50: () => request<K50Round>("/k50/sync", { method: "POST" }),
  /** Ok: the comparison; Err: why the device could not be read. */
  compareK50: () => request<{ Ok?: K50Comparison; Err?: string }>("/k50/compare", { method: "POST" }),
  k50Time: () => request<K50Answer & { time?: string }>("/k50/time", { method: "POST" }),
  memberK50: (id: string) => request<MemberK50>(`/members/${id}/k50`),
  checkMemberK50: (id: string) => request<K50User>(`/members/${id}/k50/check`, { method: "POST" }),
  pushMemberK50: (id: string) => request<K50Answer>(`/members/${id}/k50/push`, { method: "POST" }),
  enrollK50: (id: string, finger: number) => request<K50Answer>(`/members/${id}/k50/enroll`, { method: "POST", body: { finger } }),
  setOnline: (p: { every_hours: number; url?: string }) => request<void>("/online", { method: "PUT", body: p }),
  onlineNow: () => request<OnlineOutcome>("/online", { method: "POST" }),
  hotspotCards: (signal?: AbortSignal) => request<HotspotCards>("/hotspot/cards", { signal }),
  setHotspotCards: (p: { cost_per_gb: number; cards: { volume_gb: number; price: number; active: boolean }[] }) =>
    request<void>("/hotspot/cards", { method: "PUT", body: p }),
  hotspotBuys: (r: Range, signal?: AbortSignal) => request<HotspotBuy[]>(`/hotspot/buys?${query(r)}`, { signal }),
  createHotspotBuy: (b: { purchased_on?: string; supplier_bill_no?: string; bill_gb?: number | null; extra_cost?: number; note?: string; lines: CardCount[] }) =>
    request<string>("/hotspot/buys", { method: "POST", body: b }),
  deleteHotspotBuy: (id: string) => request<void>(`/hotspot/buys/${id}`, { method: "DELETE" }),
  hotspotSales: (r: Range, signal?: AbortSignal) => request<HotspotSales>(`/hotspot/sales?${query(r)}`, { signal }),
  createHotspotSale: (lines: CardCount[]) =>
    request<{ receipt_id: string; sales: number; cost: number; profit: number }>("/hotspot/sales", { method: "POST", body: { lines } }),
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
    case "section_closed": return "این بخش برای نقش شما بسته است. یکی از شرکا می‌تواند آن را در «کاربران» باز کند.";
    case "safety_backup_failed": return "اول یک پشتیبان تازه از وضع فعلی گرفته می‌شود، ولی نشد؛ پس چیزی برگردانده نشد. پوشه‌های پشتیبان را ببینید.";
    case "restore_failed": return "برگرداندن نشد و دیتابیس همان‌طور که بود ماند. جزئیات در api.log است.";
    case "restoring": return "دیتابیس در حال برگرداندن از پشتیبان است. چند لحظه صبر کنید.";
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
    case "member_has_open_loans": return "این عضو هنوز کتاب یا ضمانتی نزد کتابخانه دارد؛ اول آن را برگشت بزنید، بعد عضو را حذف کنید.";
    case "partners_only": return "برداشت فقط برای شرکا است. پول کارمند را از صفحهٔ «معاش کارمندان» با «پرداخت» ثبت کنید.";
    case "not_found": return "پیدا نشد؛ شاید کسی دیگر آن را تغییر داده باشد.";
    case "no_device": return "شمارهٔ بل این کمپیوتر تنظیم نشده.";
    case "postgres_down": return "دیتابیس (PostgreSQL) جواب نمی‌دهد. چند لحظه بعد دوباره امتحان کنید.";
    case "starting": return "هستهٔ سیستم هنوز در حال آماده شدن است. چند لحظه بعد دوباره امتحان کنید.";
    case "code_taken": return "این شمارهٔ کارت قبلاً به کس دیگری داده شده.";
    case "bad_code": return "شمارهٔ کارت حداکثر 20 حرف باشد.";
    case "bad_kind": return "نوع ضمانت درست نیست.";
    case "bad_days": return "تعداد روزها 1 تا 366 باشد.";
    case "deposit_book_required": return "بنویسید چه کتاب‌هایی ضمانت گذاشته شده (مثلاً 3 جلد).";
    case "guarantor_required": return "نام ضامن را بنویسید.";
    case "title_required": return "نام کتاب را بنویسید.";
    case "borrower_required": return "اول امانت‌گیرنده را انتخاب کنید.";
    case "deposit_returned": return "ضمانت این کارت پس داده شده؛ برای امانت تازه ضمانت تازه بگیرید.";
    case "has_open_loans": return "هنوز کتابی از این کارت برنگشته؛ اول کتاب‌ها را برگشت بزنید.";
    case "has_loans": return "با این کارت کتاب امانت داده شده؛ پاک نمی‌شود. اگر تمام شده، ضمانت را پس بدهید.";
    case "already_returned": return "این قبلاً برگشت خورده.";
    case "before_start": return "این تاریخ پیش از تاریخ شروع است.";
    case "future_date": return "تاریخ آینده قبول نمی‌شود.";
    case "bad_backup_plan": return "تعداد نسخه‌ها باید بین 1 و 365 باشد.";
    case "bad_file_type": return "این فایل عکس (JPG، PNG یا WebP) یا PDF نیست. عکس عضو باید عکس باشد.";
    case "bad_doc_kind": return "فایل PDF را نمی‌شود عکس عضو گذاشت؛ آن را تذکره بگذارید.";
    case "file_too_large": return "فایل بیش از 10 MB است.";
    case "file_not_saved": return "فایل روی این کمپیوتر ذخیره نشد. جای خالی دیسک را ببینید.";
    case "file_missing": return "فایل این عکس روی کمپیوتر پیدا نشد.";
    case "bad_online_url": return "آدرس دیتابیس آنلاین درست نیست. باید با postgresql:// شروع شود.";
    case "bad_online_plan": return "زمان ارسال درست نیست.";
    case "bad_range": return "بازهٔ تاریخ درست نیست: «تا» نباید پیش از «از» باشد.";
    case "still_active": return "این عضو هنوز بیشتر از 5 روز عضویت دارد. اگر واقعاً پیش‌پرداخت ماه بعد است، تیک «پیش‌پرداخت» را بزنید.";
    case "period_overlap": return "این دوره با دورهٔ قبلی همین عضو روی هم می‌افتد؛ تاریخ شروع باید بعد از ختم دورهٔ قبلی باشد.";
    case "bad_date": return "ماه شروع درست نیست (سال 1400 به بعد، و نه بیشتر از یک سال بعد).";
    case "bad_salary_line": return "سطر مصارف را از لیست انتخاب کنید.";
    case "salary_line_taken": return "این سطر مصارف مال کارمند دیگری است. برای هر کارمند سطر خودش را انتخاب کنید.";
    case "drive_not_found": return "این درایو دیگر وصل نیست.";
    case "drive_not_writable": return "روی این درایو نمی‌شود نوشت (شاید قفل است).";
    case "person_has_login": return "این شخص از قبل حساب ورود دارد.";
    case "same_person": return "دو نام یکی را انتخاب کرده‌اید.";
    case "merge_salary_clash": return "هر دو نام برای یک ماه معاش ثبت‌شده دارند؛ اول یکی را حذف کنید.";
    case "folder_required": return "دست‌کم یک پوشه برای پشتیبان بنویسید.";
    case "no_cards": return "تعداد دست‌کم یک کارت را بنویسید.";
    case "bad_card": return "این نوع کارت در فهرست کارت‌ها نیست.";
    case "cards_sold": return "بعضی کارت‌های این بل فروخته شده‌اند؛ پاک نمی‌شود.";
    case "price_below_cost": return "قیمت فروش بعضی کارت‌ها از قیمت خریدشان کمتر است. قیمت‌ها را در «قیمت‌ها» درست کنید.";
    case "not_enough_cards": return "این تعداد کارت موجود نیست. اگر کارت‌ها پیش از برنامه خریده شده‌اند، اول آن‌ها را در «خرید کارت» ثبت کنید.";
    case "excel_password_needed": return "این فایل اکسل رمز دارد. رمز فایل را بنویسید.";
    case "wrong_excel_password": return "رمز فایل اکسل درست نیست.";
    case "not_excel": return "این فایل اکسل (.xlsx) نیست یا خراب است.";
    case "sheet_missing_monthly": return "شیت «عضویت ماهانه» در این فایل پیدا نشد.";
    case "sheet_missing_statement": return "شیت «محاسبات» در این فایل پیدا نشد.";
    case "bad_year": return "سال را درست بنویسید، مثلاً 1405.";
    case "no_ip": return "آدرس دستگاه انگشت هنوز تنظیم نشده. یکی از شرکا آن را در «دستگاه انگشت» می‌نویسد.";
    case "bad_k50_config": return "آدرس دستگاه درست نیست (مثلاً 192.168.1.201).";
    case "no_active_seat": return "این عضو الان عضویت فعال سالن ندارد. اول تمدید کنید، بعد انگشت را ثبت کنید.";
    case "bad_finger": return "انگشت را از فهرست انتخاب کنید.";
    default: return "کار انجام نشد. دوباره امتحان کنید.";
  }
}

/** Persian message for what the fingerprint device (or its helper) answered. */
export function k50ErrorText(error: string | null | undefined): string {
  const e = error ?? "";
  if (e.startsWith("connect_failed")) return "به دستگاه وصل نشد. دستگاه روشن و به سویچ وصل است؟ آدرس IP درست است؟ ZKAccess بسته است؟";
  if (e === "sdk_missing") return "برنامهٔ ارتباط با دستگاه (zkemkeeper که همراه ZKAccess نصب می‌شود) روی این لپ‌تاپ پیدا نشد.";
  if (e === "timeout") return "دستگاه دیر جواب داد. چند لحظه بعد دوباره امتحان کنید.";
  if (e === "no_ip") return "آدرس دستگاه هنوز تنظیم نشده.";
  if (e === "not_windows" || e === "no_powershell") return "این کار فقط روی لپ‌تاپ ویندوزی دفتر ممکن است.";
  if (e === "device_admin") return "این آیدی روی دستگاه «مدیر دستگاه» است؛ برنامه به آن دست نمی‌زند.";
  if (e.startsWith("set_user_failed")) return "دستگاه این عضو را نپذیرفت.";
  if (e === "enroll_failed") return "دستگاه برای ثبت انگشت آماده نشد. اگر این انگشت قبلاً ثبت شده، انگشت دیگری را انتخاب کنید.";
  if (e === "exception" || e.startsWith("helper")) return "ارتباط با دستگاه کامل نشد. جزئیات در api.log است.";
  return e ? "دستگاه کار را انجام نداد." : "";
}

export const ROLE_LABEL: Record<Role, string> = {
  partner: "شریک",
  manager: "مدیر",
  pec_staff: "خدمات تحصیلی",
};
