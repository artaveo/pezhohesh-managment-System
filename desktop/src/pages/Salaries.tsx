import { useEffect, useState } from "react";
import { api, errorText, type SalaryInput, type SalaryPage, type SalaryPerson } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { MONTHS, fa, formatDay, fromSolar, iso, toSolar } from "../lib/solar";
import { PeriodPicker, usePeriod } from "../components/PeriodPicker";
import { AmountInput } from "../components/AmountInput";
import { SolarDate } from "../components/SolarDate";
import { Icon } from "../components/Icon";

/** Positive: the person is owed money; negative: they took more than their salary so far. */
function Balance({ v }: { v: number }) {
  if (Math.abs(v) < 0.5) return <span className="status on">تسویه</span>;
  return v > 0
    ? <span className="status wait">طلب دارد {fa(v)} ؋</span>
    : <span className="status info">پیش‌پرداخت {fa(-v)} ؋</span>;
}

/** A signed balance in a table cell: owed reads as plain, paid ahead in the warning colour. */
const Signed = ({ v }: { v: number }) => <span className={v < -0.5 ? "ahead" : ""}><bdi dir="ltr">{fa(v)}</bdi></span>;

/**
 * Staff salaries (the admin manager, Shams...), on the withdrawals page: a row per person
 * with where their account stands; a row opens that person's account, month by month and
 * payment by payment, over any period. The fixed salary is only compared with what was
 * paid; the payments are the real expenses.
 */
