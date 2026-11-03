import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorText, type Bill, type BillMonth } from "../lib/api";
import { fa, formatDay, formatNumeric } from "../lib/solar";
import { inWords } from "../lib/words";
import { Modal } from "./Modal";

export const CATEGORY_LABEL: Record<string, string> = {
  monthly: "عضویت ماهانه", daily: "عضویت روزانه", internet: "انترنت ماهانه", hotspot: "انترنت هاتسپات",
  books: "امانت کتاب", misc: "عواید متفرقه", services: "طلبات (عواید خدمات)",
};

/** The top of every paper bill: the hall, the bill's number and date, and who paid. */
function BillHead({ bill, no }: { bill: Bill; no: string }) {
  return (
    <>
      {bill.voided && <div className="bill-stamp void">باطل شده</div>}
      {!bill.voided && bill.printed_count > 0 && <div className="bill-stamp copy">کاپی</div>}
      <header>
        <img src="/logo-study-hall.png" alt="" />
        <div>
          <h1>کتابخانه و سالن مطالعه پژوهش</h1>
          <p>PEZHOHESH STUDY HALL</p>
        </div>
        <span className="bill-title">بل پرداخت</span>
      </header>
      <dl className="bill-meta">
        <div><dt>شمارهٔ بل</dt><dd dir="ltr">{no}</dd></div>
        <div><dt>تاریخ</dt><dd>{formatDay(bill.months[0]?.issued_on ?? bill.issued_on)} <small dir="ltr">({formatNumeric(bill.months[0]?.issued_on ?? bill.issued_on)})</small></dd></div>
        {bill.customer && <div><dt>نام</dt><dd>{bill.customer}</dd></div>}
        {bill.father_name && <div><dt>نام پدر</dt><dd>{bill.father_name}</dd></div>}
        {bill.member_no !== null && <div><dt>آیدی</dt><dd dir="ltr">{bill.member_no}</dd></div>}
        {bill.card_no && <div><dt>کارت امانت</dt><dd dir="ltr">{bill.card_no}</dd></div>}
        {bill.phone && <div><dt>شماره تماس</dt><dd dir="ltr">{bill.phone}</dd></div>}
      </dl>
    </>
  );
}

/** Several months paid at once: each month's line (its own bill number) and the total. */
function MonthsSheet({ bill, months, what }: { bill: Bill; months: BillMonth[]; what: string }) {
  const paid = months.reduce((t, m) => t + m.amount, 0);
  const discount = months.reduce((t, m) => t + m.discount, 0);
  const owed = months.reduce((t, m) => t + m.owed, 0);
  const no = months.length > 1 ? `${months[0].receipt_no} … ${months[months.length - 1].receipt_no.split("-").pop()}` : months[0].receipt_no;
  return (
    <article className="bill-sheet" dir="rtl">
      <BillHead bill={bill} no={no} />
      <table className="bill-lines">
        <thead><tr><th>بابت</th><th>مدت</th><th>مبلغ</th></tr></thead>
        <tbody>
          {months.map((m, i) => (
            <tr key={m.receipt_no}>
              <td>{what} · ماه {fa(i + 1)}<div className="small" dir="ltr">{m.receipt_no}</div></td>
              <td>از {formatDay(m.start_date)}<br />تا {formatDay(m.end_date)}</td>
              <td className="num">{fa(m.fee)}</td>
            </tr>
          ))}
          {discount > 0 && <tr><td colSpan={2}>تخفیف</td><td className="num">{fa(-discount)}</td></tr>}
        </tbody>
        <tfoot>
          <tr><th colSpan={2}>مجموع پرداخت ({fa(months.length)} ماه)</th><th className="num">{fa(paid)} افغانی</th></tr>
          {owed > 0 && <tr className="bill-rest"><th colSpan={2}>باقی</th><th className="num">{fa(owed)} افغانی</th></tr>}
        </tfoot>
      </table>
      <p className="bill-words">به حروف: {inWords(paid)} افغانی</p>
      {bill.voided && bill.void_reason && <p className="bill-words">دلیل باطل شدن: {bill.void_reason}</p>}
      <BillFoot bill={bill} />
    </article>
  );
}

/** The paper bill, sized for A5 (half an A4 sheet) on an ordinary printer. */
export function BillSheet({ bill }: { bill: Bill }) {
  const what = bill.plan_name ?? CATEGORY_LABEL[bill.income_category] ?? bill.income_category;
  // Several months paid at once: one line per month, one paper.
  const months = bill.months.filter((m) => !m.voided);
  if (months.length > 1) return <MonthsSheet bill={bill} months={months} what={what} />;
  // A period paid in parts: this bill pays some, and what is left is printed under it.
  const part = bill.pays_rest || (bill.remaining ?? 0) > 0;
  return (
    <article className="bill-sheet" dir="rtl">
      <BillHead bill={bill} no={bill.receipt_no} />
      <table className="bill-lines">
        <thead><tr><th>بابت</th><th>مدت</th><th>مبلغ</th></tr></thead>
        <tbody>
          <tr>
            <td>{bill.pays_rest && "باقی "}{what}{!bill.plan_name && bill.description ? <div className="small">{bill.description}</div> : null}</td>
            <td>{bill.start_date && bill.end_date ? (bill.start_date === bill.end_date ? formatDay(bill.start_date) : <>از {formatDay(bill.start_date)}<br />تا {formatDay(bill.end_date)}</>) : "—"}</td>
            <td className="num">{fa(bill.fee ?? bill.amount)}</td>
          </tr>
          {!!bill.discount && <tr><td colSpan={2}>تخفیف</td><td className="num">{fa(-bill.discount)}</td></tr>}
          {bill.pays_rest && bill.paid_so_far !== null && (
            <tr><td colSpan={2}>پرداخت‌های قبلی</td><td className="num">{fa(-(bill.paid_so_far - bill.amount))}</td></tr>
          )}
        </tbody>
        <tfoot>
          <tr><th colSpan={2}>{part ? "پرداخت این بل" : "مجموع پرداخت"}</th><th className="num">{fa(bill.amount)} افغانی</th></tr>
          {part && <tr className="bill-rest"><th colSpan={2}>باقی</th><th className="num">{fa(bill.remaining ?? 0)} افغانی</th></tr>}
        </tfoot>
      </table>
      <p className="bill-words">به حروف: {inWords(bill.amount)} افغانی</p>
      {bill.voided && bill.void_reason && <p className="bill-words">دلیل باطل شدن: {bill.void_reason}</p>}
      <BillFoot bill={bill} />
    </article>
  );
}

