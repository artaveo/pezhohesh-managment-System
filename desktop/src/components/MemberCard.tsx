import { useMemo, useState } from "react";
import JsBarcode from "jsbarcode";
import { createPortal } from "react-dom";
import type { Member } from "../lib/api";
import { formatDay } from "../lib/solar";
import { useDocumentUrl } from "../lib/images";
import { Modal } from "./Modal";

/** The card's ID: six digits at least (051003), as the cards have always shown it. */
export const cardNo = (no: number) => String(no).padStart(6, "0");
/** Type size for a name by its length, so it fits the card's line. */
const fit = (s: string) => (s.length > 22 ? "longer" : s.length > 16 ? "long" : undefined);
const faDigits = (s: string) => s.replace(/\d/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);

/** The empty photo frame: a plain silhouette. */
function NoPhoto() {
  return (
    <span className="mc-nophoto">
      <svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="14" r="8" /><path d="M5 38c0-9 7-14 15-14s15 5 15 14z" /></svg>
      <small>عکس عضو</small>
    </span>
  );
}

/** The membership card, at the size of a bank card (85.6 × 54 mm). A field the member has
 *  no value for is left out, not shown empty. */
export function MemberCardFace({ member, photo }: { member: Member; photo: string | null }) {
  const name = `${member.first_name} ${member.last_name ?? ""}`.trim();
  return (
    <article className="member-card mc-front" dir="rtl">
      <img className="mc-wm" src="/logo-study-hall.png" alt="" />
      <header className="mc-head">
        <img className="mc-logo" src="/logo-study-hall.png" alt="" />
        <div className="mc-title">
          <strong>کتابخانه و سالن مطالعه پژوهش</strong>
          <span>PEZHOHESH STUDY HALL</span>
        </div>
        <span className="mc-pill">کارت عضویت</span>
      </header>
      <div className="mc-body">
        <div className="mc-photo">{photo ? <img src={photo} alt="" /> : <NoPhoto />}</div>
        <div className="mc-fields">
          <div className="mc-field"><span>نام</span><strong className={fit(name)}>{name}</strong></div>
          {member.father_name && <div className="mc-field"><span>نام پدر</span><strong className={fit(member.father_name)}>{member.father_name}</strong></div>}
          {/* Status (if any) and the day printed share one line; imported members have no
              real join date, so the card shows when it was printed. */}
          <div className="mc-pair">
            {member.field_of_study && <div><span>وضعیت</span><b>{member.field_of_study}</b></div>}
            <div><span>صدور</span><b>{formatDay(new Date())}</b></div>
          </div>
          <div className="mc-id"><span>آیدی</span><b>{faDigits(cardNo(member.member_no))}</b></div>
        </div>
      </div>
    </article>
  );
}

