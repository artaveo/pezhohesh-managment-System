import { useEffect, useMemo, useState } from "react";
import { api, errorText, type AuditFilter, type AuditLine, type AuditPage } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { useToast } from "../components/Toast";
import { Failed } from "../components/Stat";

/** What each table holds, in the words of the desk. */
export const TABLES: Record<string, string> = {
  members: "عضو",
  memberships: "دورهٔ عضویت",
  member_documents: "عکس و تذکره",
  receipts: "بل",
  expenses: "مصرف",
  expense_categories: "سطر مصارف",
  withdrawals: "برداشت",
  salary_accruals: "معاش ماهانه",
  staff: "شخص",
  app_users: "کاربر",
  plans: "نرخ‌نامه",
  book_loans: "امانت کتاب",
  loan_deposits: "ضمانت کتاب",
  hotspot_buys: "خرید کارت هاتسپات",
  hotspot_sales: "فروش کارت هاتسپات",
  hotspot_cards: "کارت هاتسپات",
  month_summaries: "بیلانس برآوردی",
  partner_shares: "سهم شرکا",
};

const KIND: Record<AuditLine["kind"], string> = {
  insert: "افزود",
  update: "تغییر داد",
  remove: "حذف کرد",
  restore: "برگرداند",
  void: "باطل کرد",
};

const FIELDS: Record<string, string> = {
  first_name: "نام", last_name: "تخلص", father_name: "نام پدر", phone: "شماره تماس", field_of_study: "رشته",
  tazkira_no: "نمبر تذکره", notes: "یادداشت", note: "یادداشت", member_no: "شمارهٔ عضویت", joined_on: "تاریخ عضویت",
  start_date: "شروع", end_date: "ختم", fee: "مبلغ", discount: "تخفیف", amount: "مبلغ", spent_on: "تاریخ", taken_on: "تاریخ",
  description: "شرح", category_id: "سطر", staff_id: "شخص", plan_id: "نوع عضویت", name: "نام", full_name: "نام",
  price: "نرخ", duration_days: "روزها", active: "فعال", title: "کار", role: "نقش", username: "نام کاربری",
  net_balance: "بیلانس", solar_year: "سال", solar_month: "ماه", printed_count: "چاپ", voided: "باطل",
  void_reason: "دلیل باطل", deleted_at: "حذف", deleted_reason: "دلیل حذف", returned_on: "تاریخ برگشت",
  due_on: "مهلت", loaned_on: "تاریخ امانت", book_title: "کتاب", weekly_fee: "کرایهٔ هفته", fine: "جریمه",
  fee_paid: "کرایهٔ پرداخت‌شده", guarantor: "ضامن", code: "شمارهٔ کارت", kind: "نوع", aliases: "نام‌های دیگر",
  salary_from: "معاش از", monthly_salary: "معاش ماهانه", expense_category_id: "سطر مصارف", theme: "رنگ", theme_mode: "حالت",
  failed_attempts: "تلاش اشتباه", locked_until: "قفل تا", last_login_at: "آخرین ورود", must_change_password: "رمز موقت",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T/;

function value(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "بله" : "نه";
  if (typeof v === "number") return fa(v);
  if (typeof v === "string") {
    if (UUID.test(v)) return "…";
    if (DAY.test(v)) return formatDay(v);
    if (STAMP.test(v)) return formatDay(iso(new Date(v)));
    return v;
  }
  if (Array.isArray(v)) return v.map(value).join("، ") || "—";
  return JSON.stringify(v);
}

const at = new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { hour: "2-digit", minute: "2-digit", hour12: false });

/** A removal of a member and the periods and documents that went with it, shown as one line. */
type Shown = AuditLine & { along: { periods: number; documents: number } };

function group(lines: AuditLine[]): Shown[] {
  const out: Shown[] = lines.map((l) => ({ ...l, along: { periods: 0, documents: 0 } }));
  const heads = out.filter((h) => h.table === "members" && (h.kind === "remove" || h.kind === "restore"));
  return out.filter((l) => {
    if (l.table !== "memberships" && l.table !== "member_documents") return true;
    const head = heads.find((h) => h.at === l.at && h.member_id === l.member_id && h.kind === l.kind);
    if (!head) return true;
    if (l.table === "memberships") head.along.periods++;
    else head.along.documents++;
    return false;
  });
}

/**
 * «چه کسی چه کرد»: every addition, change and removal, newest first, with the old and new
 * value of each changed field. Removed members, expenses and withdrawals can be brought back.
 */
