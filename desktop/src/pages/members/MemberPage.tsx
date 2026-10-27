import { useEffect, useState } from "react";
import { api, errorText, type MemberDetail, type MemberInput, type PeriodInput, type Plan, type Timeline } from "../../lib/api";
import { daysBetween, fa, formatDay, iso, parseIso } from "../../lib/solar";
import { DaysLeft } from "../../components/DaysLeft";
import { PeriodForm } from "../../components/PeriodForm";
import { BillPreview } from "../../components/BillSheet";
import { RemoveButton } from "../../components/RemoveButton";
import { MemberCardPreview } from "../../components/MemberCard";
import { useDocumentUrl } from "../../lib/images";
import { Documents } from "./Documents";

const TIMELINE_LABEL: Record<Timeline["kind"], string> = { monthly: "عضویت سالن", internet: "انترنت" };
import { MemberFields } from "./MemberFields";

/** One member: details, every paid period, and renewing (which prints the bill). */
export function MemberPage({ id, onBack, openBill }: { id: string; onBack: () => void; openBill?: string | null }) {
  const [d, setD] = useState<MemberDetail | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"view" | "edit" | "renew" | "record">("view");
  const [bill, setBill] = useState<string | null>(openBill ?? null);
  const [card, setCard] = useState(false);
  const photoId = d?.documents.find((x) => x.kind === "photo")?.id ?? null;
  const { url: photo } = useDocumentUrl(photoId);

  const load = () => api.member(id).then((x) => { setD(x); setError(""); }).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); api.plans().then(setPlans).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  if (!d) return <div className="page">{error ? <p className="form-error">{error}</p> : <p className="muted">در حال بارگذاری…</p>}</div>;
  const m = d.member;
  const name = `${m.first_name} ${m.last_name ?? ""}`.trim();

  async function removePeriod(pid: string) {
    try { await api.deletePeriod(pid); await load(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost" onClick={onBack}>→ برگشت به اعضا</button>
      </div>

      <section className="panel wide member-head">
        <div className="member-title">
          {photo && <img className="member-photo" src={photo} alt="" />}
          <div>
            <h2>{name}</h2>
            <p className="muted">
              آیدی <bdi dir="ltr">{m.member_no}</bdi>
              {m.father_name && <> · فرزند {m.father_name}</>}
              {m.phone && <> · <bdi dir="ltr">{m.phone}</bdi></>}
              {m.field_of_study && <> · {m.field_of_study}</>}
            </p>
          </div>
          <div className="member-status">
            {d.timelines.filter((t) => t.end_date || t.kind === "monthly").map((t) => (
              <div key={t.kind}>
                <span className="muted small">{TIMELINE_LABEL[t.kind]}</span>
                <DaysLeft days={t.days_left} />
                {t.end_date && <span className="muted small">ختم {formatDay(t.end_date)}</span>}
              </div>
            ))}
          </div>
        </div>
        {mode === "view" && (
          <div className="actions">
            <button className="btn big" onClick={() => setMode("renew")}>تمدید عضویت</button>
            {!d.periods.length && <button className="btn ghost" onClick={() => setMode("record")}>ثبت تاریخ عضویت فعلی (پولش قبلاً گرفته شده)</button>}
            <button className="btn ghost" onClick={() => setMode("edit")}>ویرایش مشخصات</button>
            <button className="btn ghost" onClick={() => setCard(true)}>چاپ کارت عضویت</button>
          </div>
        )}
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}

      {mode === "edit" && <EditMember id={id} member={d} onDone={() => { setMode("view"); void load(); }} />}
      {(mode === "renew" || mode === "record") && (
        <AddPeriod id={id} detail={d} plans={plans} record={mode === "record"}
          onDone={(billId) => { setMode("view"); void load(); if (billId) setBill(billId); }}
          onCancel={() => setMode("view")} />
      )}

      <Documents memberId={id} docs={d.documents} onChange={() => void load()} />

      <section className="glass table-wrap">
        <table className="table">
          <thead><tr><th>نوع</th><th>از</th><th>تا</th><th>مبلغ</th><th>بل</th><th /></tr></thead>
          <tbody>
            {d.periods.map((p) => (
              <tr key={p.id}>
                <td>{p.plan_name}{p.note && <div className="muted small">{p.note}</div>}</td>
                <td>{formatDay(p.start_date)}</td>
                <td>{formatDay(p.end_date)}</td>
                <td className="num">{p.receipt_id ? fa(p.fee - p.discount) : "—"}</td>
                <td>{p.receipt_no ? <button className="link" onClick={() => setBill(p.receipt_id)}><bdi dir="ltr">{p.receipt_no}</bdi></button> : "—"}</td>
                <td>{p.removable && <RemoveButton onConfirm={() => void removePeriod(p.id)} />}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.periods.length && <p className="muted empty">هنوز هیچ دوره‌ای ثبت نشده. اگر این عضو از اکسل آمده، تاریخ عضویت فعلی‌اش را از دستگاه اثر انگشت ثبت کنید.</p>}
      </section>

      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
      {card && !bill && <MemberCardPreview member={m} photoId={photoId} onClose={() => setCard(false)} />}
    </div>
  );
}

function EditMember({ id, member, onDone }: { id: string; member: MemberDetail; onDone: () => void }) {
  const [m, setM] = useState<MemberInput>(member.member);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.updateMember(id, m); onDone(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <section className="panel wide">
      <h2>ویرایش مشخصات</h2>
      <MemberFields value={m} onChange={setM} />
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || !m.first_name.trim()} onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" onClick={onDone}>انصراف</button>
      </div>
    </section>
  );
}

function AddPeriod({ id, detail, plans, record, onDone, onCancel }: {
  id: string; detail: MemberDetail; plans: Plan[]; record: boolean;
  onDone: (billId: string | null) => void; onCancel: () => void;
}) {
  const [period, setPeriod] = useState<PeriodInput | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const today = iso(new Date());
  const start = (kind: Plan["kind"]) => (record ? today : detail.timelines.find((t) => t.kind === kind)?.next_start ?? today);
  const late = record ? [] : detail.timelines.filter((t) => t.end_date && daysBetween(parseIso(t.end_date), new Date()) > 0);
  // Still more than 5 days left of this kind: a second renewal is almost always a mistake
  // (a repeated click), so it needs a tick for "paying ahead".
  const kind = plans.find((p) => p.id === period?.plan_id)?.kind;
  const running = detail.timelines.find((t) => t.kind === kind && t.days_left !== null && t.days_left > 5);
  const [ahead, setAhead] = useState(false);

  async function save() {
    if (!period) return;
    setBusy(true);
    try {
      const r = await api.addPeriod(id, { ...period, ahead: !!running && ahead });
      onDone(r.receipt_id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="panel wide">
      <h2>{record ? "ثبت تاریخ عضویت فعلی" : "تمدید عضویت"}</h2>
      {record ? (
        <p className="muted">برای اعضایی که پول این ماه‌شان پیش از برنامه (در اکسل) گرفته شده. تاریخ شروع را از دستگاه اثر انگشت ببینید؛ تاریخ ختم خودکار حساب می‌شود و بل داده نمی‌شود.</p>
      ) : (
        <>
          <p className="muted">تمدید از فردای ختم دورهٔ قبلی همان نوع شروع می‌شود (سالن و انترنت هر کدام جدا).</p>
          {late.map((t) => (
            <p key={t.kind} className="notice warn">
              {TIMELINE_LABEL[t.kind]} {fa(daysBetween(parseIso(t.end_date!), new Date()))} روز پیش ختم شده. تمدیدش از {formatDay(t.next_start)} حساب می‌شود تا روزهای گذشته هم پرداخت شود.
            </p>
          ))}
        </>
      )}
      <PeriodForm plans={plans} start={start} kinds={["monthly", "internet"]} recordOnly={record} onChange={setPeriod} />
      {running && (
        <div className="notice warn">
          <p>این عضو هنوز تا {formatDay(running.end_date!)} ({fa(running.days_left!)} روز) {TIMELINE_LABEL[running.kind]} دارد. تمدید تازه از {formatDay(running.next_start)} شروع می‌شود.</p>
          <label className="check"><input type="checkbox" checked={ahead} onChange={(e) => setAhead(e.target.checked)} /> پیش‌پرداخت است؛ مطمئنم که ماه بعد را هم ثبت کنم.</label>
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button className="btn big" disabled={!period || busy || (!!running && !ahead)} onClick={() => void save()}>{busy ? "در حال ثبت…" : record ? "ثبت تاریخ" : "ثبت و بل"}</button>
        <button className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </section>
  );
}
