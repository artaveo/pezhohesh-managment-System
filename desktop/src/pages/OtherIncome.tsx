import { useEffect, useState } from "react";
import { api, errorText, type Bill, type BillPage } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { VoidBill } from "./Bills";
import { fa, formatDay, iso } from "../lib/solar";
import { BillPreview, CATEGORY_LABEL } from "../components/BillSheet";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { SolarDate } from "../components/SolarDate";
import { AmountInput } from "../components/AmountInput";

/**
 * The lines of «عواید متفرقه», as the monthly statement has them: «misc» is the Excel book's
 * «عواید متفرقه (انترنت خدمات)», so a month typed here and one imported land on one row.
 * The month before's cash is not typed: the report works it out.
 */
const LINES = [
  { id: "misc", label: "عواید متفرقه (انترنت خدمات)", hint: "پول انترنتی که برای خدمات (مثل فرستادن فورم یا ایمیل) گرفته شد." },
  { id: "services", label: "طلبات (عواید خدمات)", hint: "پول خدماتی مثل پرینت، کاپی و تایپ." },
] as const;
type Line = (typeof LINES)[number]["id"];
// net_services: a few days of v1.2.5 used its own line for internet services.
const CATEGORIES = [...LINES.map((l) => l.id), "net_services"].join(",");

/**
 * Money that is neither membership nor a card: internet services and other services. A day of this month or an earlier one can be given, so a
 * past month is filled in too; the bill counts on that day.
 */
export function OtherIncome() {
  const period = usePeriod("month");
  const { from, to, label } = period.range;
  const [line, setLine] = useState<Line>("services");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [page, setPage] = useState<BillPage | null>(null);
  const [show, setShow] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // A bill made by mistake is voided: it stays marked «باطل» and leaves the income.
  const [voiding, setVoiding] = useState<Bill | null>(null);
  const partner = useAuth().user?.role === "partner";
  const today = iso(new Date());

  useEffect(() => {
    const ctl = new AbortController();
    api.bills({ from, to, categories: CATEGORIES, limit: 500 }, ctl.signal)
      .then(setPage)
      .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [from, to, tick]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.otherBill({ income_category: line, amount: Number(amount), description: note.trim() || undefined, paid_on: day === today ? null : day });
      setAmount("");
      setNote("");
      setTick((t) => t + 1);
      if (r.receipt_id) setShow(r.receipt_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const live = page?.rows.filter((b) => !b.voided) ?? [];
  const sum = (c: Line) => live.filter((b) => b.income_category === c || (c === "misc" && b.income_category === "net_services")).reduce((t, b) => t + b.amount, 0);
  const hint = LINES.find((l) => l.id === line)!.hint;

  return (
    <div className="page">
      <section className="panel wide">
        <h2>ثبت عاید متفرقه</h2>
        <div className="segmented sub" role="radiogroup" aria-label="بابت">
          {LINES.map((l) => (
            <button key={l.id} role="radio" aria-checked={line === l.id} className={line === l.id ? "on" : ""} onClick={() => setLine(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
        <p className="muted small">{hint}</p>
        <div className="form-grid">
          <AmountInput label="مبلغ (افغانی)" required value={amount} onChange={setAmount} />
          <SolarDate label="تاریخ" value={day} onChange={setDay} />
          <label className="field wide span-2"><span>شرح</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </div>
        {day && day > today && <p className="form-error">تاریخ آینده قبول نیست.</p>}
        {day && day < today && <p className="muted small">در تاریخ {formatDay(day)} حساب می‌شود.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions">
          <button className="btn big" disabled={!(Number(amount) > 0) || !day || day > today || busy} onClick={() => void save()}>ثبت و بل</button>
        </div>
      </section>

      <section className="panel wide">
        <div className="list-tools">
          <h2>{label}</h2>
          <PeriodPicker value={period.value} onChange={period.setValue} />
        </div>
        <dl className="sum-line">
          {LINES.map((l) => (
            <div key={l.id}><dt>{l.label}</dt><dd className="num">{fa(sum(l.id))}</dd></div>
          ))}
        </dl>
        {page && !page.rows.length ? <p className="muted">در این مدت چیزی ثبت نشده.</p> : (
          <div className="table-wrap flush">
            <table className="table">
              <thead><tr><th>تاریخ</th><th>بابت</th><th>شرح</th><th>مبلغ</th><th>شمارهٔ بل</th><th /></tr></thead>
              <tbody>
                {page?.rows.map((b) => (
                  <tr key={b.id} className={b.voided ? "inactive" : ""}>
                    <td>{formatDay(b.counts_on ?? b.issued_on)}</td>
                    <td>{CATEGORY_LABEL[b.income_category] ?? b.income_category}</td>
                    <td>{b.description ?? "—"}</td>
                    <td className="num">{fa(b.amount)}</td>
                    <td><bdi dir="ltr">{b.receipt_no}</bdi>{b.voided && <span className="status off"> باطل</span>}</td>
                    <td><div className="row-actions">
                      <button className="btn small ghost" onClick={() => setShow(b.id)}>نمایش</button>
                      {!b.voided && (partner || b.issued_on === today) && <button className="btn small ghost danger" onClick={() => setVoiding(b)}>باطل کردن</button>}
                    </div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {show && <BillPreview id={show} onClose={() => setShow(null)} />}
      {voiding && <VoidBill bill={voiding} onClose={(done) => { setVoiding(null); if (done) setTick((t) => t + 1); }} />}
    </div>
  );
}
