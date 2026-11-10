import { useEffect, useState } from "react";
import { api, errorText, type Borrower, type CatalogBook, type HallLoan } from "../lib/api";
import { fa, formatDay, iso } from "../lib/solar";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { SolarDate } from "../components/SolarDate";
import { BookWhere, Copies, onShelf } from "./BookStatus";

/**
 * Books read inside the hall for the day: the manager writes who took which book, and ticks
 * it when it comes back. No fee; the book is off the shelf until then. Old paper lists can
 * be entered with their own date.
 */
export function HallLoans({ findBorrower, pickBook }: {
  findBorrower: (pick: (b: Borrower) => void) => React.ReactNode;
  pickBook: (title: string, setTitle: (t: string) => void, pick: (b: CatalogBook) => void) => React.ReactNode;
}) {
  const period = usePeriod("today");
  const { from, to, label } = period.range;
  const [openOnly, setOpenOnly] = useState(false);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<HallLoan[] | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.hallLoans({ from, to, q: q.trim() || undefined, open: openOnly }, ctl.signal)
        .then((r) => { setRows(r); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [from, to, q, openOnly, tick]);

  async function back(l: HallLoan) {
    try { await api.backInHall(l.id); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); }
  }
  const out = rows?.filter((r) => !r.returned_on).length ?? 0;

  return (
    <>
      {adding
        ? <NewHallLoan findBorrower={findBorrower} pickBook={pickBook} onDone={(saved) => { setAdding(false); if (saved) setTick((t) => t + 1); }} />
        : <div className="actions"><button className="btn big" onClick={() => setAdding(true)}>+ امانت روزانه</button></div>}
      <div className="list-tools">
        <input className="search" type="search" placeholder="جستجو: نام کتاب، نام، آیدی، کارت یا شماره تماس" aria-label="جستجو در امانت‌های روزانه" value={q} onChange={(e) => setQ(e.target.value)} />
        <label className="check"><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> فقط برنگشته‌ها (همهٔ روزها)</label>
      </div>
      {!openOnly && <PeriodPicker value={period.value} onChange={period.setValue} />}
      <p className="muted small">{openOnly ? "همهٔ کتاب‌هایی که هنوز برنگشته‌اند" : label}{rows ? ` · ${fa(rows.length)} امانت · ${fa(out)} برنگشته` : ""}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>کتاب</th><th>امانت‌گیرنده</th><th>آیدی / کارت</th><th>شماره تماس</th><th>برگشت</th></tr></thead>
          <tbody>
            {rows?.map((l) => (
              <tr key={l.id} className={!l.returned_on && l.loaned_on < iso(new Date()) ? "late" : ""}>
                <td>{formatDay(l.loaned_on)}</td>
                <td><strong>{l.book_title}</strong>{l.note && <div className="muted small">{l.note}</div>}</td>
                <td>{l.borrower}</td>
                <td className="num"><bdi dir="ltr">{l.card_no ?? "—"}</bdi></td>
                <td><bdi dir="ltr">{l.phone ?? "—"}</bdi></td>
                <td>
                  {l.returned_on
                    ? <span className="days ok">✓ {l.returned_on === l.loaned_on ? "همان روز" : formatDay(l.returned_on)}</span>
                    : <button className="btn small" onClick={() => void back(l)}>برگشت</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows && !rows.length && <p className="muted empty">{q ? "چیزی پیدا نشد." : "امانت روزانه‌ای نیست."}</p>}
        {!rows && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
    </>
  );
}

function NewHallLoan({ findBorrower, pickBook, onDone }: {
  findBorrower: (pick: (b: Borrower) => void) => React.ReactNode;
  pickBook: (title: string, setTitle: (t: string) => void, pick: (b: CatalogBook) => void) => React.ReactNode;
  onDone: (saved: boolean) => void;
}) {
  const [who, setWho] = useState<Borrower | null>(null);
  // Someone with no card or member number: kept by the name typed.
  const [byName, setByName] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [title, setTitle] = useState("");
  const [book, setBook] = useState<CatalogBook | null>(null);
  const [on, setOn] = useState(iso(new Date()));
  const [back, setBack] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const today = iso(new Date());

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.lend({
        scope: "hall",
        ...(who ? (who.kind === "deposit" ? { deposit_id: who.id } : { member_id: who.id }) : { borrower_name: name.trim(), borrower_phone: phone.trim() || undefined }),
        ...(book ? { book_id: book.id } : { book_title: title.trim() }),
        loaned_on: on, due_on: on,
      });
      // An old paper list: the book came back the same day.
      if (back) await api.backInHall(r, on);
      onDone(true);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  const hasWho = !!who || (byName && !!name.trim());
  const full = book && onShelf(book) <= 0;

  return (
    <section className="panel wide">
      <h2>امانت روزانه (داخل سالن)</h2>
      {who ? (
        <div className="picked">
          <span className="num"><bdi dir="ltr">{who.card_no}</bdi></span>
          <strong>{who.name}</strong>
          <span className="muted">{who.kind === "member" ? "عضو قرائت‌خانه" : who.guarantee}</span>
          <button className="btn small ghost" onClick={() => setWho(null)}>تغییر</button>
        </div>
      ) : byName ? (
        <div className="form-grid">
          <label className="field wide"><span>نام *</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
          <label className="field wide"><span>شماره تماس</span><input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
          <button className="btn small ghost" onClick={() => setByName(false)}>جستجو در اعضا و کارت‌ها</button>
        </div>
      ) : (
        <>
          {findBorrower(setWho)}
          <button className="link" onClick={() => setByName(true)}>آیدی یا کارت ندارد؛ با نام بنویس</button>
        </>
      )}
      {hasWho && (
        book ? (
          <>
            <div className="picked">
              <span className="num"><bdi dir="ltr">{book.code ?? "—"}</bdi></span>
              <strong>{book.title}</strong>
              <Copies b={book} />
              <button className="btn small ghost" onClick={() => setBook(null)}>تغییر</button>
            </div>
            {full && <div className="inset"><BookWhere book={book} /></div>}
          </>
        ) : pickBook(title, setTitle, setBook)
      )}
      {hasWho && (
        <div className="form-grid">
          <SolarDate label="تاریخ" value={on} onChange={setOn} />
          {on && on < today && (
            <label className="check choice"><input type="checkbox" checked={back} onChange={(e) => setBack(e.target.checked)} /> <span>همان روز برگشته (از دفتر قدیمی)</span></label>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn big" disabled={!hasWho || !(book || title.trim()) || !on || on > today || !!full || busy} onClick={() => void save()}>ثبت</button>
        <button className="btn ghost" onClick={() => onDone(false)}>انصراف</button>
      </div>
    </section>
  );
}