export function StaffAccounts() {
  const { user } = useAuth();
  const partner = user?.role === "partner";
  const period = usePeriod("year");
  const [page, setPage] = useState<SalaryPage | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);
  const { from, to } = period.range;

  useEffect(() => {
    const ctl = new AbortController();
    api.salaries({ from, to }, ctl.signal).then((p) => { setPage(p); setError(""); }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [from, to, tick]);

  const done = (msg: string) => { setNotice(msg); setAdding(false); setTick((t) => t + 1); };
  const show = (id: string | null) => { setOpen(id); setNotice(""); setAdding(false); };
  const person = page?.people.find((p) => p.id === open);

  if (person && page) {
    return (
      <>
        <div className="detail-head">
          <button className="btn ghost small" onClick={() => show(null)}><Icon name="back" size={16} /> همهٔ کارمندان</button>
          <h2>{person.title ?? person.full_name}</h2>
        </div>
        <PersonPage p={person} page={page} partner={partner} period={period} notice={notice} onDone={done} />
      </>
    );
  }

  // Active people first; someone who left stays at the end.
  const people = [...(page?.people ?? [])].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <>
      <div className="page-head">
        <p className="muted">معاش ثابت فقط برای مقایسه است. پولی که کارمند می‌گیرد در «مصارف» زیر سطر خودش ثبت می‌شود و هزینهٔ واقعی همان است.</p>
        {partner && !adding && <button className="btn ghost" onClick={() => { setAdding(true); setNotice(""); }}>+ کارمند تازه</button>}
      </div>
      {adding && page && <SalaryForm person={null} categories={page.categories} onDone={done} onCancel={() => setAdding(false)} />}
      {notice && <p className="glass notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {page && !people.length && (
        <p className="glass muted empty">
          هنوز کارمندی با معاش ثبت نشده. {partner ? "با «+ کارمند تازه» مدیر اداری، مدیر ارتباطات و شمس را با معاش ماهانه‌شان اضافه کنید." : "یکی از شرکا باید کارمندان را اضافه کند."}
        </p>
      )}
      {people.length > 0 && (
        <div className="glass table-wrap">
          <table className="table">
            <thead>
              <tr><th>کار</th><th>نام</th><th className="num">معاش ماهانه</th><th>آخرین پرداخت</th><th>تا امروز</th><th><span className="sr-only">باز کردن</span></th></tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id} className={`row-link${p.active ? "" : " inactive"}`} onClick={() => show(p.id)}>
                  <th scope="row"><button className="link" onClick={(e) => { e.stopPropagation(); show(p.id); }}>{p.title ?? p.full_name}</button></th>
                  <td>{p.full_name}{!p.active && <span className="muted small"> · غیرفعال</span>}</td>
                  <td className="num">{p.monthly_salary > 0 ? fa(p.monthly_salary) : "—"}</td>
                  <td>{p.last_paid ? formatDay(p.last_paid) : "—"}</td>
                  <td><Balance v={p.balance} /></td>
                  <td className="muted" aria-hidden="true"><span className="flip"><Icon name="back" size={16} /></span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

type Period = ReturnType<typeof usePeriod>;

function PersonPage({ p, page, partner, period, notice, onDone }: {
  p: SalaryPerson; page: SalaryPage; partner: boolean; period: Period; notice: string; onDone: (msg: string) => void;
}) {
  const [mode, setMode] = useState<"edit" | "pay" | null>(null);
  const start = p.salary_from ? toSolar(p.salary_from) : null;
  const accrued = p.months.reduce((t, m) => t + m.accrued, 0);
  const taken = p.months.reduce((t, m) => t + m.taken, 0);
  const closing = p.opening + accrued - taken;
  const years = new Set(p.months.map((m) => m.year));
  let running = p.opening;

  return (
    <>
      <div className="page-head">
        <span />
        <div className="actions">
          {p.category_id && <button className="btn" onClick={() => setMode(mode === "pay" ? null : "pay")}>+ پرداخت به {p.full_name}</button>}
          {partner && <button className="btn ghost" onClick={() => setMode(mode === "edit" ? null : "edit")}>ویرایش معاش</button>}
        </div>
      </div>
      <section className="glass salary-head">
        <div>
          <h2>{p.full_name}{p.title && <span className="muted small"> · {p.title}</span>}</h2>
          <p className="muted small">
            {p.monthly_salary > 0 && p.category && start
              ? `معاش ماهانه ${fa(p.monthly_salary)} افغانی · سطر «${p.category}» · از ${MONTHS[start.m - 1]} ${start.y}`
              : "معاش ثابت ندارد."}
            {!p.active && " · غیرفعال"}
          </p>
        </div>
        <div className="salary-balance"><span className="muted small">تا امروز</span><Balance v={p.balance} /></div>
      </section>
      {mode === "edit" && <SalaryForm person={p} categories={page.categories} onDone={(m) => { setMode(null); onDone(m); }} onCancel={() => setMode(null)} />}
      {mode === "pay" && <PayForm p={p} onDone={(m) => { setMode(null); onDone(m); }} onCancel={() => setMode(null)} />}
      {notice && <p className="glass notice" role="status">{notice}</p>}

      <PeriodPicker value={period.value} onChange={period.setValue} spans={["month", "year", "all", "range"]} />

      <section className="kpis four">
        <Figure label={`مانده از قبل از ${period.range.label}`} v={p.opening} />
        <div className="glass kpi"><span className="kpi-label">معاش {period.range.label}</span><span className="kpi-value">{fa(accrued)} <small>؋</small></span></div>
        <div className="glass kpi"><span className="kpi-label">پرداخت {period.range.label}</span><span className="kpi-value">{fa(taken)} <small>؋</small></span></div>
        <Figure label={`مانده در آخر ${period.range.label}`} v={closing} />
      </section>

      <section className="glass">
        <div className="panel-head"><h2>ماه به ماه</h2><span className="muted small">مانده = معاش منهای پرداخت، از اول حساب</span></div>
        <div className="table-wrap flush">
          <table className="table">
            <thead><tr><th>ماه</th><th className="num">معاش</th><th className="num">پرداخت</th><th className="num">مانده</th>{partner && <th />}</tr></thead>
            <tbody>
              {p.opening !== 0 && (
                <tr className="section"><th scope="row">مانده از قبل</th><td /><td /><td className="num"><Signed v={p.opening} /></td>{partner && <td />}</tr>
              )}
              {p.months.map((m) => {
                running += m.accrued - m.taken;
                return <MonthRow key={`${m.year}-${m.month}`} p={p} m={m} running={running} showYear={years.size > 1} partner={partner} onDone={onDone} />;
              })}
              {!p.months.length && <tr><td colSpan={partner ? 5 : 4} className="muted">در این دوره معاشی نیست.</td></tr>}
            </tbody>
            {p.months.length > 0 && (
              <tfoot><tr><th scope="row">جمع</th><td className="num">{fa(accrued)}</td><td className="num">{fa(taken)}</td><td className="num"><Signed v={closing} /></td>{partner && <td />}</tr></tfoot>
            )}
          </table>
        </div>
      </section>

      <section className="glass">
        <div className="panel-head"><h2>ریز پرداخت‌ها</h2><span className="muted small">{fa(p.payments.length)} پرداخت در {period.range.label}</span></div>
        <div className="table-wrap flush">
          <table className="table">
            <thead><tr><th>تاریخ</th><th>شرح</th><th>از کجا</th><th className="num">مبلغ</th></tr></thead>
            <tbody>
              {p.payments.map((x) => (
                <tr key={x.id}>
                  <td>{formatDay(x.day)}</td>
                  <td>{x.note ?? "—"}</td>
                  <td>{x.source === "expense" ? `مصارف · ${p.category ?? ""}` : "برداشت"}</td>
                  <td className="num">{fa(x.amount)}</td>
                </tr>
              ))}
              {!p.payments.length && <tr><td colSpan={4} className="muted">در این دوره پرداختی نیست.</td></tr>}
            </tbody>
            {p.payments.length > 0 && <tfoot><tr><th scope="row" colSpan={3}>جمع</th><td className="num">{fa(p.payments.reduce((t, x) => t + x.amount, 0))}</td></tr></tfoot>}
          </table>
        </div>
      </section>
    </>
  );
}

function Figure({ label, v }: { label: string; v: number }) {
  return (
    <div className="glass kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value"><Balance v={v} /></span>
    </div>
  );
}

/** One month of the account; a partner can correct the salary noted for it. */
function MonthRow({ p, m, running, showYear, partner, onDone }: {
  p: SalaryPerson; m: SalaryPerson["months"][number]; running: number; showYear: boolean; partner: boolean; onDone: (msg: string) => void;
}) {
  const [edit, setEdit] = useState<string | null>(null);
  const [error, setError] = useState("");
  const name = `${MONTHS[m.month - 1]}${showYear ? ` ${m.year}` : ""}`;
  async function save() {
    try {
      await api.setSalaryMonth(p.id, { year: m.year, month: m.month, amount: Number(edit || 0) });
      setEdit(null);
      onDone(`معاش ${name} ${p.full_name} ${fa(Number(edit || 0))} افغانی شد.`);
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <tr>
      <th scope="row">{name}</th>
      <td className="num">
        {edit === null ? fa(m.accrued) : (
          <span className="inline-edit">
            <input dir="ltr" inputMode="numeric" aria-label={`معاش ${name}`} value={edit} autoFocus
              onChange={(e) => setEdit(e.target.value.replace(/[^\d.]/g, ""))}
              onKeyDown={(e) => { if (e.key === "Enter") void save(); if (e.key === "Escape") setEdit(null); }} />
            {error && <small className="form-error" role="alert">{error}</small>}
          </span>
        )}
      </td>
      <td className="num">{fa(m.taken)}</td>
      <td className="num"><Signed v={running} /></td>
      {partner && (
        <td>
          {edit === null
            ? <button className="btn ghost small" onClick={() => setEdit(String(m.accrued))}>اصلاح معاش</button>
            : <span className="actions"><button className="btn small" onClick={() => void save()}>ذخیره</button><button className="btn ghost small" onClick={() => setEdit(null)}>انصراف</button></span>}
        </td>
      )}
    </tr>
  );
}

/** Money given to the person: an expense line under their statement line, as in the Excel book. */
function PayForm({ p, onDone, onCancel }: { p: SalaryPerson; onDone: (msg: string) => void; onCancel: () => void }) {
  const [day, setDay] = useState(iso(new Date()));
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    if (!(Number(amount) > 0)) return setError("مبلغ را بنویسید.");
    if (!day) return setError("تاریخ درست نیست.");
    setBusy(true);
    setError("");
    try {
      await api.createExpense({ category_id: p.category_id!, spent_on: day, amount: Number(amount), description: note.trim() || `پرداخت به ${p.full_name}` });
      onDone(`${fa(Number(amount))} افغانی به ${p.full_name} زیر سطر «${p.category}» ثبت شد.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="panel wide">
      <h2>پرداخت به {p.full_name}</h2>
      <p className="muted small">در «مصارف» زیر سطر «{p.category}» ثبت می‌شود.</p>
      <div className="form-grid">
        <AmountInput label="مبلغ (افغانی)" value={amount} onChange={setAmount} required autoFocus />
        <SolarDate label="تاریخ" value={day} onChange={setDay} />
        <label className="field wide span-2"><span>شرح</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder={`پرداخت به ${p.full_name}`} /></label>
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>ثبت پرداخت</button>
        <button className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </section>
  );
}

/** The statement line a title most likely belongs to, as in the Excel book. */
function guessLine(title: string, cats: { id: string; name: string }[]) {
  const want = /ارتباط/.test(title) ? "اجوره مدیر ارتباطات" : /کانتین|شمس/.test(title) ? "اجوره کانتیندار" : "اجوره مدیر اداری";
  return cats.find((c) => c.name === want)?.id ?? cats[0]?.id ?? "";
}

/** Month and year of a Solar month, as two fields. */
function MonthYear({ label, month, year, onMonth, onYear }: { label: string; month: number; year: string; onMonth: (m: number) => void; onYear: (y: string) => void }) {
  return (
    <div className="field wide">
      <span>{label}</span>
      <div className="solar-date month-year" dir="rtl">
        <select aria-label="ماه" value={month} onChange={(e) => onMonth(Number(e.target.value))}>
          {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
        </select>
        <input aria-label="سال" inputMode="numeric" value={year} onChange={(e) => onYear(e.target.value.replace(/\D/g, "").slice(0, 4))} />
      </div>
    </div>
  );
}

function SalaryForm({ person, categories, onDone, onCancel }: {
  person: SalaryPerson | null;
  categories: { id: string; name: string }[];
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const now = toSolar(new Date());
  // A new person starts with the year (the book begins on 1 Hamal).
  const from = person?.salary_from ? toSolar(person.salary_from) : { y: now.y, m: 1, d: 1 };
  const [name, setName] = useState(person?.full_name ?? "");
  const [title, setTitle] = useState(person?.title ?? "");
  const [salary, setSalary] = useState(person?.monthly_salary ? String(person.monthly_salary) : "");
  const [cat, setCat] = useState(person?.category_id ?? guessLine(person?.title ?? "", categories));
  const [month, setMonth] = useState(from.m);
  const [year, setYear] = useState(String(from.y));
  const [changeMonth, setChangeMonth] = useState(now.m);
  const [changeYear, setChangeYear] = useState(String(now.y));
  const [active, setActive] = useState(person?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = fromSolar({ y: Number(year), m: month, d: 1 });
  const changeFrom = fromSolar({ y: Number(changeYear), m: changeMonth, d: 1 });
  const changed = !!person && Number(salary || 0) !== person.monthly_salary;

  async function save() {
    if (!name.trim()) return setError("نام را بنویسید.");
    if (!(Number(salary) >= 0) || salary === "") return setError("معاش ماهانه را بنویسید.");
    if (!start || (changed && !changeFrom)) return setError("ماه و سال درست نیست.");
    setBusy(true);
    setError("");
    const body: SalaryInput = {
      full_name: name, title, monthly_salary: Number(salary), category_id: cat, from: iso(start), active,
      ...(changed && changeFrom ? { amount_from: iso(changeFrom) } : {}),
    };
    try {
      if (person) await api.updateSalary(person.id, body);
      else await api.createSalary(body);
      onDone(person
        ? changed ? `معاش ${name} از ${MONTHS[changeMonth - 1]} ${changeYear} ${fa(Number(salary))} افغانی شد؛ ماه‌های قبل همان معاش قبلی را دارند.` : `${name} به‌روز شد.`
        : `${name} اضافه شد. معاش از ${MONTHS[month - 1]} ${year} با پول‌های سطر خودش مقایسه می‌شود.`);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wide">
      <h2>{person ? `ویرایش ${person.full_name}` : "کارمند تازه"}</h2>
      <div className="form-grid">
        <label className="field wide"><span>نام کامل *</span><input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!person} /></label>
        <label className="field wide">
          <span>کار</span>
          <input value={title} placeholder="مثلاً: مدیر اداری، مدیر ارتباطات، کانتین" onChange={(e) => { setTitle(e.target.value); if (!person) setCat(guessLine(e.target.value, categories)); }} />
        </label>
        <AmountInput label="معاش ماهانه (افغانی)" value={salary} onChange={setSalary} required />
        <label className="field wide">
          <span>در کدام سطر مصارف</span>
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <MonthYear label="معاش از کدام ماه حساب شود" month={month} year={year} onMonth={setMonth} onYear={setYear} />
        {changed && <MonthYear label="معاش تازه از کدام ماه" month={changeMonth} year={changeYear} onMonth={setChangeMonth} onYear={setChangeYear} />}
        {person && (
          <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> هنوز کار می‌کند (معاش ماه‌های بعد حساب شود)</label>
        )}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </section>
  );
}
