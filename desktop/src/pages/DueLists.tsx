import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errorText, type ListQuery, type LoanRow, type MemberRow, type OwedRow, type Page } from "../lib/api";
import { fa, formatDay, formatShort } from "../lib/solar";
import { DaysLeft } from "../components/DaysLeft";
import { BillPreview } from "../components/BillSheet";

const PAGE = 100;

/** Shared shell: two tabs (attention / everyone), a search box, a table and "show more". */
function DueList<T>(props: {
  tabs: [string, string];
  hint: [string, string];
  searchHint: string;
  load: (q: ListQuery, signal: AbortSignal) => Promise<Page<T>>;
  head: ReactNode;
  row: (r: T) => ReactNode;
  empty: string;
  action?: ReactNode;
}) {
  const [scope, setScope] = useState<"attention" | "all">("attention");
  const [q, setQ] = useState("");
  const [page, setPage] = useState<Page<T> | null>(null);
  const [error, setError] = useState("");
  const search = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const ctl = new AbortController();
    // Wait a moment while typing so every key press does not reload the list.
    const t = window.setTimeout(() => {
      props.load({ scope, q, limit: PAGE }, ctl.signal)
        .then((p) => { setPage(p); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, q]);

  async function more() {
    if (!page) return;
    const next = await props.load({ scope, q, limit: PAGE, offset: page.rows.length }, new AbortController().signal);
    setPage({ total: next.total, rows: [...page.rows, ...next.rows] });
  }

  return (
    <div className="page">
      <div className="list-tools">
        <div className="segmented" role="tablist">
          {(["attention", "all"] as const).map((s, i) => (
            <button key={s} role="tab" aria-selected={scope === s} className={scope === s ? "on" : ""} onClick={() => setScope(s)}>
              {props.tabs[i]}
            </button>
          ))}
        </div>
        <input ref={search} className="search" type="search" placeholder={props.searchHint} aria-label={props.searchHint} value={q} onChange={(e) => setQ(e.target.value)} />
        {props.action}
      </div>
      <p className="muted small">{props.hint[scope === "attention" ? 0 : 1]}{page ? ` · ${fa(page.total)} مورد` : ""}</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead>{props.head}</thead>
          <tbody>{page?.rows.map(props.row)}</tbody>
        </table>
        {page && !page.rows.length && <p className="muted empty">{q ? "چیزی پیدا نشد." : props.empty}</p>}
        {!page && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
      {page && page.rows.length < page.total && (
        <button className="btn ghost" onClick={() => void more()}>نمایش {fa(Math.min(PAGE, page.total - page.rows.length))} مورد دیگر</button>
      )}
    </div>
  );
}

export function MembersList({ open, add }: { open: (id: string) => void; add: () => void }) {
  const [bill, setBill] = useState<string | null>(null);
  const [owedView, setOwedView] = useState(false);
  const [owedCount, setOwedCount] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    api.owed({ scope: "all", q: "", limit: 1 }, ctl.signal).then((p) => setOwedCount(p.total)).catch(() => {});
    return () => ctl.abort();
  }, [owedView]);
  const toggle = (
    <button className={`btn ${owedView ? "" : "ghost"}`} aria-pressed={owedView} onClick={() => setOwedView((v) => !v)}>
      باقی‌ها{owedCount > 0 && <span className="owed-badge small-badge">{fa(owedCount)}</span>}
    </button>
  );
  if (owedView) return <OwedList open={open} action={toggle} />;
  return (
    <>
      <DueList<MemberRow>
        action={<>{toggle}<button className="btn" onClick={add}>+ عضو جدید</button></>}
        tabs={["نزدیک به ختم و تمام‌شده", "همه اعضا"]}
        hint={[
          "عضویت‌هایی که تا 5 روز دیگر ختم می‌شوند یا در 30 روز گذشته ختم شده‌اند؛ کمترین روز مانده اول.",
          "همهٔ اعضا و مهمان‌های روزانه؛ تازه‌ترین ثبت‌نام اول. اعضای اکسل که هنوز تاریخ ندارند در آخر می‌آیند.",
        ]}
        searchHint="جستجو: نام، نام پدر، شماره تماس یا شمارهٔ عضویت"
        load={(q, signal) => api.members({ ...q, guests: true }, signal)}
        empty="عضویتی نزدیک به ختم نیست."
        head={<tr><th>شماره</th><th>نام</th><th>نام پدر</th><th>شماره تماس</th><th>نوع عضویت</th><th>آخرین ثبت</th><th>ختم عضویت</th><th>وضعیت</th></tr>}
        row={(m) => {
          const go = m.member_id ? () => open(m.member_id!) : m.receipt_id ? () => setBill(m.receipt_id) : undefined;
          return (
            <tr key={m.member_id ?? `guest-${m.receipt_id ?? m.name}-${m.last_start}`}
              className={`${go ? "clickable" : ""}${m.days_left !== null && m.days_left < 0 && m.member_id ? " late" : ""}`} onClick={go}
              tabIndex={go ? 0 : undefined} onKeyDown={go ? (e) => { if (e.key === "Enter") go(); } : undefined}>
              <td className="num">{m.member_no ?? <span className="chip kind-daily">مهمان</span>}</td>
              <td><strong>{m.name}</strong>{m.owed > 0 && <> <span className="owed-badge small-badge">باقی {fa(m.owed)}</span></>}</td>
              <td>{m.father_name ?? "—"}</td>
              <td><bdi dir="ltr">{m.phone ?? "—"}</bdi></td>
              <td className="muted">{m.plan_name ?? "—"}</td>
              <td>{m.last_start ? formatShort(m.last_start) : "—"}</td>
              <td>{m.end_date ? formatShort(m.end_date) : "—"}</td>
              <td>{m.member_id ? <DaysLeft days={m.days_left} /> : m.days_left !== null && m.days_left >= 0 ? <span className="days ok">امروز</span> : <span className="days none">گذشته</span>}</td>
            </tr>
          );
        }}
      />
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
    </>
  );
}

/** Periods paid in parts whose rest is still owed. */
function OwedList({ open, action }: { open: (id: string) => void; action: ReactNode }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState<(Page<OwedRow> & { sum: number }) | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.owed({ scope: "all", q, limit: 500 }, ctl.signal).then((p) => { setPage(p); setError(""); }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q]);
  const sum = page?.sum ?? 0;
  return (
    <div className="page">
      <div className="list-tools">
        <input className="search" type="search" placeholder="جستجو: نام، شماره تماس یا آیدی" aria-label="جستجو: نام، شماره تماس یا آیدی" value={q} onChange={(e) => setQ(e.target.value)} />
        {action}
      </div>
      <p className="muted small">
        عضوهایی که بخشی از پول دوره‌شان را داده‌اند. در دستگاه انگشت باز هستند. برای گرفتن باقی، روی عضو بزنید و «پرداخت باقی» را بزنید.
        {page ? ` · ${fa(page.total)} نفر · جمع باقی ${fa(sum)} افغانی` : ""}
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>آیدی</th><th>نام</th><th>شماره تماس</th><th>دوره</th><th className="num">مبلغ</th><th className="num">پرداخت‌شده</th><th className="num">باقی</th><th>بل</th></tr></thead>
          <tbody>
            {page?.rows.map((r) => {
              const go = r.member_id ? () => open(r.member_id!) : undefined;
              return (
                <tr key={r.membership_id} className={go ? "clickable" : ""} onClick={go} tabIndex={go ? 0 : undefined}
                  onKeyDown={go ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } } : undefined}>
                  <td className="num">{r.member_no ?? "—"}</td>
                  <td><strong>{r.name}</strong></td>
                  <td><bdi dir="ltr">{r.phone ?? "—"}</bdi></td>
                  <td>{r.plan_name}<div className="muted small">{formatDay(r.start_date)} تا {formatDay(r.end_date)}</div></td>
                  <td className="num">{fa(r.due)}</td>
                  <td className="num">{fa(r.paid)}</td>
                  <td className="num owed">{fa(r.owed)}</td>
                  <td>{r.receipt_no ? <bdi dir="ltr">{r.receipt_no}</bdi> : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {page && !page.rows.length && <p className="muted empty">{q ? "چیزی پیدا نشد." : "هیچ کسی باقی ندارد."}</p>}
        {!page && !error && <p className="muted empty">در حال بارگذاری…</p>}
      </div>
      {page && page.rows.length < page.total && <p className="muted small">فقط {fa(page.rows.length)} دورهٔ قدیمی‌تر نشان داده شده؛ برای بقیه جستجو کنید.</p>}
    </div>
  );
}

export function LoansList({ open, action }: { open: (id: string) => void; action?: ReactNode }) {
  return (
    <DueList<LoanRow>
      action={action}
      tabs={["نزدیک به موعد و دیرکرده", "همه امانت‌های باز"]}
      hint={["کتاب‌هایی که تا 2 روز دیگر باید برگردند یا از موعد گذشته‌اند؛ دیرکرده‌ترین اول.", "همهٔ کتاب‌هایی که الان امانت است."]}
      searchHint="جستجو: نام کتاب، نام، شماره تماس، آیدی یا کارت امانت"
      load={api.loans}
      empty="هیچ کتابی نزدیک به موعد یا دیرکرده نیست."
      head={<tr><th>کتاب</th><th>امانت‌گیرنده</th><th>آیدی / کارت</th><th>شماره تماس</th><th>تاریخ امانت</th><th>موعد برگشت</th><th>وضعیت</th></tr>}
      row={(l) => (
        <tr key={l.loan_id} className={`clickable${l.days_left < 0 ? " late" : ""}`} onClick={() => open(l.loan_id)}
          tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") open(l.loan_id); }}>
          <td><strong>{l.book_title}</strong></td>
          <td>{l.member_name}</td>
          <td className="num"><bdi dir="ltr">{l.card_no}</bdi></td>
          <td><bdi dir="ltr">{l.phone ?? "—"}</bdi></td>
          <td>{formatShort(l.loaned_on)}</td>
          <td>{formatShort(l.due_on)}</td>
          <td><DaysLeft days={l.days_left} soon={2} /></td>
        </tr>
      )}
    />
  );
}