function BillFoot({ bill }: { bill: Bill }) {
  return (
    <>
      <footer>
        <div><span>صادر کننده</span><strong>{bill.issued_by ?? "—"}</strong></div>
        <div><span>امضا و مهر</span><strong className="sign" /></div>
      </footer>
      <p className="bill-foot">این بل با سیستم مدیریت پژوهش چاپ شده و در سیستم ثبت است.</p>
    </>
  );
}

/**
 * How a bill goes on paper. The sheet is drawn for A5 and scaled for A6. On an A4 sheet the
 * bill sits in the top-right corner at its real size, with a cut line, so the rest of the
 * sheet stays clean for the next bill or for anything else.
 */
const PAPER = {
  "a4-a5": { label: "A4، بل A5 در گوشه", page: "A4 portrait", zoom: 1, corner: true },
  "a4-a6": { label: "A4، بل A6 در گوشه", page: "A4 portrait", zoom: 0.7, corner: true },
  a5: { label: "ورق A5", page: "A5 portrait", zoom: 1, corner: false },
  a6: { label: "ورق A6", page: "105mm 148mm", zoom: 0.7, corner: false },
} as const;
type Paper = keyof typeof PAPER;
const PAPER_KEY = "pz.billPaper";
function savedPaper(): Paper {
  try {
    const v = localStorage.getItem(PAPER_KEY);
    if (v && v in PAPER) return v as Paper;
    // Before v1.0 "a4" meant the bill stretched over the whole sheet.
    if (v === "a4") return "a4-a5";
  } catch { /* storage blocked: use the default */ }
  return "a4-a5";
}

/**
 * Shows a bill over the page with Print and Close. Printing counts the copy, so a second
 * print of the same bill says "کاپی" on the paper.
 */
export function BillPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState("");
  // Remembered on this computer: each desk prints on the paper its printer holds.
  const [paper, setPaper] = useState<Paper>(savedPaper);
  const choose = (p: Paper) => { setPaper(p); try { localStorage.setItem(PAPER_KEY, p); } catch { /* not remembered */ } };

  useEffect(() => { api.bill(id).then(setBill).catch((e) => setError(errorText(e))); }, [id]);

  function print() {
    if (!bill) return;
    // Count the print once the print dialog has closed, so this paper is not already stamped "کاپی".
    window.addEventListener("afterprint", () => {
      void api.billPrinted(bill.id).catch(() => {});
      setBill({ ...bill, printed_count: bill.printed_count + 1 });
    }, { once: true });
    // The page size and the scale of the A5 sheet, only while this bill prints.
    const style = document.createElement("style");
    style.textContent = `@page { size: ${PAPER[paper].page}; margin: 0; } @media print { .print-only.bill-print .bill-sheet { zoom: ${PAPER[paper].zoom}; } }`;
    document.head.appendChild(style);
    window.addEventListener("afterprint", () => style.remove(), { once: true });
    window.print();
  }

  return (
    <Modal label="بل" onClose={onClose} bare>
      <div className="modal-tools no-print">
        <button className="btn" onClick={print} disabled={!bill}>چاپ</button>
        <label className="paper-pick">
          <span className="muted small">اندازهٔ ورق</span>
          <select value={paper} onChange={(e) => choose(e.target.value as Paper)}>
            {(Object.keys(PAPER) as Paper[]).map((k) => <option key={k} value={k}>{PAPER[k].label}</option>)}
          </select>
        </label>
        <button className="btn ghost" onClick={onClose}>بستن</button>
      </div>
      <p className="muted small no-print paper-tip">
        {PAPER[paper].corner
          ? "در پنجرهٔ چاپ، کاغذ را A4 و مقیاس را «Default» یا 100٪ بگذارید. بل در گوشهٔ بالا راست چاپ می‌شود و بقیهٔ ورق سفید می‌ماند."
          : "در پنجرهٔ چاپ، اندازهٔ کاغذ را همین اندازه و مقیاس را «Default» یا 100٪ بگذارید."}
      </p>
      {error && <p className="form-error">{error}</p>}
      {bill ? <div style={{ zoom: Math.min(PAPER[paper].zoom, 1) }}><BillSheet bill={bill} /></div> : !error && <p className="muted">در حال بارگذاری…</p>}
    {/* Printing shows only this copy, outside the app, so the bill is exactly one page. */}
    {bill && createPortal(<div className={`print-only bill-print${PAPER[paper].corner ? " corner" : ""}`}><BillSheet bill={bill} /></div>, document.body)}
    </Modal>
  );
}
