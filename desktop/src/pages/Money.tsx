import { useEffect, useState } from "react";
import { api, errorText, type Category, type Expense, type Lines, type Person, type Section, type Withdrawal } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { SolarDate } from "../components/SolarDate";
import { AmountInput } from "../components/AmountInput";
import { DeleteDialog } from "../components/DeleteDialog";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icon";
import { PeriodPicker, initialPeriod, rangeOf, usePeriod, type Range } from "../components/PeriodPicker";
import { useAuth } from "../auth/AuthProvider";
import { PARTNERS } from "../lib/shares";
import { Shares } from "./Shares";
import { StaffAccounts } from "./Salaries";

type Period = Range & { label: string };

/** Where the page is: expenses, or withdrawals by staff (one person) or by the partners. */
type View =
  | { tab: "expenses" }
  | { tab: "staff" }
  | { tab: "partners"; part: PartnerPart };
/** «menu»: the list of what there is for the partners; the rest open one of them. */
type PartnerPart = "menu" | "new" | "shares" | { person: string };

// Kept per user: the office laptop is shared, and the next person should not land in another's view.
const viewKey = (user: string) => `pz.moneyView.${user}`;

function remembered(key: string): View {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "null") as View | null;
    if (v && (v.tab === "expenses" || v.tab === "staff" || v.tab === "partners")) return v;
  } catch { /* nothing kept */ }
  return { tab: "expenses" };
}

/** A row of buttons that picks one of a few views (the pressed one is the view shown). */
function Tabs<T extends string>({ label, value, items, onChange, sub }: {
  label: string; value: T; items: { id: T; label: string; hint?: string }[]; onChange: (v: T) => void; sub?: boolean;
}) {
  return (
    <div className={`segmented${sub ? " sub" : ""}`} role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} aria-pressed={value === i.id} className={value === i.id ? "on" : ""} onClick={() => onChange(i.id)}>
          {i.label}{i.hint && <small className="muted"> {i.hint}</small>}
        </button>
      ))}
    </div>
  );
}

/**
 * Money going out. «مصارف»: daily expenses by statement line. «برداشت‌ها»: what staff are
 * paid against their salary, and what the partners take, with their shares of the profit.
 */
export function Money() {
  const { user } = useAuth();
  const partner = user?.role === "partner";
  const has = (s: Section) => partner || (user?.sections ?? []).includes(s);
  const may = { expenses: has("expenses"), staff: has("salaries"), partners: partner || has("shares") };
  const key = viewKey(user?.id ?? "");
  const [view, setViewState] = useState<View>(() => remembered(key));
  const setView = (v: View) => {
    setViewState(v);
    try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* not kept */ }
  };
  // Never open on a part this person may not see.
  const shown: View =
    view.tab === "expenses" && may.expenses ? view
      : view.tab === "staff" && may.staff ? view
      : view.tab === "partners" && may.partners ? (partner || view.part === "shares" ? view : { tab: "partners", part: "shares" })
      : may.expenses ? { tab: "expenses" } : may.staff ? { tab: "staff" } : { tab: "partners", part: partner ? "menu" : "shares" };
  const top = shown.tab === "expenses" ? "expenses" : "withdrawals";
  const who = shown.tab === "partners" ? "partners" : "staff";

  return (
    <div className="page">
      <div className="money-nav">
        <Tabs label="بخش" value={top}
          items={[...(may.expenses ? [{ id: "expenses" as const, label: "مصارف" }] : []), ...(may.staff || may.partners ? [{ id: "withdrawals" as const, label: "برداشت‌ها" }] : [])]}
          onChange={(t) => setView(t === "expenses" ? { tab: "expenses" } : may.staff ? { tab: "staff" } : { tab: "partners", part: partner ? "menu" : "shares" })} />
        {top === "withdrawals" && (
          <Tabs sub label="برداشت‌های چه کسانی" value={who}
            items={[...(may.staff ? [{ id: "staff" as const, label: "کارمندان" }] : []), ...(may.partners ? [{ id: "partners" as const, label: "شرکا" }] : [])]}
            onChange={(w) => setView(w === "staff" ? { tab: "staff" } : { tab: "partners", part: partner ? "menu" : "shares" })} />
        )}
      </div>
      {shown.tab === "expenses" && <ExpensesView />}
      {shown.tab === "staff" && <StaffAccounts />}
      {shown.tab === "partners" && <PartnersView part={shown.part} partner={partner} onPart={(part) => setView({ tab: "partners", part })} />}
    </div>
  );
}

