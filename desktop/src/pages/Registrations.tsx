import { useEffect, useRef, useState } from "react";
import { api, errorText, type RegKind, type RegSummary, type Registration } from "../lib/api";
import { fa, formatDay } from "../lib/solar";
import { BillPreview } from "../components/BillSheet";
import { PeriodPicker, usePeriod, type Span } from "../components/PeriodPicker";

export type RegFilter = { span: Span; kind?: RegKind };
const KINDS: { id: RegKind | undefined; label: string }[] = [
  { id: undefined, label: "همه" },
  { id: "daily", label: "روزانه" },
  { id: "monthly", label: "ماهانه" },
  { id: "internet", label: "انترنت" },
];
const PAGE = 200;

export function kindLabel(r: Pick<Registration, "kind" | "first" | "record_only">) {
  if (r.kind === "daily") return "روزانه";
  if (r.kind === "internet") return "انترنت";
  return r.first ? "ماهانه، جدید" : "ماهانه، تمدید";
}

/** Who signed up, and when: daily seats, new and renewed monthly members, internet. */
export function Registrations({ initial, openMember }: { initial?: RegFilter; openMember: (id: string) => void }) {
  const period = usePeriod(initial?.span ?? "today");
  const { from, to, label: spanText } = period.range;
  const [kind, setKind] = useState<RegKind | undefined>(initial?.kind);
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<Registration[]>([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState<RegSummary | null>(null);
  const [error, setError] = useState("");
  const [bill, setBill] = useState<string | null>(null);
  // The filters a "more" answer belongs to: a late answer for older filters is dropped.
  const filters = useRef("");

  useEffect(() => {
    filters.current = JSON.stringify([from, to, kind, q]);
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.registrations({ from, to, kind, q, limit: PAGE }, ctl.signal)
        .then((p) => { setRows(p.rows); setTotal(p.total); setSummary(p.summary); setError(""); })
        .catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    }, q ? 250 : 0);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [from, to, kind, q]);

  async function more() {
    try {
      const asked = filters.current;
      const p = await api.registrations({ from, to, kind, q, limit: PAGE, offset: rows.length });
      if (asked === filters.current) setRows((r) => [...r, ...p.rows]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="page">
      <div className="list-tools">
        <PeriodPicker value={period.value} onChange={period.setValue} />
        <div className="segmented" role="tablist" aria-label="نوع">
          {KINDS.map((k) => (
            <button key={k.label} role="tab" aria-selected={kind === k.id} className={kind === k.id ? "on" : ""} onClick={() => setKind(k.id)}>{k.label}</button>
          ))}
        </div>
        <input className="search" type="search" placeholder="جستجو: نام، آیدی یا شماره تماس" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      {summary && (
        <section className="kpis reg-kpis">
          <Tile label="روزانه" n={summary.daily} on={kind === "daily"} onClick={() => setKind("daily")} />
          <Tile label="ماهانه، عضو جدید" n={summary.monthly_new} on={kind === "monthly"} onClick={() => setKind("monthly")} />
          <Tile label="ماهانه، تمدید" n={summary.monthly_renewed} on={kind === "monthly"} onClick={() => setKind("monthly")} />
          <Tile label="انترنت" n={summary.internet} on={kind === "internet"} onClick={() => setKind("internet")} />
        </section>
      )}
      <p className="muted small">
        {spanText}: {fa(total)} ثبت‌نام{summary ? ` · مجموع پول ${fa(summary.amount)} افغانی` : ""}.
        تاریخ هر ردیف روز بل آن است. دوره‌هایی که پولشان در اکسل گرفته شده، بل ندارند و با روز شروعشان آمده‌اند.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>تاریخ</th><th>نام</th><th>آیدی</th><th>نوع</th><th>دوره</th><th>مبلغ</th><th>بل</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{formatDay(r.day)}</td>
                <td>{r.member_id ? <button className="link" onClick={() => openMember(r.member_id!)}>{r.name}</button> : <>{r.name} <span className="muted small">(مهمان)</span></>}</td>
                <td>{r.member_no ? <bdi dir="ltr">{r.member_no}</bdi> : "—"}</td>
                <td><span className={`chip kind-${r.kind}${r.kind === "monthly" && r.first ? " new" : ""}`}>{kindLabel(r)}</span></td>
                <td>{r.start_date === r.end_date ? formatDay(r.start_date) : <>{formatDay(r.start_date)} تا {formatDay(r.end_date)}</>}</td>
                <td className="num">{r.record_only ? <span className="muted">اکسل</span> : fa(r.amount)}</td>
                <td>{r.receipt_no ? <button className="link" onClick={() => setBill(r.receipt_id)}><bdi dir="ltr">{r.receipt_no}</bdi></button> : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows.length && summary && <p className="muted empty">در این زمان ثبت‌نامی نیست.</p>}
      </div>
      {rows.length < total && <div className="actions"><button className="btn ghost" onClick={() => void more()}>بیشتر ({fa(total - rows.length)})</button></div>}
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
    </div>
  );
}

function Tile({ label, n, on, onClick }: { label: string; n: number; on: boolean; onClick: () => void }) {
  return (
    <button className={on ? "kpi glass reg-tile on" : "kpi glass reg-tile"} onClick={onClick}>
      <span className="muted">{label}</span>
      <strong>{fa(n)}</strong>
    </button>
  );
}