/** The member's ID as a Code 128 barcode, for the desk's barcode scanner. */
function Barcode({ value }: { value: string }) {
  const svg = useMemo(() => {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    JsBarcode(el, value, { format: "CODE128", width: 2, height: 60, margin: 0, displayValue: false, lineColor: "#1f3d12", background: "transparent" });
    el.setAttribute("preserveAspectRatio", "none");
    return el.outerHTML;
  }, [value]);
  return <div className="mc-barcode" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/**
 * The back of the card: the hall, its address and phones, the website's QR (with the logo in
 * its middle), and at the bottom the member's ID as a barcode for the desk's scanner.
 */
export function MemberCardBack({ member, ownerPhone = false }: { member: Member; ownerPhone?: boolean }) {
  const no = cardNo(member.member_no);
  return (
    <article className="member-card mc-back" dir="rtl">
      <img className="mc-wm" src="/logo-study-hall.png" alt="" />
      <div className="mc-back-top">
        <div className="mc-hall">
          <img className="mc-logo" src="/logo-study-hall.png" alt="" />
          <strong>کتابخانه و سالن مطالعه پژوهش</strong>
          <dl className="mc-contact">
            <div><dt>آدرس</dt><dd>کابل، برچی، ایستگاه سرپل، جوار شفاخانه وطن، مجموعه تحصیلی پژوهش</dd></div>
            <div><dt>تماس</dt><dd className="ltr" dir="ltr">+93 78 960 1245 · +93 77 25 72 054</dd></div>
            {/* Only when the member agreed at the desk (a tick in the print window). */}
            {ownerPhone && member.phone && <div><dt>دارندهٔ کارت</dt><dd className="ltr" dir="ltr">{member.phone}</dd></div>}
          </dl>
        </div>
        <div className="mc-site">
          <div className="mc-qr">
            <img src="/site-qr.svg" alt="" />
            <span className="mc-qr-logo"><img src="/logo-study-hall.png" alt="" /></span>
          </div>
          <small>وب‌سایت پژوهش</small>
        </div>
      </div>
      <div className="mc-back-foot">
        <p>فیس پرداخت‌شده دوباره مسترد نمی‌گردد.</p>
        <div className="mc-code">
          <Barcode value={no} />
          <span dir="ltr">PSH · {no}</span>
        </div>
      </div>
    </article>
  );
}

type Side = "front" | "back" | "both";

const PAGE = {
  // A PVC card in the printer's card tray, edge to edge.
  card: "@page { size: 85.6mm 54mm; margin: 0; }",
  // On an A4 sheet at its real size in the top-right corner, to cut out (and laminate).
  a4: "@page { size: A4 portrait; margin: 0; }",
};

/** The card over the page, with a choice of PVC card or A4 paper, and Print. */
export function MemberCardPreview({ member, photoId, onClose }: { member: Member; photoId: string | null; onClose: () => void }) {
  const { url: photo, failed } = useDocumentUrl(photoId);
  const [paper, setPaper] = useState<keyof typeof PAGE>("card");
  const [side, setSide] = useState<Side>("front");
  // The member's own number goes on the back only if they want it (ask them at the desk).
  const [ownerPhone, setOwnerPhone] = useState(false);
  const waiting = side !== "back" && !!photoId && !photo && !failed;

  function print() {
    // The bills' A5 page rule is replaced only while this card prints.
    const style = document.createElement("style");
    style.textContent = PAGE[paper];
    document.head.appendChild(style);
    window.addEventListener("afterprint", () => style.remove(), { once: true });
    window.print();
  }

  return (
    <Modal label="کارت عضویت" onClose={onClose} className="card-modal">
      <div className="modal-tools no-print">
        <button className="btn" onClick={print} disabled={waiting}>چاپ</button>
        <button className="btn ghost" onClick={onClose}>بستن</button>
      </div>
      <div className="paper-choice" role="radiogroup" aria-label="چاپ روی">
        <label className="check"><input type="radio" checked={paper === "card"} onChange={() => setPaper("card")} /> کارت PVC (سینی کارت پرینتر)</label>
        <label className="check"><input type="radio" checked={paper === "a4"} onChange={() => setPaper("a4")} /> کاغذ A4 (برای بریدن)</label>
      </div>
      <div className="paper-choice" role="radiogroup" aria-label="کدام طرف">
        <label className="check"><input type="radio" checked={side === "front"} onChange={() => setSide("front")} /> روی کارت</label>
        <label className="check"><input type="radio" checked={side === "back"} onChange={() => setSide("back")} /> پشت کارت</label>
        <label className="check"><input type="radio" checked={side === "both"} onChange={() => setSide("both")} /> هر دو طرف</label>
      </div>
      {member.phone && side !== "front" && (
        <label className="check owner-phone">
          <input type="checkbox" checked={ownerPhone} onChange={(e) => setOwnerPhone(e.target.checked)} />
          شمارهٔ عضو ({<bdi dir="ltr">{member.phone}</bdi>}) پشت کارت چاپ شود — اول از خودش بپرسید
        </label>
      )}
      {!photoId && side !== "back" && <p className="notice warn">این عضو هنوز عکس ندارد. اول عکسش را در «عکس و تذکره» اضافه کنید.</p>}
      {failed && <p className="notice warn">عکس این عضو باز نشد. دوباره عکسش را اضافه کنید.</p>}
      <div className="member-card-stage">
        {side !== "back" && <MemberCardFace member={member} photo={photo} />}
        {side !== "front" && <MemberCardBack member={member} ownerPhone={ownerPhone} />}
      </div>
      <p className="muted small">
        در پنجرهٔ چاپ، اندازهٔ کاغذ را «Card» یا «CR80 (86×54 mm)» و مقیاس را 100٪ (Actual size) بگذارید.
        {paper === "card" && side === "both" && " اول روی کارت چاپ می‌شود؛ بعد همان کارت را برگردانید و در سینی بگذارید تا پشتش چاپ شود."}
        {paper === "a4" && side === "both" && " روی و پشت کنار هم چاپ می‌شوند؛ از خط وسط تا کنید، دورش را ببرید و لمینیت کنید."}
      </p>
      {createPortal(
        <div className={`print-only card-print ${paper} ${side}`}>
          {side !== "back" && <MemberCardFace member={member} photo={photo} />}
          {side !== "front" && <MemberCardBack member={member} ownerPhone={ownerPhone} />}
        </div>, document.body)}
    </Modal>
  );
}