function ExpensesView() {
  const period = usePeriod("month");
  return (
    <>
      <div className="list-tools"><PeriodPicker value={period.value} onChange={period.setValue} /></div>
      <Expenses period={period.range} />
    </>
  );
}

/**
 * The partners: first the list of what there is (a new withdrawal, the shares of the
 * profit, each partner's withdrawals), then the one picked, with a way back to the list.
 */
function PartnersView({ part, partner, onPart }: { part: PartnerPart; partner: boolean; onPart: (p: PartnerPart) => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  // One period for both partners' lists, so switching between them compares like with like.
  const period = usePeriod("month");
  useEffect(() => { if (partner) api.staff().then(setPeople).catch(() => setPeople([])); }, [partner]);
  // The partners as the statement names them (Rahimi first); their withdrawals are under these staff names.
  const partners = PARTNERS.map((p) => ({ ...p, id: people?.find((x) => x.full_name === p.name)?.id ?? null }))
    .sort((a, b) => Number(b.paysManager) - Number(a.paysManager));
  // Only the partners: staff pay is never a partner's withdrawal.
  const choices = people?.filter((x) => partners.some((p) => p.id === x.id)) ?? [];
  const missing = partners.filter((p) => !p.id).map((p) => `«${p.name}»`).join(" و ");
  const unmatched = people && missing && (
    <p className="glass muted empty">در فهرست اشخاص کسی به نام {missing} نیست. در «کاربران ← اشخاص» نام‌ها را یکی کنید.</p>
  );
  // What each partner took this year, on their card of the menu.
  const [taken, setTaken] = useState<Record<string, number>>({});
  const ids = partners.map((p) => p.id ?? "").join(",");
  useEffect(() => {
    if (part !== "menu" || !partner) return;
    const ctl = new AbortController();
    const year = rangeOf(initialPeriod("year"));
    const ready = partners.filter((p): p is typeof p & { id: string } => !!p.id);
    Promise.all(ready.map((p) => api.withdrawals({ from: year.from, to: year.to, staff_id: p.id }, ctl.signal).then((l) => [p.name, l.sum] as const)))
      .then((all) => setTaken(Object.fromEntries(all)))
      .catch(() => { /* the cards still work without the figure */ });
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [part, partner, ids]);

  if (part === "menu" && partner) {
    const year = rangeOf(initialPeriod("year")).label;
    const items: { part: PartnerPart; icon: string; title: string; hint: string; figure?: number }[] = [
      { part: "new", icon: "plus", title: "برداشت جدید", hint: "ثبت پولی که یکی از شرکا از صندوق می‌برد" },
      { part: "shares", icon: "pie", title: "سهم شرکا", hint: "سهم هر شریک از سود، ماه به ماه، و تسویهٔ سال" },
      ...partners.map((p) => ({ part: { person: p.name }, icon: "receipt", title: `ریز برداشت‌های ${p.short}`, hint: `امروز، ماه، سال یا هر بازه`, figure: taken[p.name] })),
    ];
    return (
      <>
        {unmatched}
        <div className="choice-grid">
          {items.map((i) => (
            <button key={i.title} className="glass choice" onClick={() => onPart(i.part)}>
              <Icon name={i.icon} size={22} />
              <span className="choice-title">{i.title}</span>
              {i.figure !== undefined && <span className="choice-figure">{fa(i.figure)} <small>؋</small> <span className="muted small">برداشت در {year}</span></span>}
              <span className="muted small">{i.hint}</span>
            </button>
          ))}
        </div>
      </>
    );
  }
  const person = typeof part === "string" ? null : partners.find((p) => p.name === part.person) ?? null;
  const title = part === "new" ? "برداشت جدید" : part === "shares" ? "سهم شرکا" : person ? `ریز برداشت‌های ${person.short}` : "";
  return (
    <>
      {partner && (
        <div className="detail-head">
          <button className="btn ghost small" onClick={() => onPart("menu")}><Icon name="back" size={16} /> همهٔ بخش‌های شرکا</button>
          <h2>{title}</h2>
        </div>
      )}
      {part === "shares" && <Shares />}
      {part === "new" && people && (choices.length ? <NewWithdrawal people={choices} /> : unmatched)}
      {person && people && (person.id ? (
        <>
          <div className="list-tools"><PeriodPicker value={period.value} onChange={period.setValue} /></div>
          <Withdrawals key={person.id} period={period.range} people={choices} staffId={person.id} title={`برداشت‌های ${person.name}`} />
        </>
      ) : <p className="glass muted empty">در فهرست اشخاص کسی به نام «{person.name}» نیست. در «کاربران ← اشخاص» نام‌ها را یکی کنید.</p>)}
    </>
  );
}

/** «برداشت جدید»: the form, and this month's withdrawals under it. */
function NewWithdrawal({ people }: { people: Person[] }) {
  const period = usePeriod("month");
  return <Withdrawals period={period.range} people={people} form />;
}

/** Under a long list: how many lines are shown, and a button for the next ones. */
function More({ lines, busy, onMore }: { lines: Lines<unknown> | null; busy: boolean; onMore: () => void }) {
  if (!lines || lines.rows.length >= lines.total) return null;
  return (
    <div className="list-more">
      <span className="muted small">{fa(lines.rows.length)} از {fa(lines.total)} مورد نشان داده شده (جمع پایین جدول همهٔ {fa(lines.total)} مورد است).</span>
      <button className="btn ghost" disabled={busy} onClick={onMore}>{busy ? "در حال آوردن…" : "نمایش بیشتر"}</button>
    </div>
  );
}

/** Edit and remove buttons of one line, when this user may change it. */
function RowTools({ can, onEdit, onRemove }: { can: boolean; onEdit: () => void; onRemove: () => void }) {
  if (!can) return null;
  return (
    <span className="row-tools">
      <button className="btn small ghost" onClick={onEdit} aria-label="ویرایش"><Icon name="edit" /></button>
      <button className="btn small ghost" onClick={onRemove} aria-label="حذف"><Icon name="trash" /></button>
    </span>
  );
}

function Expenses({ period }: { period: Period }) {
  const toast = useToast();
  const [cats, setCats] = useState<Category[]>([]);
  const [lines, setLines] = useState<Lines<Expense> | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<Expense | null>(null);
  const [removing, setRemoving] = useState<Expense | null>(null);
  const [cat, setCat] = useState("");
  const [newCat, setNewCat] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const reload = () => setTick((t) => t + 1);
  async function more() {
    if (!lines) return;
    setLoadingMore(true);
    try {
      const next = await api.expenses({ from: period.from, to: period.to, offset: lines.rows.length });
      setLines({ ...next, rows: [...lines.rows, ...next.rows] });
    } catch (e) { setError(errorText(e)); } finally { setLoadingMore(false); }
  }

  useEffect(() => { api.categories().then((c) => { setCats(c); setCat((x) => x || c[0]?.id || ""); }).catch((e) => setError(errorText(e))); }, [tick]);
  useEffect(() => {
    const ctl = new AbortController();
    api.expenses({ from: period.from, to: period.to }, ctl.signal).then(setLines).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [period.from, period.to, tick]);

  function clear() {
    setEditing(null);
    setAmount("");
    setNote("");
    setNewCat("");
    setDay(iso(new Date()));
  }
  function edit(e: Expense) {
    setEditing(e);
    setCat(e.category_id);
    setDay(e.spent_on);
    setAmount(String(e.amount));
    setNote(e.description ?? "");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function save() {
    if (cat === "new" && !newCat.trim()) return setError("نام سطر تازه را بنویسید.");
    if (!(Number(amount) > 0)) return setError("مبلغ را بنویسید.");
    if (!day) return setError("تاریخ را انتخاب کنید.");
    setBusy(true);
    setError("");
    try {
      const category_id = cat === "new" ? await api.createCategory(newCat) : cat;
      const body = { category_id, spent_on: day, amount: Number(amount), description: note };
      if (editing) await api.updateExpense(editing.id, body);
      else await api.createExpense(body);
      if (cat === "new") setCat(category_id);
      toast(editing ? "مصرف اصلاح شد." : "مصرف ثبت شد.");
      clear();
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="panel wide">
        <h2>{editing ? "اصلاح مصرف" : "ثبت مصرف"}</h2>
        <div className="form-grid">
          <label className="field wide">
            <span>سطر صورت حساب</span>
            <select value={cat} onChange={(e) => setCat(e.target.value)}>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              <option value="new">+ سطر تازه…</option>
            </select>
          </label>
          {cat === "new" && <label className="field wide"><span>نام سطر تازه</span><input value={newCat} onChange={(e) => setNewCat(e.target.value)} /></label>}
          <SolarDate label="تاریخ" value={day} onChange={setDay} />
          <AmountInput label="مبلغ (افغانی)" required value={amount} onChange={setAmount} />
          <label className="field wide span-2"><span>شرح</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: خرید چای و بوره" /></label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void save()}>{editing ? "ذخیرهٔ اصلاح" : "ثبت"}</button>
          {editing && <button className="btn ghost" onClick={clear}>انصراف</button>}
        </div>
      </section>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>سطر</th><th>شرح</th><th className="num">مبلغ</th><th>ثبت کننده</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {lines?.rows.map((e) => (
              <tr key={e.id} className={editing?.id === e.id ? "selected" : ""}>
                <td>{formatDay(e.spent_on)}</td>
                <td>{e.category}</td>
                <td className="muted">{e.description ?? "—"}</td>
                <td className="num">{fa(e.amount)}</td>
                <td className="muted">{e.from_excel ? "اکسل" : e.created_by ?? "—"}</td>
                <td><RowTools can={e.removable} onEdit={() => edit(e)} onRemove={() => setRemoving(e)} /></td>
              </tr>
            ))}
          </tbody>
          {lines && lines.total > 0 && (
            <tfoot>
              <tr><th colSpan={3}>جمع {period.label} ({fa(lines.total)} مورد)</th><td className="num">{fa(lines.sum)}</td><td colSpan={2} /></tr>
            </tfoot>
          )}
        </table>
        {lines && !lines.rows.length && <p className="muted empty">در {period.label} مصرفی ثبت نشده.</p>}
      </div>
      <More lines={lines} busy={loadingMore} onMore={() => void more()} />
      {removing && (
        <DeleteDialog title="حذف مصرف" onClose={() => setRemoving(null)}
          onConfirm={async (reason) => {
            const id = removing.id;
            await api.deleteExpense(id, reason);
            setRemoving(null);
            if (editing?.id === id) clear();
            reload();
            toast("مصرف حذف شد.", async () => { await api.restoreExpense(id); reload(); });
          }}>
          {formatDay(removing.spent_on)} · {removing.category} · {fa(removing.amount)} افغانی. از جمع مصارف کم می‌شود و در «چه کسی چه کرد» می‌ماند.
        </DeleteDialog>
      )}
    </>
  );
}

/**
 * Withdrawals in a period (only `staffId`'s, when given). With `form` the entry form is
 * always there; otherwise it opens when a line is being corrected.
 */
function Withdrawals({ period, people, staffId, form, title }: { period: Period; people: Person[]; staffId?: string; form?: boolean; title?: string }) {
  const toast = useToast();
  const [lines, setLines] = useState<Lines<Withdrawal> | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [editing, setEditing] = useState<Withdrawal | null>(null);
  const [removing, setRemoving] = useState<Withdrawal | null>(null);
  const [who, setWho] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const reload = () => setTick((t) => t + 1);
  async function more() {
    if (!lines) return;
    setLoadingMore(true);
    try {
      const next = await api.withdrawals({ from: period.from, to: period.to, staff_id: staffId, offset: lines.rows.length });
      setLines({ ...next, rows: [...lines.rows, ...next.rows] });
    } catch (e) { setError(errorText(e)); } finally { setLoadingMore(false); }
  }

  useEffect(() => { setWho((x) => x || staffId || people[0]?.id || ""); }, [people, staffId]);
  useEffect(() => {
    const ctl = new AbortController();
    api.withdrawals({ from: period.from, to: period.to, staff_id: staffId }, ctl.signal).then(setLines).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [period.from, period.to, staffId, tick]);
  // The person of a line being corrected may not be in the list (a partner's old name).
  const choices = editing && !people.some((p) => p.id === editing.staff_id)
    ? [...people, { id: editing.staff_id, full_name: editing.person } as Person]
    : people;

  function clear() {
    setEditing(null);
    setAmount("");
    setNote("");
    setDay(iso(new Date()));
  }
  function edit(w: Withdrawal) {
    setEditing(w);
    setWho(w.staff_id);
    setDay(w.taken_on);
    setAmount(String(w.amount));
    setNote(w.note ?? "");
    setError("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  async function save() {
    if (!who) return setError("برداشت کننده را انتخاب کنید.");
    if (!(Number(amount) > 0)) return setError("مبلغ را بنویسید.");
    if (!day) return setError("تاریخ را انتخاب کنید.");
    setBusy(true);
    setError("");
    try {
      const body = { staff_id: who, taken_on: day, amount: Number(amount), note };
      if (editing) await api.updateWithdrawal(editing.id, body);
      else await api.createWithdrawal(body);
      toast(editing ? "برداشت اصلاح شد." : "برداشت ثبت شد.");
      clear();
      reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {(form || editing) && <section className="panel wide">
        <h2>{editing ? "اصلاح برداشت" : "ثبت برداشت"}</h2>
        <p className="muted">پولی که یکی از شرکا از صندوق می‌برد. پول کارمندان برداشت شریک نیست: آن را در «کارمندان» با «پرداخت» ثبت کنید تا زیر سطر معاش خودشان در مصارف برود.</p>
        <div className="form-grid">
          <label className="field wide">
            <span>شریک</span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {choices.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
            </select>
          </label>
          <SolarDate label="تاریخ" value={day} onChange={setDay} />
          <AmountInput label="مبلغ (افغانی)" required value={amount} onChange={setAmount} />
          <label className="field wide"><span>بابت</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void save()}>{editing ? "ذخیرهٔ اصلاح" : "ثبت"}</button>
          {editing && <button className="btn ghost" onClick={clear}>انصراف</button>}
        </div>
      </section>}
      {title && lines && (
        <section className="kpis">
          <div className="glass kpi">
            <span className="kpi-label">{title}، {period.label}</span>
            <span className="kpi-value">{fa(lines.sum)} <small>؋</small></span>
            <span className="muted small">{fa(lines.total)} برداشت</span>
          </div>
        </section>
      )}
      {!form && !editing && error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th>{!staffId && <th>شریک</th>}<th>بابت</th><th className="num">مبلغ</th><th>ثبت کننده</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {lines?.rows.map((w) => (
              <tr key={w.id} className={editing?.id === w.id ? "selected" : ""}>
                <td>{formatDay(w.taken_on)}</td>
                {!staffId && <td>{w.person}</td>}
                <td className="muted">{w.note ?? "—"}</td>
                <td className="num">{fa(w.amount)}</td>
                <td className="muted">{w.from_excel ? "اکسل" : w.paid_by ?? "—"}</td>
                <td><RowTools can={w.removable} onEdit={() => edit(w)} onRemove={() => setRemoving(w)} /></td>
              </tr>
            ))}
          </tbody>
          {lines && lines.total > 0 && (
            <tfoot>
              <tr><th colSpan={staffId ? 2 : 3}>جمع {period.label} ({fa(lines.total)} مورد)</th><td className="num">{fa(lines.sum)}</td><td colSpan={2} /></tr>
            </tfoot>
          )}
        </table>
        {lines && !lines.rows.length && <p className="muted empty">{staffId ? `در ${period.label} برداشتی نیست. بازهٔ دیگری انتخاب کنید.` : `در ${period.label} برداشتی ثبت نشده.`}</p>}
      </div>
      <More lines={lines} busy={loadingMore} onMore={() => void more()} />
      {removing && (
        <DeleteDialog title="حذف برداشت" onClose={() => setRemoving(null)}
          onConfirm={async (reason) => {
            const id = removing.id;
            await api.deleteWithdrawal(id, reason);
            setRemoving(null);
            if (editing?.id === id) clear();
            reload();
            toast("برداشت حذف شد.", async () => { await api.restoreWithdrawal(id); reload(); });
          }}>
          {formatDay(removing.taken_on)} · {removing.person} · {fa(removing.amount)} افغانی.
        </DeleteDialog>
      )}
    </>
  );
}
