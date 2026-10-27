import { useEffect, useState } from "react";
import { api, errorText, type MemberRow, type PeriodInput, type Plan } from "../../lib/api";
import { fa, formatDay, iso } from "../../lib/solar";
import { DaysLeft } from "../../components/DaysLeft";
import { PeriodForm } from "../../components/PeriodForm";
import { BillPreview, CATEGORY_LABEL } from "../../components/BillSheet";
import { Icon } from "../../components/Icon";

type Task = "find" | "daily" | "other";

/**
 * The reception desk: find a member to renew, register a new one, sell a daily seat, or
 * write any other bill. Everything ends with a bill on the screen, ready to print.
 */
export function Desk({ openMember, newMember }: { openMember: (id: string) => void; newMember: () => void }) {
  const [task, setTask] = useState<Task>("find");
  const [bill, setBill] = useState<string | null>(null);
  return (
    <div className="page">
      <div className="desk-tasks">
        <button className={task === "find" ? "on" : ""} onClick={() => setTask("find")}><Icon name="users" size={20} /> تمدید عضو</button>
        <button onClick={newMember}><Icon name="plus" size={20} /> عضو جدید</button>
        <button className={task === "daily" ? "on" : ""} onClick={() => setTask("daily")}><Icon name="clock" size={20} /> عضویت روزانه</button>
        <button className={task === "other" ? "on" : ""} onClick={() => setTask("other")}><Icon name="receipt" size={20} /> بل دیگر</button>
      </div>
      {task === "find" && <FindMember openMember={openMember} />}
      {task === "daily" && <DailySeat onBill={setBill} />}
      {task === "other" && <OtherBill onBill={setBill} />}
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
    </div>
  );
}

function FindMember({ openMember }: { openMember: (id: string) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<MemberRow[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!q.trim()) { setRows(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.members({ scope: "all", q, limit: 12 }, ctl.signal).then((p) => { setRows(p.rows); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, 200);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q]);
  return (
    <section className="panel wide">
      <input className="search big" type="search" autoFocus placeholder="آیدی، نام یا شماره تماس عضو را بنویسید" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="form-error">{error}</p>}
      {rows && !rows.length && <p className="muted">کسی پیدا نشد. اگر عضو تازه است، «عضو جدید» را بزنید.</p>}
      {rows && rows.length > 0 && (
        <ul className="pick-list">
          {rows.map((m) => m.member_id && (
            <li key={m.member_id}>
              <button onClick={() => openMember(m.member_id!)}>
                <span className="num">{m.member_no}</span>
                <strong>{m.name}</strong>
                <span className="muted">{m.father_name ?? ""}</span>
                <span className="muted">{m.end_date ? `ختم ${formatDay(m.end_date)}` : ""}</span>
                <DaysLeft days={m.days_left} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function DailySeat({ onBill }: { onBill: (id: string) => void }) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [name, setName] = useState("");
  const [period, setPeriod] = useState<PeriodInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { api.plans().then(setPlans).catch((e) => setError(errorText(e))); }, []);
  async function save() {
    if (!period) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.dailySeat({ guest_name: name, ...period });
      setName("");
      if (r.receipt_id) onBill(r.receipt_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel wide">
      <h2>عضویت روزانه</h2>
      <label className="field wide"><span>نام مهمان *</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
      <PeriodForm plans={plans} start={() => iso(new Date())} kinds={["daily"]} onChange={setPeriod} />
      {error && <p className="form-error">{error}</p>}
      <div className="actions"><button className="btn big" disabled={!name.trim() || !period || busy} onClick={() => void save()}>ثبت و بل</button></div>
    </section>
  );
}

// Hotspot cards have their own page (stock and the end-of-day count).
const OTHER = ["misc", "services", "books"] as const;

function OtherBill({ onBill }: { onBill: (id: string) => void }) {
  const [category, setCategory] = useState<(typeof OTHER)[number]>("misc");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.otherBill({ income_category: category, amount: Number(amount), description: note });
      setAmount("");
      setNote("");
      if (r.receipt_id) onBill(r.receipt_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel wide">
      <h2>بل دیگر</h2>
      <p className="muted">برای درآمدهایی که عضویت نیستند، مثل پرینت و کاپی. کارت هاتسپات و برگشت کتاب صفحهٔ خودشان را دارند.</p>
      <div className="form-grid">
        <label className="field wide">
          <span>بابت</span>
          <select value={category} onChange={(e) => setCategory(e.target.value as (typeof OTHER)[number])}>
            {OTHER.map((c) => <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>)}
          </select>
        </label>
        <label className="field wide"><span>مبلغ (افغانی) *</span><input dir="ltr" inputMode="numeric" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <label className="field wide span-2"><span>شرح (نام مشتری یا توضیح)</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {Number(amount) > 0 && <p className="period-sum">پرداخت: <strong>{fa(Number(amount))} افغانی</strong></p>}
      {error && <p className="form-error">{error}</p>}
      <div className="actions"><button className="btn big" disabled={!(Number(amount) > 0) || busy} onClick={() => void save()}>ثبت و بل</button></div>
    </section>
  );
}
