import { useEffect, useState } from "react";
import {
  api, errorText,
  type BookRules, type Borrower, type Deposit, type DepositKind, type DepositPage, type Loan,
} from "../lib/api";
import { addDays, fa, formatDay, iso, parseIso } from "../lib/solar";
import { LoansList } from "./DueLists";
import { SolarDate } from "../components/SolarDate";
import { RemoveButton } from "../components/RemoveButton";
import { BillPreview } from "../components/BillSheet";
import { Icon } from "../components/Icon";

type Tab = "loans" | "lend" | "deposits" | "new-deposit";

const KIND_LABEL: Record<DepositKind, string> = { cash: "ضمانت پولی", book: "ضمانت کتاب", person: "ضمانت شخص" };

/** An amount as typed: digits and one decimal point. */
const digits = (s: string) => s.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");
const amount = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0);

/**
 * Lending books like the Excel lending sheets: a borrower leaves a guarantee (their lending
 * card), takes books on it, and pays the weekly fee and any late fine when a book comes back.
 */
export function Books() {
  const [tab, setTab] = useState<Tab>("loans");
  const [returning, setReturning] = useState<string | null>(null);
  const [bill, setBill] = useState<string | null>(null);
  const [borrower, setBorrower] = useState<Borrower | null>(null);
  const [tick, setTick] = useState(0);
  const lendTo = (b: Borrower | null) => { setBorrower(b); setTab("lend"); };
  return (
    <div className="page">
      <div className="desk-tasks">
        <button className={tab === "loans" ? "on" : ""} onClick={() => setTab("loans")}><Icon name="book" size={20} /> کتاب‌های بیرون</button>
        <button className={tab === "lend" ? "on" : ""} onClick={() => lendTo(null)}><Icon name="plus" size={20} /> امانت دادن</button>
        <button className={tab === "deposits" ? "on" : ""} onClick={() => setTab("deposits")}><Icon name="card" size={20} /> ضمانت‌ها</button>
        <button className={tab === "new-deposit" ? "on" : ""} onClick={() => setTab("new-deposit")}><Icon name="wallet" size={20} /> ضمانت جدید</button>
      </div>
      {tab === "loans" && <LoansList key={tick} open={setReturning} />}
      {tab === "lend" && <Lend key={borrower?.id ?? "new"} initial={borrower} done={() => { setTick((t) => t + 1); setTab("loans"); }} />}
      {tab === "deposits" && <Deposits lendTo={lendTo} />}
      {tab === "new-deposit" && <NewDeposit lendTo={lendTo} />}
      {returning && (
        <ReturnBook id={returning} onClose={(receipt) => {
          setReturning(null);
          setTick((t) => t + 1);
          if (receipt) setBill(receipt);
        }} />
      )}
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lending a book

function FindBorrower({ pick }: { pick: (b: Borrower) => void }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Borrower[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!q.trim()) { setRows(null); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.borrowers(q, ctl.signal).then((r) => { setRows(r); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, 200);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q]);
  return (
    <>
      <input className="search big" type="search" autoFocus placeholder="کارت امانت (p-105)، آیدی عضو، نام یا شماره تماس" value={q} onChange={(e) => setQ(e.target.value)} />
      {error && <p className="form-error">{error}</p>}
      {rows && !rows.length && <p className="muted">کسی پیدا نشد. اگر عضو قرائت‌خانه نیست، اول «ضمانت جدید» بگیرید.</p>}
      {rows && rows.length > 0 && (
        <ul className="pick-list">
          {rows.map((b) => (
            <li key={`${b.kind}-${b.id}`}>
              <button onClick={() => pick(b)}>
                <span className="num"><bdi dir="ltr">{b.card_no}</bdi></span>
                <strong>{b.name}</strong>
                <span className="muted">{b.father_name ?? ""}</span>
                <span className={b.kind === "member" && !b.active ? "form-error inline" : "muted"}>{b.kind === "member" ? (b.active ? "عضو قرائت‌خانه" : "عضویتش ختم شده") : b.guarantee}</span>
                <span className={b.open_loans ? "days due" : "days ok"}>{b.open_loans ? `${fa(b.open_loans)} کتاب بیرون` : "کتابی بیرون ندارد"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Lend({ initial, done }: { initial: Borrower | null; done: () => void }) {
  const [who, setWho] = useState<Borrower | null>(initial);
  const [rules, setRules] = useState<BookRules | null>(null);
  const [titles, setTitles] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [from, setFrom] = useState(iso(new Date()));
  const [due, setDue] = useState(iso(addDays(new Date(), 14)));
  const [fee, setFee] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.bookRules().then((r) => { setRules(r); setFee(String(r.weekly_fee)); }).catch((e) => setError(errorText(e)));
    api.bookTitles().then(setTitles).catch(() => {});
  }, []);
  // The due date follows the lending date until it is changed by hand.
  const [dueTouched, setDueTouched] = useState(false);
  useEffect(() => {
    if (rules && from && !dueTouched) setDue(iso(addDays(parseIso(from), rules.loan_days)));
  }, [rules, from, dueTouched]);

  async function save() {
    if (!who) return;
    setBusy(true);
    setError("");
    try {
      await api.lend({
        ...(who.kind === "deposit" ? { deposit_id: who.id } : { member_id: who.id }),
        book_title: title, loaned_on: from, due_on: due, weekly_fee: amount(fee),
      });
      done();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <section className="panel wide">
      <h2>امانت دادن کتاب</h2>
      {!who ? <FindBorrower pick={setWho} /> : (
        <>
          <div className="picked">
            <span className="num"><bdi dir="ltr">{who.card_no}</bdi></span>
            <strong>{who.name}</strong>
            <span className="muted">{who.kind === "member" ? "عضو قرائت‌خانه" : who.guarantee}</span>
            {who.kind === "member" && !who.active && <span className="days late">عضویتش ختم شده؛ بهتر است اول تمدید کند یا ضمانت بگذارد</span>}
            {who.open_loans > 0 && <span className="days due">{fa(who.open_loans)} کتاب دیگر هم بیرون دارد</span>}
            <button className="btn small ghost" onClick={() => setWho(null)}>تغییر</button>
          </div>
          <div className="form-grid">
            <label className="field wide span-2">
              <span>نام کتاب *</span>
              <input list="book-titles" value={title} onChange={(e) => setTitle(e.target.value)} autoFocus />
              <datalist id="book-titles">{titles.map((t) => <option key={t} value={t} />)}</datalist>
            </label>
            <SolarDate label="تاریخ امانت" value={from} onChange={setFrom} />
            <SolarDate label="موعد برگشت" value={due} onChange={(d) => { setDueTouched(true); setDue(d); }} />
            <label className="field wide">
              <span>فیس هفته‌وار (افغانی)</span>
              <input dir="ltr" inputMode="numeric" value={fee} onChange={(e) => setFee(digits(e.target.value))} />
              <small className="muted">صفر یعنی رایگان. فیس هنگام برگشت کتاب گرفته می‌شود.</small>
            </label>
          </div>
          {rules && rules.fine_per_day > 0 && <p className="muted small">هر روز دیرکرد بعد از موعد {fa(rules.fine_per_day)} افغانی جریمه دارد.</p>}
          {error && <p className="form-error">{error}</p>}
          <div className="actions">
            <button className="btn big" disabled={!title.trim() || !from || !due || busy} onClick={() => void save()}>ثبت امانت</button>
          </div>
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// A book coming back

function ReturnBook({ id, onClose }: { id: string; onClose: (receipt: string | null) => void }) {
  const [on, setOn] = useState(iso(new Date()));
  const [loan, setLoan] = useState<Loan | null>(null);
  const [fee, setFee] = useState("");
  const [fine, setFine] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // The charge depends on the return day; changing the day fills in the new amounts.
  useEffect(() => {
    if (!on) return;
    const ctl = new AbortController();
    api.loan(id, on, ctl.signal).then((l) => {
      setLoan(l);
      setFee(String(l.charge?.fee ?? 0));
      setFine(String(l.charge?.fine ?? 0));
    }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [id, on]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.returnLoan(id, { returned_on: on, fee: amount(fee), fine: amount(fine) });
      onClose(r.receipt_id);
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }
  async function remove() {
    try { await api.deleteLoan(id); onClose(null); } catch (e) { setError(errorText(e)); }
  }

  const total = amount(fee) + amount(fine);
  const c = loan?.charge;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="برگشت کتاب">
      <div className="modal-body panel">
        <h2>برگشت کتاب</h2>
        {!loan ? (error ? <p className="form-error">{error}</p> : <p className="muted">در حال بارگذاری…</p>) : (
          <>
            <p><strong>«{loan.book_title}»</strong> · {loan.borrower} <span className="muted">(<bdi dir="ltr">{loan.card_no}</bdi>)</span></p>
            <p className="muted small">
              امانت {formatDay(loan.loaned_on)} · موعد {formatDay(loan.due_on)} · فیس هفته‌وار {fa(loan.weekly_fee)} افغانی
            </p>
            <div className="form-grid">
              <SolarDate label="تاریخ برگشت" value={on} onChange={setOn} />
              <label className="field wide">
                <span>فیس (افغانی)</span>
                <input dir="ltr" inputMode="numeric" value={fee} onChange={(e) => setFee(digits(e.target.value))} />
                {c && <small className="muted">{fa(c.weeks)} هفته × {fa(loan.weekly_fee)}</small>}
              </label>
              <label className="field wide">
                <span>جریمه (افغانی)</span>
                <input dir="ltr" inputMode="numeric" value={fine} onChange={(e) => setFine(digits(e.target.value))} />
                {c && <small className={c.days_late ? "form-error inline" : "muted"}>{c.days_late ? `${fa(c.days_late)} روز دیرکرد` : "به وقتش برگشت"}</small>}
              </label>
            </div>
            <p className="period-sum">{total > 0 ? <>پرداخت: <strong>{fa(total)} افغانی</strong> (بل چاپ می‌شود)</> : "پولی گرفته نمی‌شود؛ بل صادر نمی‌شود."}</p>
            {error && <p className="form-error">{error}</p>}
            <div className="actions">
              <button className="btn" disabled={!on || busy} onClick={() => void save()}>{total > 0 ? "ثبت برگشت و بل" : "ثبت برگشت"}</button>
              <button className="btn ghost" onClick={() => onClose(null)}>انصراف</button>
              {loan.removable && <span className="muted small">اشتباه ثبت شده؟ <RemoveButton onConfirm={() => void remove()} /></span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Guarantees

function guarantee(d: Deposit) {
  if (d.kind === "cash") return `${fa(d.amount ?? 0)} افغانی`;
  if (d.kind === "book") return d.deposit_book ?? "—";
  return `ضامن: ${d.guarantor ?? "—"}`;
}

function Deposits({ lendTo }: { lendTo: (b: Borrower) => void }) {
  const [scope, setScope] = useState<"open" | "all">("open");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<DepositPage | null>(null);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.deposits({ scope, q }, ctl.signal).then((p) => { setPage(p); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [scope, q, tick]);

  async function act(fn: () => Promise<void>) {
    try { await fn(); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); }
  }

  return (
    <>
      <div className="list-tools">
        <div className="segmented" role="tablist">
          <button role="tab" aria-selected={scope === "open"} className={scope === "open" ? "on" : ""} onClick={() => setScope("open")}>ضمانت‌های نزد ما</button>
          <button role="tab" aria-selected={scope === "all"} className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>همه، با پس داده‌شده‌ها</button>
        </div>
        <input className="search" type="search" placeholder="جستجو: کارت، نام، نام پدر یا شماره تماس" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <p className="muted small">
        {fa(page?.total ?? 0)} کارت · پول ضمانت نزد ما: <strong>{fa(page?.cash_held ?? 0)} افغانی</strong> (مال امانت‌گیرنده‌هاست، درآمد نیست)
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>کارت</th><th>نام</th><th>نام پدر</th><th>شماره تماس</th><th>ضمانت</th><th>تاریخ</th><th>کتاب بیرون</th><th /></tr></thead>
          <tbody>
            {page?.rows.map((d) => (
              <tr key={d.id} className={d.returned_on ? "inactive" : ""}>
                <td className="num"><bdi dir="ltr">{d.code}</bdi></td>
                <td><strong>{d.name}</strong>{d.note && <div className="muted small">{d.note}</div>}</td>
                <td>{d.father_name ?? "—"}</td>
                <td><bdi dir="ltr">{d.phone ?? "—"}</bdi></td>
                <td><span className="muted small">{KIND_LABEL[d.kind]}</span><br />{guarantee(d)}</td>
                <td>{formatDay(d.received_on)}{d.returned_on && <div className="muted small">پس داده شد {formatDay(d.returned_on)}</div>}</td>
                <td className="num">{fa(d.open_loans)}</td>
                <td><div className="row-actions">
                  {!d.returned_on && (
                    <button className="btn small ghost" onClick={() => lendTo({
                      kind: "deposit", id: d.id, card_no: d.code, name: d.name, father_name: d.father_name, phone: d.phone,
                      guarantee: guarantee(d), open_loans: d.open_loans, active: true,
                    })}>امانت دادن</button>
                  )}
                  {!d.returned_on && d.open_loans === 0 && <GiveBack onConfirm={() => void act(() => api.returnDeposit(d.id))} />}
                  {d.removable && d.open_loans === 0 && !d.returned_on && <RemoveButton onConfirm={() => void act(() => api.deleteDeposit(d.id))} />}
                </div></td>
              </tr>
            ))}
          </tbody>
        </table>
        {page && !page.rows.length && <p className="muted empty">{q ? "چیزی پیدا نشد." : "ضمانتی نزد ما نیست."}</p>}
        {!page && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
    </>
  );
}

/** Two clicks, like removing: the guarantee leaves the building. */
function GiveBack({ onConfirm }: { onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = window.setTimeout(() => setAsking(false), 4000);
    return () => window.clearTimeout(t);
  }, [asking]);
  return asking
    ? <button className="btn small" onClick={() => { setAsking(false); onConfirm(); }}>پس داده شد؟</button>
    : <button className="btn small ghost" onClick={() => setAsking(true)}>پس دادن ضمانت</button>;
}

function NewDeposit({ lendTo }: { lendTo: (b: Borrower) => void }) {
  const [kind, setKind] = useState<DepositKind>("cash");
  const [code, setCode] = useState("");
  // Left as suggested, the number is given by the core when saving (two desks never share one).
  const [codeTouched, setCodeTouched] = useState(false);
  const [name, setName] = useState("");
  const [father, setFather] = useState("");
  const [phone, setPhone] = useState("");
  const [cash, setCash] = useState("");
  const [books, setBooks] = useState("");
  const [guarantor, setGuarantor] = useState("");
  const [note, setNote] = useState("");
  const [day, setDay] = useState(iso(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (!codeTouched) api.nextDepositCode(kind).then(setCode).catch(() => setCode("")); }, [kind, codeTouched]);

  async function save() {
    setBusy(true);
    setError("");
    try {
      const r = await api.createDeposit({
        kind, code: codeTouched ? code : undefined, name, father_name: father, phone, note, received_on: day,
        ...(kind === "cash" ? { amount: amount(cash) } : kind === "book" ? { deposit_book: books } : { guarantor }),
      });
      const what = kind === "cash" ? `${fa(amount(cash))} افغانی` : kind === "book" ? books : `ضامن: ${guarantor}`;
      lendTo({ kind: "deposit", id: r.id, card_no: r.code, name, father_name: father || null, phone: phone || null, guarantee: what, open_loans: 0, active: true });
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  const ready = !!name.trim() && !!day && (kind === "cash" ? amount(cash) > 0 : kind === "book" ? !!books.trim() : !!guarantor.trim());
  return (
    <section className="panel wide">
      <h2>ضمانت جدید (کارت امانت)</h2>
      <p className="muted">کسی که عضو قرائت‌خانه نیست، اول ضمانت می‌گذارد. پول ضمانت درآمد نیست و هنگام پس دادن کارت برمی‌گردد.</p>
      <div className="segmented" role="tablist" aria-label="نوع ضمانت">
        {(["cash", "book", "person"] as const).map((k) => (
          <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? "on" : ""} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
        ))}
      </div>
      <div className="form-grid">
        <label className="field wide">
          <span>شمارهٔ کارت</span>
          <input dir="ltr" value={code} onChange={(e) => { setCodeTouched(true); setCode(e.target.value); }} />
          <small className="muted">شمارهٔ بعدی خودش آمده؛ برای کارت‌های کاغذی قدیمی شمارهٔ همان کارت را بنویسید.</small>
        </label>
        <label className="field wide"><span>نام و تخلص *</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
        <label className="field wide"><span>نام پدر</span><input value={father} onChange={(e) => setFather(e.target.value)} /></label>
        <label className="field wide"><span>شماره تماس</span><input dir="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></label>
        {kind === "cash" && <label className="field wide"><span>مبلغ ضمانت (افغانی) *</span><input dir="ltr" inputMode="numeric" value={cash} onChange={(e) => setCash(digits(e.target.value))} /></label>}
        {kind === "book" && <label className="field wide"><span>کتاب‌های ضمانت *</span><input value={books} onChange={(e) => setBooks(e.target.value)} placeholder="مثلاً: 3 جلد" /></label>}
        {kind === "person" && <label className="field wide"><span>ضامن *</span><input value={guarantor} onChange={(e) => setGuarantor(e.target.value)} placeholder="مثلاً: داکتر علی اکبر محمدی" /></label>}
        <SolarDate label="تاریخ" value={day} onChange={setDay} />
        <label className="field wide span-2"><span>ملاحظات</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="actions"><button className="btn big" disabled={!ready || busy} onClick={() => void save()}>ثبت و امانت دادن کتاب</button></div>
    </section>
  );
}
