import { useEffect, useState } from "react";
import { api, errorText, type Category, type Expense, type Lines, type Person, type Withdrawal } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { SolarDate } from "../components/SolarDate";
import { AmountInput } from "../components/AmountInput";
import { DeleteDialog } from "../components/DeleteDialog";
import { useToast } from "../components/Toast";
import { Icon } from "../components/Icon";
import { PeriodPicker, usePeriod, type Range } from "../components/PeriodPicker";

type Tab = "expenses" | "withdrawals";
type Period = Range & { label: string };

/** Money going out: daily expenses by statement line, and cash the partners take. */
export function Money({ openSalaries }: { openSalaries?: () => void }) {
  const [tab, setTab] = useState<Tab>("expenses");
  const period = usePeriod("month");
  return (
    <div className="page">
      <div className="list-tools">
        <div className="segmented" role="tablist" aria-label="نوع">
          <button role="tab" aria-selected={tab === "expenses"} className={tab === "expenses" ? "on" : ""} onClick={() => setTab("expenses")}>مصارف</button>
          <button role="tab" aria-selected={tab === "withdrawals"} className={tab === "withdrawals" ? "on" : ""} onClick={() => setTab("withdrawals")}>برداشت شرکا</button>
        </div>
        <PeriodPicker value={period.value} onChange={period.setValue} />
        {openSalaries && <button className="btn ghost" onClick={openSalaries}><Icon name="banknote" /> پرداخت به کارمند</button>}
      </div>
      {tab === "expenses" ? <Expenses period={period.range} /> : <Withdrawals period={period.range} />}
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
  const reload = () => setTick((t) => t + 1);

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
      {lines && lines.rows.length < lines.total && (
        <p className="muted small">{fa(lines.rows.length)} مورد تازه‌تر از {fa(lines.total)} مورد نشان داده شده؛ برای دیدن بقیه بازهٔ کوتاه‌تری انتخاب کنید.</p>
      )}
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
        {lines && !lines.rows.length && <p className="muted empty">مصرفی ثبت نشده.</p>}
      </div>
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

function Withdrawals({ period }: { period: Period }) {
  const toast = useToast();
  const [people, setPeople] = useState<Person[]>([]);
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
  const reload = () => setTick((t) => t + 1);

  useEffect(() => { api.staff().then((p) => { setPeople(p); setWho((x) => x || p[0]?.id || ""); }).catch((e) => setError(errorText(e))); }, []);
  useEffect(() => {
    const ctl = new AbortController();
    api.withdrawals({ from: period.from, to: period.to }, ctl.signal).then(setLines).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [period.from, period.to, tick]);

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
      <section className="panel wide">
        <h2>{editing ? "اصلاح برداشت" : "ثبت برداشت"}</h2>
        <p className="muted">پولی که یکی از شرکا از صندوق می‌برد. پول کارمندان برداشت نیست: آن را در «معاش کارمندان» با «پرداخت» ثبت کنید تا زیر سطر معاش خودشان در مصارف برود.</p>
        <div className="form-grid">
          <label className="field wide">
            <span>شریک</span>
            <select value={who} onChange={(e) => setWho(e.target.value)}>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
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
      </section>
      {lines && lines.rows.length < lines.total && (
        <p className="muted small">{fa(lines.rows.length)} مورد تازه‌تر از {fa(lines.total)} مورد نشان داده شده؛ برای دیدن بقیه بازهٔ کوتاه‌تری انتخاب کنید.</p>
      )}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>شریک</th><th>بابت</th><th className="num">مبلغ</th><th>ثبت کننده</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {lines?.rows.map((w) => (
              <tr key={w.id} className={editing?.id === w.id ? "selected" : ""}>
                <td>{formatDay(w.taken_on)}</td>
                <td>{w.person}</td>
                <td className="muted">{w.note ?? "—"}</td>
                <td className="num">{fa(w.amount)}</td>
                <td className="muted">{w.from_excel ? "اکسل" : w.paid_by ?? "—"}</td>
                <td><RowTools can={w.removable} onEdit={() => edit(w)} onRemove={() => setRemoving(w)} /></td>
              </tr>
            ))}
          </tbody>
          {lines && lines.total > 0 && (
            <tfoot>
              <tr><th colSpan={3}>جمع {period.label} ({fa(lines.total)} مورد)</th><td className="num">{fa(lines.sum)}</td><td colSpan={2} /></tr>
            </tfoot>
          )}
        </table>
        {lines && !lines.rows.length && <p className="muted empty">برداشتی ثبت نشده.</p>}
      </div>
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
