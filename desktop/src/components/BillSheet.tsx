import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorText, type Bill } from "../lib/api";
import { fa, formatDay, formatNumeric } from "../lib/solar";
import { inWords } from "../lib/words";
import { Modal } from "./Modal";

export const CATEGORY_LABEL: Record<string, string> = {
  monthly: "عضویت ماهانه", daily: "عضویت روزانه", internet: "انترنت ماهانه", hotspot: "انترنت هاتسپات",
  books: "امانت کتاب", misc: "عواید متفرقه", services: "طلبات (عواید خدمات)",
};

/** The paper bill, sized for A5 (half an A4 sheet) on an ordinary printer. */
export function BillSheet({ bill }: { bill: Bill }) {
  const copy = bill.printed_count > 0;
  const what = bill.plan_name ?? CATEGORY_LABEL[bill.income_category] ?? bill.income_category;
  // A period paid in parts: this bill pays some, and what is left is printed under it.
  const part = bill.pays_rest || (bill.remaining ?? 0) > 0;
  return (
    <article className="bill-sheet" dir="rtl">
      {bill.voided && <div className="bill-stamp void">باطل شده</div>}
      {!bill.voided && copy && <div className="bill-stamp copy">کاپی</div>}
      <header>
        <img src="/logo-study-hall.png" alt="" />
        <div>
          <h1>کتابخانه و سالن مطالعه پژوهش</h1>
          <p>PEZHOHESH STUDY HALL</p>
        </div>
        <span className="bill-title">بل پرداخت</span>
      </header>
      <dl className="bill-meta">
        <div><dt>شمارهٔ بل</dt><dd dir="ltr">{bill.receipt_no}</dd></div>
        <div><dt>تاریخ</dt><dd>{formatDay(bill.issued_on)} <small dir="ltr">({formatNumeric(bill.issued_on)})</small></dd></div>
        {bill.customer && <div><dt>نام</dt><dd>{bill.customer}</dd></div>}
        {bill.father_name && <div><dt>نام پدر</dt><dd>{bill.father_name}</dd></div>}
        {bill.member_no !== null && <div><dt>آیدی</dt><dd dir="ltr">{bill.member_no}</dd></div>}
        {bill.card_no && <div><dt>کارت امانت</dt><dd dir="ltr">{bill.card_no}</dd></div>}
        {bill.phone && <div><dt>شماره تماس</dt><dd dir="ltr">{bill.phone}</dd></div>}
      </dl>
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
      <footer>
        <div><span>صادر کننده</span><strong>{bill.issued_by ?? "—"}</strong></div>
        <div><span>امضا و مهر</span><strong className="sign" /></div>
      </footer>
      <p className="bill-foot">این بل با سیستم مدیریت پژوهش چاپ شده و در سیستم ثبت است.</p>
    </article>
  );
}

/** Paper sizes a bill can print on. The sheet is drawn for A5 and scaled to the others. */
const PAPER = {
  a6: { label: "A6 (نصف A5)", page: "105mm 148mm", zoom: 0.7 },
  a5: { label: "A5", page: "A5 portrait", zoom: 1 },
  a4: { label: "A4", page: "A4 portrait", zoom: 210 / 148 },
} as const;
type Paper = keyof typeof PAPER;
const PAPER_KEY = "pz.billPaper";
function savedPaper(): Paper {
  try {
    const v = localStorage.getItem(PAPER_KEY);
    if (v && v in PAPER) return v as Paper;
  } catch { /* storage blocked: use the default */ }
  return "a5";
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
    style.textContent = `@page { size: ${PAPER[paper].page}; margin: 0; } @media print { .print-only .bill-sheet { zoom: ${PAPER[paper].zoom}; } }`;
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
      {error && <p className="form-error">{error}</p>}
      {bill ? <div style={{ zoom: Math.min(PAPER[paper].zoom, 1) }}><BillSheet bill={bill} /></div> : !error && <p className="muted">در حال بارگذاری…</p>}
    {/* Printing shows only this copy, outside the app, so the bill is exactly one page. */}
    {bill && createPortal(<div className="print-only"><BillSheet bill={bill} /></div>, document.body)}
    </Modal>
  );
}