export function Audit({ openMember }: { openMember: (id: string) => void }) {
  const toast = useToast();
  const period = usePeriod("month");
  const [table, setTable] = useState("");
  const [user, setUser] = useState("");
  const [q, setQ] = useState("");
  const [typed, setTyped] = useState("");
  const [withImport, setWithImport] = useState(false);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => { const t = window.setTimeout(() => setQ(typed), 350); return () => window.clearTimeout(t); }, [typed]);
  const filter: AuditFilter = useMemo(
    () => ({ from: period.range.from, to: period.range.to, table: table || undefined, user: user || undefined, q: q || undefined, import: withImport }),
    [period.range.from, period.range.to, table, user, q, withImport],
  );
  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    api.audit(filter, ctl.signal).then(setPage).catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    return () => ctl.abort();
  }, [filter, tick]);

  async function more() {
    if (!page) return;
    setBusy(true);
    try {
      const next = await api.audit({ ...filter, before: page.lines[page.lines.length - 1]?.id });
      setPage({ ...next, lines: [...page.lines, ...next.lines] });
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function restore(l: AuditLine) {
    try {
      if (l.table === "members") await api.restoreMember(l.row_id!);
      else if (l.table === "expenses") await api.restoreExpense(l.row_id!);
      else await api.restoreWithdrawal(l.row_id!);
      toast("برگردانده شد.");
      setTick((t) => t + 1);
    } catch (e) {
      toast(errorText(e));
    }
  }

  const lines = page ? group(page.lines) : [];
  return (
    <div className="page">
      <p className="muted">هر چیزی که در برنامه افزوده، تغییر داده، حذف یا باطل شده، با نام کسی که آن را کرد. چیزی واقعاً پاک نمی‌شود؛ عضو، مصرف و برداشت حذف‌شده را از همین‌جا می‌شود برگرداند.</p>
      <div className="list-tools">
        <PeriodPicker value={period.value} onChange={period.setValue} />
        <label className="field">
          <span>بخش</span>
          <select value={table} onChange={(e) => setTable(e.target.value)}>
            <option value="">همه</option>
            {Object.entries(TABLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label className="field">
          <span>کاربر</span>
          <select value={user} onChange={(e) => setUser(e.target.value)}>
            <option value="">همه</option>
            {page?.users.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span>جستجو</span>
          <input type="search" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="نام، شماره، مبلغ…" aria-label="جستجو در کارها" />
        </label>
        <label className="check"><input type="checkbox" checked={withImport} onChange={(e) => setWithImport(e.target.checked)} /> با ورود از اکسل</label>
      </div>

      {failed ? <Failed retry={() => setTick((t) => t + 1)} /> : (
        <div className="glass table-wrap">
          <table className="table audit">
            <thead><tr><th>زمان</th><th>کاربر</th><th>کار</th><th>چه چیزی</th><th>جزئیات</th><th><span className="sr-only">کارها</span></th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{formatDay(iso(new Date(l.at)))} <span className="muted small">{at.format(new Date(l.at))}</span></td>
                  <td>{l.user ?? <span className="muted">سیستم</span>}</td>
                  <td><span className={`chip kind-${l.kind}`}>{KIND[l.kind]}</span></td>
                  <td>
                    <span className="muted small">{TABLES[l.table] ?? l.table}</span>{" "}
                    {l.member_id && l.table !== "member_documents" ? <button className="link" onClick={() => openMember(l.member_id!)}>{l.label || "عضو"}</button> : l.label}
                    {typeof l.amount === "number" && <span className="muted"> · {fa(l.amount)} ؋</span>}
                  </td>
                  <td className="small">
                    {l.changes.length > 0 && (
                      <ul className="changes">
                        {l.changes.map((c) => (
                          <li key={c.field}><b>{FIELDS[c.field] ?? c.field}:</b> <s className="muted">{value(c.before)}</s> ← {value(c.after)}</li>
                        ))}
                      </ul>
                    )}
                    {(l.along.periods > 0 || l.along.documents > 0) && (
                      <span className="muted">همراه آن: {[l.along.periods && `${fa(l.along.periods)} دوره`, l.along.documents && `${fa(l.along.documents)} عکس/مدرک`].filter(Boolean).join(" و ")}</span>
                    )}
                    {l.reason && <span> دلیل: {l.reason}</span>}
                  </td>
                  <td>{l.restorable && <button className="btn small" onClick={() => void restore(l)}>برگرداندن</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {page && !lines.length && <p className="muted empty">در این بازه کاری ثبت نشده.</p>}
          {!page && <p className="muted empty">در حال خواندن…</p>}
        </div>
      )}
      {page?.more && <div className="actions"><button className="btn ghost" disabled={busy} onClick={() => void more()}>نمایش بیشتر</button></div>}
    </div>
  );
}
