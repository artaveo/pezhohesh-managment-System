import { useEffect, useState } from "react";
import { api, errorText, type BookStatus, type CatalogBook, type UnavailableReason } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { SolarDate } from "../components/SolarDate";
import { Modal } from "../components/Modal";

export const REASON_LABEL: Record<UnavailableReason, string> = {
  lost: "گم شده", not_returned: "برنگشته (امانت قدیمی)", damaged: "خراب شده", repair: "در صحافی / ترمیم",
  with_staff: "نزد کارمند", removed: "از فهرست کنار رفته", other: "دلیل دیگر",
};

/** Copies of a catalogue book on the shelf now: all copies less those lent and those out of reach. */
export const onShelf = (b: CatalogBook) => b.copies - b.on_loan - (b.unavailable ?? 0);

/** How many copies are on the shelf, as a small status label. */
export function Copies({ b }: { b: CatalogBook }) {
  const left = onShelf(b);
  const away = b.copies - left;
  if (left <= 0) return <span className="days late">هیچ جلدی روی قفسه نیست</span>;
  return <span className={away ? "days due" : "days ok"}>{fa(left)} از {fa(b.copies)} جلد موجود</span>;
}

/** Where every copy of a book is: who has each one (and in which kind of loan), and those out of reach. */
export function BookWhere({ book, onChanged }: { book: CatalogBook; onChanged?: () => void }) {
  const [s, setS] = useState<BookStatus | null>(null);
  const [error, setError] = useState("");
  const [marking, setMarking] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    api.bookStatus(book.id, ctl.signal).then(setS).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [book.id, tick]);
  const changed = () => { setTick((t) => t + 1); onChanged?.(); };
  async function resolve(id: string) {
    try { await api.resolveUnavailable(id); changed(); } catch (e) { setError(errorText(e)); }
  }
  const left = s ? book.copies - s.holders.length - s.out_of_reach.reduce((t, x) => t + x.copies, 0) : onShelf(book);

  return (
    <div className="book-where">
      <p>
        <strong>{fa(Math.max(left, 0))}</strong> از {fa(book.copies)} جلد روی قفسه
        {s && s.holders.length > 0 && <> · {fa(s.holders.length)} امانت بیرون</>}
        {s && s.out_of_reach.length > 0 && <> · {fa(s.out_of_reach.reduce((t, x) => t + x.copies, 0))} در دسترس نیست</>}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {s && s.holders.length > 0 && (
        <ul className="where-list">
          {s.holders.map((h) => (
            <li key={h.loan_id}>
              <span className={`chip ${h.scope === "hall" ? "kind-daily" : ""}`}>{h.scope === "hall" ? "امانت روزانه" : "امانت هفته‌وار"}</span>
              <strong>{h.borrower}</strong>
              {h.card_no && <span className="muted"><bdi dir="ltr">{h.card_no}</bdi></span>}
              {h.phone && <span className="muted"><bdi dir="ltr">{h.phone}</bdi></span>}
              <span className="muted small">از {formatDay(h.loaned_on)}{h.scope === "home" && <> · موعد {formatDay(h.due_on)}</>}</span>
            </li>
          ))}
        </ul>
      )}
      {s && s.out_of_reach.length > 0 && (
        <ul className="where-list">
          {s.out_of_reach.map((x) => (
            <li key={x.id}>
              <span className="chip">{REASON_LABEL[x.reason]}</span>
              <strong>{fa(x.copies)} جلد</strong>
              <span className="muted small">از {formatDay(x.since)}{x.note && <> · {x.note}</>}</span>
              <button className="btn small ghost" onClick={() => void resolve(x.id)}>برگشت به قفسه</button>
            </li>
          ))}
        </ul>
      )}
      {!marking
        ? left > 0 && <button className="btn ghost small" onClick={() => setMarking(true)}>ثبت جلد گم‌شده یا خارج از دسترس</button>
        : <MarkUnavailable book={book} max={left} onDone={(saved) => { setMarking(false); if (saved) changed(); }} />}
    </div>
  );
}

function MarkUnavailable({ book, max, onDone }: { book: CatalogBook; max: number; onDone: (saved: boolean) => void }) {
  const [copies, setCopies] = useState("1");
  const [reason, setReason] = useState<UnavailableReason>("lost");
  const [note, setNote] = useState("");
  const [since, setSince] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const n = Number(copies);
  async function save() {
    setBusy(true);
    setError("");
    try {
      await api.markUnavailable(book.id, { copies: n, reason, note: note.trim() || undefined, since });
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  return (
    <div className="inset">
      <div className="form-grid">
        <label className="field wide">
          <span>چند جلد</span>
          <input dir="ltr" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/\D/g, ""))} />
          <small className="muted">تا {fa(max)} جلد که روی قفسه است.</small>
        </label>
        <label className="field wide">
          <span>دلیل</span>
          <select value={reason} onChange={(e) => setReason(e.target.value as UnavailableReason)}>
            {(Object.keys(REASON_LABEL) as UnavailableReason[]).map((r) => <option key={r} value={r}>{REASON_LABEL[r]}</option>)}
          </select>
        </label>
        <SolarDate label="از تاریخ" value={since} onChange={setSince} />
        <label className="field wide"><span>توضیح{reason === "other" ? " *" : ""}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً نزد چه کسی، یا چه شده" /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={!(n > 0 && n <= max) || !since || (reason === "other" && !note.trim()) || busy} onClick={() => void save()}>ثبت</button>
        <button className="btn ghost" onClick={() => onDone(false)}>انصراف</button>
      </div>
    </div>
  );
}

/** The same, as a dialog from the catalogue. */
export function BookWhereDialog({ book, onClose }: { book: CatalogBook; onClose: (changed: boolean) => void }) {
  const [changed, setChanged] = useState(false);
  return (
    <Modal label={`وضعیت ${book.title}`} onClose={() => onClose(changed)}>
      <h2>{book.title}</h2>
      <p className="muted small">{[book.code, book.author, book.section].filter(Boolean).join(" · ")}</p>
      <BookWhere book={book} onChanged={() => setChanged(true)} />
      <div className="actions"><button className="btn ghost" onClick={() => onClose(changed)}>بستن</button></div>
    </Modal>
  );
}
