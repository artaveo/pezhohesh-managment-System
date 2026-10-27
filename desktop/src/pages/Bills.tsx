import { useEffect, useState } from "react";
import { api, errorText, type Bill, type BillPage } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { fa, formatDay, iso } from "../lib/solar";
import { BillPreview, CATEGORY_LABEL } from "../components/BillSheet";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { Modal } from "../components/Modal";

/** Every bill issued in the program: find, show and print again, or void a wrong one. */
export function Bills() {
  const { user } = useAuth();
  const period = usePeriod("today");
  const { from, to, label: spanLabel } = period.range;
  const [q, setQ] = useState("");
  const [page, setPage] = useState<BillPage | null>(null);
  const [error, setError] = useState("");
  const [show, setShow] = useState<string | null>(null);
  const [voiding, setVoiding] = useState<Bill | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.bills({ from, to, q: q.trim() || undefined, limit: 300 }, ctl.signal)
        .then((p) => { setPage(p); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [from, to, q, tick]);

  const today = iso(new Date());
  const mayVoid = (b: Bill) => !b.voided && (user?.role === "partner" || b.issued_on === today);

  return (
    <div className="page">
      <div className="list-tools">
        <PeriodPicker value={period.value} onChange={period.setValue} />
        <input className="search" type="search" placeholder="جستجو: شمارهٔ بل، نام، آیدی یا شماره تماس" aria-label="جستجو: شمارهٔ بل، نام، آیدی یا شماره تماس" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {page && (
        <p className="muted small">
          {spanLabel}: {fa(page.total)} بل · مجموع {fa(page.sum)} افغانی (بدون بل‌های باطل). درآمدهای اکسل اینجا نیستند، چون بل نداشتند.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>شمارهٔ بل</th><th>تاریخ</th><th>نام</th><th>بابت</th><th>مبلغ</th><th>صادر کننده</th><th /></tr></thead>
          <tbody>
            {page?.rows.map((b) => (
              <tr key={b.id} className={b.voided ? "inactive" : ""}>
                <td><bdi dir="ltr">{b.receipt_no}</bdi></td>
                <td>{formatDay(b.issued_on)}</td>
                <td>{b.customer ?? b.description ?? "—"}{b.member_no !== null && <span className="muted small"> · {b.member_no}</span>}</td>
                <td>{b.plan_name ?? CATEGORY_LABEL[b.income_category] ?? b.income_category}</td>
                <td className="num">{fa(b.amount)}</td>
                <td className="muted">{b.issued_by ?? "—"}</td>
                <td><div className="row-actions">
                  {b.voided ? <span className="status off" title={b.void_reason ?? ""}>باطل</span> : null}
                  <button className="btn small ghost" onClick={() => setShow(b.id)}>نمایش و چاپ</button>
                  {mayVoid(b) && <button className="btn small ghost danger" onClick={() => setVoiding(b)}>باطل کردن</button>}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {page && !page.rows.length && <p className="muted empty">{q ? "بلی پیدا نشد." : `${spanLabel} هنوز بلی صادر نشده.`}</p>}
        {!page && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
      {show && <BillPreview id={show} onClose={() => setShow(null)} />}
      {voiding && <VoidBill bill={voiding} onClose={(done) => { setVoiding(null); if (done) setTick((t) => t + 1); }} />}
    </div>
  );
}

export function VoidBill({ bill, note, onClose }: { bill: Bill; note?: string; onClose: (done: boolean) => void }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function confirm() {
    setBusy(true);
    try { await api.voidBill(bill.id, reason); onClose(true); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal label="باطل کردن بل" onClose={() => onClose(false)}>
      <h2>باطل کردن بل <bdi dir="ltr">{bill.receipt_no}</bdi></h2>
      <p className="muted">
        {fa(bill.amount)} افغانی، {bill.customer ?? bill.description}. بل پاک نمی‌شود؛ با نشان «باطل» می‌ماند و از درآمد کم می‌شود.
        {note ? ` ${note}` : bill.book_loan_id ? " اگر ضمانتش هنوز نزد ماست، کتاب دوباره «بیرون» حساب می‌شود تا برگشتش را با مبلغ درست ثبت کنید." : bill.start_date && " عضویتی که با این بل ثبت شده هم برداشته می‌شود."}
      </p>
      <label className="field wide"><span>دلیل *</span><input value={reason} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="مثلاً: مبلغ اشتباه نوشته شد" /></label>
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button className="btn danger" disabled={!reason.trim() || busy} onClick={() => void confirm()}>باطل کن</button>
        <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
      </div>
    </Modal>
  );
}
