import { useEffect, useState } from "react";
import { api, errorText, type SalaryInput, type SalaryPage, type SalaryPerson } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { MONTHS, fa, fromSolar, iso, toSolar } from "../lib/solar";

/** Positive: the person is owed money; negative: they took more than their salary so far. */
function Balance({ v }: { v: number }) {
  if (Math.abs(v) < 0.5) return <span className="status on">تسویه</span>;
  return v > 0
    ? <span className="status wait">طلب دارد {fa(v)} افغانی</span>
    : <span className="status off">پیش‌پرداخت {fa(-v)} افغانی</span>;
}

/**
 * Salaries of the staff (manager, Shams...): the fixed salary goes to each month's expenses by
 * itself; what they take is a withdrawal; each month shows what is left.
 */
export function Salaries() {
  const { user } = useAuth();
  const partner = user?.role === "partner";
  const [year, setYear] = useState<number | undefined>(undefined);
  const [page, setPage] = useState<SalaryPage | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SalaryPerson | "new" | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const ctl = new AbortController();
    api.salaries(year, ctl.signal).then((p) => { setPage(p); setError(""); }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [year, tick]);

  const y = page?.year;
  const current = toSolar(new Date()).y;
  return (
    <div className="page">
      <div className="page-head">
        <p className="muted">
          معاش ثابت هر نفر، اول هر ماه خودش در «مصارف» همان ماه ثبت می‌شود (زیر سطری که برایش انتخاب شده)، پس سود ماه و سهم شرکا درست می‌ماند.
          پولی که کارمند از صندوق می‌گیرد را در «مصارف و برداشت‌ها ← برداشت‌ها» به نام خودش ثبت کنید.
        </p>
        {partner && !editing && <button className="btn" onClick={() => { setEditing("new"); setNotice(""); }}>+ کارمند تازه</button>}
      </div>
      {editing && page && (
        <SalaryForm person={editing === "new" ? null : editing} categories={page.categories}
          onDone={(msg) => { setEditing(null); setNotice(msg); setTick((t) => t + 1); }} onCancel={() => setEditing(null)} />
      )}
      {notice && <p className="glass notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {y && (
        <div className="period-step">
          <button className="btn ghost small" onClick={() => setYear(y - 1)}>‹ سال قبل</button>
          <strong>سال {y}</strong>
          <button className="btn ghost small" disabled={y >= current} onClick={() => setYear(y + 1)}>سال بعد ›</button>
        </div>
      )}
      {page && !page.people.length && (
        <p className="glass muted empty">
          هنوز کارمندی با معاش ثبت نشده. {partner ? "با «+ کارمند تازه» مدیر اداری، مدیر ارتباطات و شمس را با معاش ماهانه‌شان اضافه کنید." : "یکی از شرکا باید کارمندان را اضافه کند."}
        </p>
      )}
      {page?.people.map((p) => (
        <PersonCard key={p.id} p={p} page={page} onEdit={partner ? () => { setEditing(p); setNotice(""); } : undefined} />
      ))}
    </div>
  );
}

