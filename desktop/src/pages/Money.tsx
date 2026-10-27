import { useEffect, useState } from "react";
import { api, errorText, type Category, type Expense, type Lines, type Person, type Withdrawal } from "../lib/api";
import { fa, formatDay, iso, monthStart } from "../lib/solar";
import { SolarDate } from "../components/SolarDate";
import { RemoveButton } from "../components/RemoveButton";

type Tab = "expenses" | "withdrawals";
type Span = "today" | "month" | "all";

/** Money going out: daily expenses by statement line, and cash the partners take. */
export function Money() {
  const [tab, setTab] = useState<Tab>("expenses");
  const [span, setSpan] = useState<Span>("month");
  return (
    <div className="page">
      <div className="list-tools">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={tab === "expenses"} className={tab === "expenses" ? "on" : ""} onClick={() => setTab("expenses")}>مصارف</button>
          <button role="tab" aria-selected={tab === "withdrawals"} className={tab === "withdrawals" ? "on" : ""} onClick={() => setTab("withdrawals")}>برداشت‌ها</button>
        </div>
        <div className="segmented" role="tablist" aria-label="دوره">
          {([["today", "امروز"], ["month", "این ماه"], ["all", "همه"]] as const).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={span === id} className={span === id ? "on" : ""} onClick={() => setSpan(id)}>{label}</button>
          ))}
        </div>
      </div>
      {tab === "expenses" ? <Expenses span={span} /> : <Withdrawals span={span} />}
    </div>
  );
}

function range(span: Span) {
  const today = iso(new Date());
  return span === "today" ? { from: today, to: today } : span === "month" ? { from: iso(monthStart()) } : {};
}
const SPAN_LABEL: Record<Span, string> = { today: "امروز", month: "این ماه", all: "همه" };

function Expenses({ span }: { span: Span }) {
  const [cats, setCats] = useState<Category[]>([]);
  const [lines, setLines] = useState<Lines<Expense> | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [cat, setCat] = useState("");
  const [newCat, setNewCat] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.categories().then((c) => { setCats(c); setCat((x) => x || c[0]?.id || ""); }).catch((e) => setError(errorText(e))); }, [tick]);
  useEffect(() => {
    const ctl = new AbortController();
    api.expenses(range(span), ctl.signal).then(setLines).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [span, tick]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const category_id = cat === "new" ? await api.createCategory(newCat) : cat;
      await api.createExpense({ category_id, spent_on: day, amount: Number(amount), description: note });
      setAmount("");
      setNote("");
      setNewCat("");
      if (cat === "new") setCat(category_id);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try { await api.deleteExpense(id); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); }
  }

  const ready = !!day && Number(amount) > 0 && (cat !== "new" ? !!cat : !!newCat.trim());
  return (
    <>
      <section className="panel wide">
        <h2>ثبت مصرف</h2>
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
          <label className="field wide"><span>مبلغ (افغانی) *</span><input dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          <label className="field wide span-2"><span>شرح</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: خرید چای و بوره" /></label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="actions"><button className="btn" disabled={!ready || busy} onClick={() => void save()}>ثبت</button></div>
      </section>
      <p className="muted small">
        مصارف {SPAN_LABEL[span]}: {fa(lines?.total ?? 0)} مورد · مجموع {fa(lines?.sum ?? 0)} افغانی
        {lines && lines.rows.length < lines.total && ` · ${fa(lines.rows.length)} مورد تازه‌تر نشان داده شده`}
      </p>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>سطر</th><th>شرح</th><th>مبلغ</th><th>ثبت کننده</th><th /></tr></thead>
          <tbody>
            {lines?.rows.map((e) => (
              <tr key={e.id}>
                <td>{formatDay(e.spent_on)}</td>
                <td>{e.category}</td>
                <td className="muted">{e.description ?? "—"}</td>
                <td className="num">{fa(e.amount)}</td>
                <td className="muted">{e.from_excel ? "اکسل" : e.created_by ?? "—"}</td>
                <td>{e.removable && <RemoveButton onConfirm={() => void remove(e.id)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines && !lines.rows.length && <p className="muted empty">مصرفی ثبت نشده.</p>}
      </div>
    </>
  );
}

function Withdrawals({ span }: { span: Span }) {
  const [people, setPeople] = useState<Person[]>([]);
  const [lines, setLines] = useState<Lines<Withdrawal> | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [who, setWho] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { api.staff().then((p) => { setPeople(p); setWho((x) => x || p[0]?.id || ""); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => {
    const ctl = new AbortController();
    api.withdrawals(range(span), ctl.signal).then(setLines).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [span, tick]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.createWithdrawal({ staff_id: who, taken_on: day, amount: Number(amount), note });
      setAmount("");
      setNote("");
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    try { await api.deleteWithdrawal(id); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      <section className="panel wide">
        <h2>ثبت برداشت</h2>
        <p className="muted">پولی که یکی از شرکا از صندوق می‌برد. معاش مدیر و کارمندان در «مصارف» ثبت می‌شود، نه اینجا.</p>
        <div className="form-grid">
          <label className="field wide">
            <span>برداشت کننده</span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.title ? ` (${p.title})` : ""}</option>)}
            </select>
          </label>
          <SolarDate label="تاریخ" value={day} onChange={setDay} />
          <label className="field wide"><span>مبلغ (افغانی) *</span><input dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></label>
          <label className="field wide"><span>بابت</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {error && <p className="form-error">{error}</p>}
        <div className="actions"><button className="btn" disabled={!who || !day || !(Number(amount) > 0) || busy} onClick={() => void save()}>ثبت</button></div>
      </section>
      <p className="muted small">
        برداشت‌های {SPAN_LABEL[span]}: {fa(lines?.total ?? 0)} مورد · مجموع {fa(lines?.sum ?? 0)} افغانی
        {lines && lines.rows.length < lines.total && ` · ${fa(lines.rows.length)} مورد تازه‌تر نشان داده شده`}
      </p>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>برداشت کننده</th><th>بابت</th><th>مبلغ</th><th>ثبت کننده</th><th /></tr></thead>
          <tbody>
            {lines?.rows.map((w) => (
              <tr key={w.id}>
                <td>{formatDay(w.taken_on)}</td>
                <td>{w.person}</td>
                <td className="muted">{w.note ?? "—"}</td>
                <td className="num">{fa(w.amount)}</td>
                <td className="muted">{w.from_excel ? "اکسل" : w.paid_by ?? "—"}</td>
                <td>{w.removable && <RemoveButton onConfirm={() => void remove(w.id)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {lines && !lines.rows.length && <p className="muted empty">برداشتی ثبت نشده.</p>}
      </div>
    </>
  );
}
