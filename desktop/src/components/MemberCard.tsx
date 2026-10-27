import { useState } from "react";
import { createPortal } from "react-dom";
import type { Member } from "../lib/api";
import { formatDay } from "../lib/solar";
import { useDocumentUrl } from "../lib/images";

/** The membership card, at the size of a bank card (85.6 × 54 mm). */
export function MemberCardFace({ member, photo }: { member: Member; photo: string | null }) {
  const name = `${member.first_name} ${member.last_name ?? ""}`.trim();
  return (
    <article className="member-card" dir="rtl">
      <header>
        <img src="/logo-study-hall.png" alt="" />
        <div>
          <strong>کتابخانه و سالن مطالعه پژوهش</strong>
          <span>کارت عضویت</span>
        </div>
      </header>
      <div className="member-card-body">
        <dl>
          <div className="name"><dt>نام</dt><dd>{name}</dd></div>
          {member.father_name && <div><dt>فرزند</dt><dd>{member.father_name}</dd></div>}
          {member.field_of_study && <div><dt>رشته</dt><dd>{member.field_of_study}</dd></div>}
          {/* Imported members have no real join date, so the card shows when it was printed. */}
          <div><dt>صدور</dt><dd>{formatDay(new Date())}</dd></div>
        </dl>
        <div className="member-card-photo">{photo ? <img src={photo} alt="" /> : <span>عکس</span>}</div>
      </div>
      <footer>
        <span>آیدی</span>
        <strong dir="ltr">{member.member_no}</strong>
      </footer>
    </article>
  );
}

const PAGE = {
  // A PVC card in the printer's card tray, edge to edge.
  card: "@page { size: 85.6mm 54mm; margin: 0; }",
  // On an A4 sheet at its real size, to cut out (and laminate).
  a4: "@page { size: A4 portrait; margin: 15mm; }",
};

/** The card over the page, with a choice of PVC card or A4 paper, and Print. */
export function MemberCardPreview({ member, photoId, onClose }: { member: Member; photoId: string | null; onClose: () => void }) {
  const { url: photo, failed } = useDocumentUrl(photoId);
  const [paper, setPaper] = useState<keyof typeof PAGE>("card");

  function print() {
    // The bills' A5 page rule is replaced only while this card prints.
    const style = document.createElement("style");
    style.textContent = PAGE[paper];
    document.head.appendChild(style);
    window.addEventListener("afterprint", () => style.remove(), { once: true });
    window.print();
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="کارت عضویت">
      <div className="modal-body panel card-modal">
        <div className="modal-tools no-print">
          <button className="btn" onClick={print} disabled={!!photoId && !photo && !failed}>چاپ</button>
          <button className="btn ghost" onClick={onClose}>بستن</button>
        </div>
        <div className="paper-choice" role="radiogroup" aria-label="چاپ روی">
          <label className="check"><input type="radio" checked={paper === "card"} onChange={() => setPaper("card")} /> کارت PVC (سینی کارت پرینتر)</label>
          <label className="check"><input type="radio" checked={paper === "a4"} onChange={() => setPaper("a4")} /> کاغذ A4 (برای بریدن)</label>
        </div>
        {!photoId && <p className="notice warn">این عضو هنوز عکس ندارد. اول عکسش را در «عکس و تذکره» اضافه کنید.</p>}
        {failed && <p className="notice warn">عکس این عضو باز نشد. دوباره عکسش را اضافه کنید.</p>}
        <div className="member-card-stage"><MemberCardFace member={member} photo={photo} /></div>
        <p className="muted small">
          در پنجرهٔ چاپ، اندازهٔ کاغذ را «Card» یا «CR80 (86×54 mm)» و مقیاس را 100٪ (Actual size) بگذارید.
        </p>
      </div>
      {createPortal(<div className={`print-only card-print ${paper}`}><MemberCardFace member={member} photo={photo} /></div>, document.body)}
    </div>
  );
}