function PersonCard({ p, page, onEdit }: { p: SalaryPerson; page: SalaryPage; onEdit?: () => void }) {
  const last = page.this_month ?? 12;
  let running = p.before;
  const start = p.salary_from ? toSolar(p.salary_from) : null;
  return (
    <section className={`panel wide${p.active ? "" : " inactive"}`}>
      <div className="salary-head">
        <div>
          <h2>{p.full_name}{p.title && <span className="muted small"> · {p.title}</span>}</h2>
          <p className="muted small">
            {p.monthly_salary > 0 && p.category && start
              ? `معاش ماهانه ${fa(p.monthly_salary)} افغانی · سطر «${p.category}» · از ${MONTHS[start.m - 1]} ${start.y}`
              : "معاش ثابت ندارد."}
            {!p.active && " · غیرفعال"}
          </p>
        </div>
        <div className="salary-balance">
          <span className="muted small">تا امروز</span>
          <Balance v={p.balance} />
          {onEdit && <button className="btn ghost small" onClick={onEdit}>ویرایش</button>}
        </div>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>ماه</th><th>معاش</th><th>گرفته</th><th>ماندهٔ همین ماه</th><th>ماندهٔ کل تا آخر ماه</th></tr></thead>
          <tbody>
            {p.months.slice(0, last).map((m, i) => {
              running += m.accrued - m.taken;
              if (!m.accrued && !m.taken && Math.abs(running) < 0.5) return null;
              return (
                <tr key={i}>
                  <td>{MONTHS[i]}</td>
                  <td className="num">{fa(m.accrued)}</td>
                  <td className="num">{fa(m.taken)}</td>
                  <td className="num"><bdi dir="ltr">{fa(m.accrued - m.taken)}</bdi></td>
                  <td><Balance v={running} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** The statement line a title most likely belongs to, as in the Excel book. */
function guessLine(title: string, cats: { id: string; name: string }[]) {
  const want = /ارتباط/.test(title) ? "اجوره مدیر ارتباطات" : /کانتین|شمس/.test(title) ? "اجوره کانتیندار" : "اجوره مدیر اداری";
  return cats.find((c) => c.name === want)?.id ?? cats[0]?.id ?? "";
}

function SalaryForm({ person, categories, onDone, onCancel }: {
  person: SalaryPerson | null;
  categories: { id: string; name: string }[];
  onDone: (msg: string) => void;
  onCancel: () => void;
}) {
  const now = toSolar(new Date());
  const from = person?.salary_from ? toSolar(person.salary_from) : now;
  const [name, setName] = useState(person?.full_name ?? "");
  const [title, setTitle] = useState(person?.title ?? "");
  const [salary, setSalary] = useState(person?.monthly_salary ? String(person.monthly_salary) : "");
  const [cat, setCat] = useState(person?.category_id ?? guessLine(person?.title ?? "", categories));
  const [month, setMonth] = useState(from.m);
  const [year, setYear] = useState(String(from.y));
  const [active, setActive] = useState(person?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const start = fromSolar({ y: Number(year), m: month, d: 1 });
  const earlier = start && (Number(year) < now.y || (Number(year) === now.y && month < now.m));

  async function save() {
    if (!start) return;
    setBusy(true);
    setError("");
    const body: SalaryInput = { full_name: name, title, monthly_salary: Number(salary || 0), category_id: cat, from: iso(start), active };
    try {
      if (person) await api.updateSalary(person.id, body);
      else await api.createSalary(body);
      onDone(person ? `معاش ${name} به‌روز شد.` : `${name} اضافه شد. معاش ${MONTHS[month - 1]} ${year} تا امروز در مصارف ثبت شد.`);
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
        <label className="field wide"><span>معاش ماهانه (افغانی) *</span><input dir="ltr" inputMode="numeric" value={salary} onChange={(e) => setSalary(e.target.value.replace(/[^\d.]/g, ""))} /></label>
        <label className="field wide">
          <span>در کدام سطر مصارف</span>
          <select value={cat} onChange={(e) => setCat(e.target.value)}>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <div className="field wide">
          <span>معاش از کدام ماه حساب شود</span>
          <div className="solar-date month-year" dir="rtl">
            <select aria-label="ماه" value={month} onChange={(e) => setMonth(Number(e.target.value))}>
              {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
            </select>
            <input aria-label="سال" inputMode="numeric" value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, "").slice(0, 4))} />
          </div>
        </div>
        {person && (
          <label className="check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> هنوز کار می‌کند (معاش ماه‌های بعد ثبت شود)</label>
        )}
      </div>
      {earlier && (
        <p className="form-error inline">
          ماه‌های قبل از این ماه هم ثبت می‌شوند. اگر معاش آن ماه‌ها از اکسل در مصارف آمده، شروع را همین ماه بگذارید تا دو بار حساب نشود.
        </p>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || !name.trim() || !(Number(salary) >= 0) || !cat || !start} onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </section>
  );
}
