import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorText, type Bill } from "../lib/api";
import { fa, formatDay, formatNumeric } from "../lib/solar";
import { inWords } from "../lib/words";

export const CATEGORY_LABEL: Record<string, string> = {
  monthly: "عضویت ماهانه", daily: "عضویت روزانه", internet: "انترنت ماهانه", hotspot: "انترنت هاتسپات",
  books: "امانت کتاب", misc: "عواید متفرقه", services: "طلبات (عواید خدمات)",
};

/** The paper bill, sized for A5 (half an A4 sheet) on an ordinary printer. */
export function BillSheet({ bill }: { bill: Bill }) {
  const copy = bill.printed_count > 0;
  const what = bill.plan_name ?? CATEGORY_LABEL[bill.income_category] ?? bill.income_category;
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
        {bill.phone && <div><dt>شماره تماس</dt><dd dir="ltr">{bill.phone}</dd></div>}
      </dl>
      <table className="bill-lines">
        <thead><tr><th>بابت</th><th>مدت</th><th>مبلغ</th></tr></thead>
        <tbody>
          <tr>
            <td>{what}{!bill.plan_name && bill.description ? <div className="small">{bill.description}</div> : null}</td>
            <td>{bill.start_date && bill.end_date ? (bill.start_date === bill.end_date ? formatDay(bill.start_date) : <>از {formatDay(bill.start_date)}<br />تا {formatDay(bill.end_date)}</>) : "—"}</td>
            <td className="num">{fa(bill.fee ?? bill.amount)}</td>
          </tr>
          {!!bill.discount && <tr><td colSpan={2}>تخفیف</td><td className="num">{fa(-bill.discount)}</td></tr>}
        </tbody>
        <tfoot><tr><th colSpan={2}>مجموع پرداخت</th><th className="num">{fa(bill.amount)} افغانی</th></tr></tfoot>
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

/**
 * Shows a bill over the page with Print and Close. Printing counts the copy, so a second
 * print of the same bill says "کاپی" on the paper.
 */
export function BillPreview({ id, onClose }: { id: string; onClose: () => void }) {
  const [bill, setBill] = useState<Bill | null>(null);
  const [error, setError] = useState("");

  useEffect(() => { api.bill(id).then(setBill).catch((e) => setError(errorText(e))); }, [id]);

  function print() {
    if (!bill) return;
    // Count the print once the print dialog has closed, so this paper is not already stamped "کاپی".
    window.addEventListener("afterprint", () => {
      void api.billPrinted(bill.id).catch(() => {});
      setBill({ ...bill, printed_count: bill.printed_count + 1 });
    }, { once: true });
    window.print();
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="بل">
      <div className="modal-body">
        <div className="modal-tools no-print">
          <button className="btn" onClick={print} disabled={!bill}>چاپ</button>
          <button className="btn ghost" onClick={onClose}>بستن</button>
        </div>
        {error && <p className="form-error">{error}</p>}
        {bill ? <BillSheet bill={bill} /> : !error && <p className="muted">در حال بارگذاری…</p>}
      </div>
      {/* Printing shows only this copy, outside the app, so the bill is exactly one page. */}
      {bill && createPortal(<div className="print-only"><BillSheet bill={bill} /></div>, document.body)}
    </div>
  );
}
