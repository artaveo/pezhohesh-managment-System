import { useEffect, useState } from "react";
import { api, errorText, type MemberK50, type MemberDetail, type MemberInput, type Period, type PeriodInput, type Plan, type Timeline } from "../../lib/api";
import { daysBetween, fa, formatDay, iso, MONTHS, parseIso, toSolar } from "../../lib/solar";
import { amount, decimal } from "../../lib/numbers";
import { DaysLeft } from "../../components/DaysLeft";
import { PeriodForm } from "../../components/PeriodForm";
import { BillPreview } from "../../components/BillSheet";
import { DeleteDialog } from "../../components/DeleteDialog";
import { Modal } from "../../components/Modal";
import { ImageViewer } from "../../components/ImageViewer";
import { SolarDate } from "../../components/SolarDate";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";
import { useAuth } from "../../auth/AuthProvider";
import { MemberCardPreview } from "../../components/MemberCard";
import { useDocumentUrl } from "../../lib/images";
import { Documents } from "./Documents";
import { DebtItems } from "../Debts";
import { Enroll, Fingerprint } from "./Fingerprint";

import { MemberFields } from "./MemberFields";
import { NumberHelp } from "./NumberHelp";

const TIMELINE_LABEL: Record<Timeline["kind"], string> = { monthly: "عضویت سالن", internet: "انترنت" };

/** One member: details, every paid period, and renewing (which prints the bill). */
export function MemberPage({ id, openBill, fresh, onRemoved, debts, openDebts }: {
  id: string; onBack?: () => void; onRemoved?: () => void; openBill?: string | null; fresh?: boolean;
  /** Only the member's head and their debts («باقی‌ها»), each payable on its own. */
  debts?: boolean;
  openDebts?: () => void;
}) {
  const toast = useToast();
  const partner = useAuth().user?.role === "partner";
  const [removing, setRemoving] = useState<"member" | Period | null>(null);
  // Removing a member lets their number go by default: off the fingerprint device, fingers too.
  const [freeNo, setFreeNo] = useState(true);
  const [dates, setDates] = useState<Period | null>(null);
  const [cell, setCell] = useState<{ kind: string; year: number; month: number; amount: number } | null>(null);
  const [paying, setPaying] = useState<Period | null>(null);
  const [d, setD] = useState<MemberDetail | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"view" | "edit" | "renew" | "record">("view");
  const [bill, setBill] = useState<string | null>(openBill ?? null);
  const [card, setCard] = useState(false);
  // The fingerprint device, as the panel below last read it (null: no device set up).
  const [k50, setK50] = useState<MemberK50 | null>(null);
  const [enrolling, setEnrolling] = useState(false);
  const [fingerDone, setFingerDone] = useState(0);
  // Right after registering: the next steps at the desk, until the person closes them.
  const [steps, setSteps] = useState(!!fresh);
  const [photoOpen, setPhotoOpen] = useState(false);
  const photoId = d?.documents.find((x) => x.kind === "photo")?.id ?? null;
  const { url: photo } = useDocumentUrl(photoId);

  const load = () => api.member(id).then((x) => { setD(x); setError(""); }).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); api.plans().then(setPlans).catch(() => {}); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  if (!d) return <div className="page">{error ? <p className="form-error">{error}</p> : <p className="muted">در حال بارگذاری…</p>}</div>;
  const m = d.member;
  const name = `${m.first_name} ${m.last_name ?? ""}`.trim();
  const owing = d.periods.filter((p) => p.owed > 0);
  const owed = owing.reduce((t, p) => t + p.owed, 0) + (d.other_owed ?? 0);


  return (
    <div className="page">
      <section className="panel wide member-head">
        <div className="member-title">
          {photo && !debts && (
            <button type="button" className="member-photo-btn" onClick={() => setPhotoOpen(true)} aria-label="بزرگ دیدن عکس">
              <img className="member-photo" src={photo} alt="" />
            </button>
          )}
          {photoOpen && photo && <ImageViewer url={photo} label={name} name={`member-${m.member_no}`} onClose={() => setPhotoOpen(false)}
            onCrop={async (b) => { await api.addDocument(id, "photo", b); setPhotoOpen(false); void load(); }} />}
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
            {owed > 0 && (
              <div>
                <span className="muted small">پول</span>
                {openDebts && !debts
                  ? <button className="owed-badge as-button" onClick={openDebts}>باقی {fa(owed)}</button>
                  : <span className="owed-badge">باقی {fa(owed)}</span>}
              </div>
            )}
          </div>
        </div>
        {mode === "view" && !debts && (
          <div className="actions">
            <button className="btn big" onClick={() => setMode("renew")}>تمدید عضویت</button>
            {owed > 0 && <button className="btn" onClick={() => (openDebts ? openDebts() : setPaying(owing[owing.length - 1]))}>پرداخت باقی</button>}
            {k50?.configured && (
              <button className="btn ghost" disabled={!k50.enabled} onClick={() => setEnrolling(true)}
                title={k50.enabled ? undefined : "اول عضویت سالن را ثبت یا تمدید کنید"}><Icon name="fingerprint" /> ثبت انگشت</button>
            )}
            {!d.periods.length && <button className="btn ghost" onClick={() => setMode("record")}>ثبت تاریخ عضویت فعلی (پولش قبلاً گرفته شده)</button>}
            <button className="btn ghost" onClick={() => setMode("edit")}>ویرایش مشخصات</button>
            <button className="btn ghost" onClick={() => setCard(true)}>چاپ کارت عضویت</button>
            {partner && <button className="btn ghost danger-text" onClick={() => setRemoving("member")}><Icon name="trash" /> حذف عضو</button>}
          </div>
        )}
      </section>

      {error && <p className="form-error" role="alert">{error}</p>}

      {debts ? <DebtItems groupKey={`m:${id}`} person={{ member_id: id, name, phone: m.phone }} onChanged={() => void load()} /> : <>
      {steps && mode === "view" && (
        <section className="glass next-steps" aria-label="قدم‌های بعدی">
          <div className="next-steps-head">
            <h2><Icon name="check" /> {name} ثبت شد</h2>
            <button className="btn ghost small" onClick={() => setSteps(false)}>بستن</button>
          </div>
          <ol>
            {k50?.configured && (
              <li className={fingerDone > 0 ? "done" : ""}>
                <span>ثبت انگشت روی دستگاه دم در{fingerDone > 0 && <> · <strong>ثبت شد</strong></>}</span>
                {k50.enabled
                  ? <button className={`btn small${fingerDone > 0 ? " ghost" : ""}`} onClick={() => setEnrolling(true)}>{fingerDone > 0 ? "انگشت دیگر" : "ثبت انگشت"}</button>
                  : <span className="muted small">بدون عضویت فعال، دستگاه انگشت را قبول نمی‌کند.</span>}
              </li>
            )}
            <li className={photoId ? "done" : ""}>
              <span>عکس عضو برای کارت{photoId && <> · <strong>گذاشته شد</strong></>}</span>
              {!photoId && <button className="btn ghost small" onClick={() => document.getElementById("member-docs")?.scrollIntoView({ behavior: "smooth" })}>رفتن به عکس</button>}
            </li>
            <li>
              <span>چاپ کارت عضویت</span>
              <button className="btn ghost small" onClick={() => setCard(true)}>چاپ کارت</button>
            </li>
          </ol>
        </section>
      )}

      {mode === "edit" && <EditMember id={id} member={d} onDone={() => { setMode("view"); void load(); }} />}
      {(mode === "renew" || mode === "record") && (
        <AddPeriod id={id} detail={d} plans={plans} record={mode === "record"}
          onDone={(billId) => { setMode("view"); void load(); if (billId) setBill(billId); }}
          onCancel={() => setMode("view")} />
      )}

      <Documents memberId={id} docs={d.documents} onChange={() => void load()} />
      <Fingerprint memberId={id} name={name} reload={d.periods.length + fingerDone} onLoaded={setK50} onEnroll={() => setEnrolling(true)} />

      <section className="glass table-wrap">
        <table className="table">
          <thead><tr><th>نوع</th><th>از</th><th>تا</th><th className="num">مبلغ</th><th>بل</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {d.periods.map((p) => (
              <tr key={p.id}>
                <td>{p.plan_name}{p.note && <div className="muted small">{p.note}</div>}</td>
                <td>{formatDay(p.start_date)}</td>
                <td>{formatDay(p.end_date)}</td>
                <td className="num">
                  {p.receipt_id ? fa(p.fee - p.discount) : p.excel_fee !== null ? <>{fa(p.excel_fee)} <span className="chip excel">اکسل</span></> : "—"}
                  {p.owed > 0 && <div className="owed small">پرداخت {fa(p.paid)} · باقی {fa(p.owed)}</div>}
                </td>
                <td>{p.receipt_no ? <button className="link" onClick={() => setBill(p.receipt_id)}><bdi dir="ltr">{p.receipt_no}</bdi></button> : "—"}</td>
                <td>
                  <span className="row-tools">
                    {p.owed > 0 && <button className="btn small" onClick={() => setPaying(p)}>پرداخت باقی</button>}
                    {p.editable && <button className="btn small ghost" onClick={() => setDates(p)}><Icon name="edit" /> اصلاح</button>}
                    {p.removable && <button className="btn small ghost" aria-label="حذف" onClick={() => setRemoving(p)}><Icon name="trash" /></button>}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!d.periods.length && <p className="muted empty">هنوز هیچ دوره‌ای ثبت نشده. اگر این عضو از اکسل آمده، تاریخ عضویت فعلی‌اش را از دستگاه اثر انگشت ثبت کنید.</p>}
      </section>

      {d.excel_months.length > 0 && <ExcelMonths months={d.excel_months} onEdit={partner ? setCell : null} />}

      {removing === "member" && (
        <DeleteDialog title={`حذف ${name}`} action="حذف عضو" reasonRequired onClose={() => setRemoving(null)}
          extra={
            <label className="check choice">
              <input type="checkbox" checked={freeNo} onChange={(e) => setFreeNo(e.target.checked)} />
              <span>آیدی <bdi dir="ltr">{m.member_no}</bdi> آزاد شود: این شخص با همهٔ انگشت‌هایش از دستگاه انگشت پاک می‌شود و این آیدی به عضو تازه داده می‌شود.</span>
            </label>
          }
          onConfirm={async (reason) => {
            await api.deleteMember(id, reason, freeNo);
            setRemoving(null);
            toast(freeNo ? `${name} حذف شد؛ آیدی‌اش از دستگاه پاک و آزاد می‌شود.` : `${name} حذف شد.`, async () => { await api.restoreMember(id); });
            onRemoved?.();
          }}>
          دوره‌ها و عکس و تذکرهٔ این عضو هم با او حذف می‌شوند. بل‌هایش می‌مانند، چون پولش گرفته شده. اگر اشتباه شد، از «چه کسی چه کرد» برگردانده می‌شود (اگر آیدی‌اش هنوز به کس دیگری داده نشده باشد).
        </DeleteDialog>
      )}
      {removing && removing !== "member" && (
        <DeleteDialog title="حذف دوره" onClose={() => setRemoving(null)}
          onConfirm={async (reason) => { await api.deletePeriod(removing.id, reason); setRemoving(null); await load(); toast("دوره حذف شد."); }}>
          {removing.plan_name}، از {formatDay(removing.start_date)} تا {formatDay(removing.end_date)}.
        </DeleteDialog>
      )}
      {paying && <PayRest first={paying} owing={owing} onClose={(billId) => { setPaying(null); if (billId) { void load(); setBill(billId); toast("باقی پرداخت شد."); } }} />}
      {dates && <PeriodDates period={dates} memberId={id} partner={partner} onClose={(saved) => { setDates(null); if (saved) { void load(); toast("دوره اصلاح شد."); } }} />}
      {cell && <ExcelCell memberId={id} cell={cell} onClose={(saved) => { setCell(null); if (saved) { void load(); toast("فیس این ماه اصلاح شد."); } }} />}
      {bill && <BillPreview id={bill} onClose={() => setBill(null)} />}
      {enrolling && <Enroll memberId={id} name={name} onClose={(added) => { setEnrolling(false); if (added) setFingerDone((n) => n + 1); }} />}
      {card && !bill && <MemberCardPreview member={m} photoId={photoId} onClose={() => setCard(false)} />}
      </>}
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
      {member.member.member_no !== null && (
        <NumberHelp value={m.member_no ?? null} own={member.member.member_no} onPick={(no) => setM((x) => ({ ...x, member_no: no }))} />
      )}
      <div className="form-grid">
        <SolarDate label="تاریخ ثبت‌نام" value={m.joined_on ?? member.member.joined_on} onChange={(d) => setM({ ...m, joined_on: d })} />
      </div>
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

/**
 * Correcting a period: its dates and its money. Income, the reports and what the member owes
 * all read the bills, so what is typed here changes them too. A period whose money came from
 * the Excel book is corrected on that month's cell; one with no money yet gets a bill.
 */
function PeriodDates({ period, memberId, partner, onClose }: { period: Period; memberId: string; partner: boolean; onClose: (saved: boolean) => void }) {
  const billed = !!period.receipt_id;
  const excel = !billed && period.excel_fee !== null;
  const wasPaidInFull = billed && period.paid >= period.fee - period.discount - 0.005;
  const [start, setStart] = useState(period.start_date);
  const [end, setEnd] = useState(period.end_date);
  const [note, setNote] = useState(period.note ?? "");
  const [fee, setFee] = useState(String(billed ? period.fee : excel ? period.excel_fee : 0));
  const [discount, setDiscount] = useState(String(period.discount));
  const [paidText, setPaidText] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const feeN = amount(fee);
  const discountN = billed ? amount(discount) : 0;
  const due = feeN - discountN;
  // A period paid in full stays paid in full when its price changes, until «پرداخت شده» is typed.
  const paidN = paidText !== null ? amount(paidText) : wasPaidInFull ? due : Math.min(period.paid, due);
  async function save() {
    if (!start || !end) return setError("هر دو تاریخ را انتخاب کنید.");
    if (end < start) return setError("تاریخ ختم پیش از شروع است.");
    if (discountN > feeN) return setError("تخفیف از مبلغ بیشتر است.");
    if (billed && paidN > due) return setError("پرداخت شده از مبلغ بیشتر است.");
    setBusy(true);
    try {
      const money = billed ? { fee: feeN, discount: discountN, paid: paidN } : !excel && feeN > 0 ? { fee: feeN, discount: 0, paid: feeN } : {};
      if (excel && feeN !== period.excel_fee) {
        const { y, m } = toSolar(period.start_date);
        await api.setExcelMonth(memberId, { kind: period.kind, year: y, month: m, amount: feeN });
      }
      await api.updatePeriod(period.id, { start_date: start, end_date: end, note, ...money });
      onClose(true);
    } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal label="اصلاح دوره" onClose={() => onClose(false)}>
      <h2>اصلاح دوره</h2>
      <p className="muted">{period.plan_name}{period.receipt_no && <>، بل <bdi dir="ltr">{period.receipt_no}</bdi></>}. مقدارهای قبلی در «چه کسی چه کرد» می‌مانند.</p>
      <div className="form-grid">
        <SolarDate label="از" value={start} onChange={setStart} />
        <SolarDate label="تا" value={end} onChange={setEnd} />
        {billed && (
          <>
            <label className="field wide"><span>فیس (افغانی)</span><input dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(decimal(e.target.value))} /></label>
            <label className="field wide"><span>تخفیف</span><input dir="ltr" inputMode="decimal" value={discount} onChange={(e) => setDiscount(decimal(e.target.value))} /></label>
            <label className="field wide"><span>پرداخت شده</span><input dir="ltr" inputMode="decimal" value={paidText ?? String(paidN)} onChange={(e) => setPaidText(decimal(e.target.value))} /></label>
          </>
        )}
        {excel && partner && <label className="field wide"><span>فیس این ماه در اکسل (افغانی)</span><input dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(decimal(e.target.value))} /></label>}
        {!billed && !excel && <label className="field wide"><span>پول این دوره (افغانی)</span><input dir="ltr" inputMode="decimal" value={fee} onChange={(e) => setFee(decimal(e.target.value))} /></label>}
        <label className="field wide span-2"><span>یادداشت</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="مثلاً: روزهای بسته بودن سالن اضافه شد" /></label>
      </div>
      {billed && <p className="muted small">درآمد به اندازهٔ «پرداخت شده» است. {due - paidN > 0 ? `باقی نزد عضو: ${fa(due - paidN)}` : "باقی ندارد."}</p>}
      {excel && partner && <p className="muted small">این پول در درآمد همان ماه است. اگر اکسل دوباره وارد شود، عدد اکسل برمی‌گردد؛ پس در خود اکسل هم درستش کنید.</p>}
      {!billed && !excel && feeN > 0 && <p className="muted small">برای این پول یک بل ساخته می‌شود و در درآمد روز شروع دوره می‌آید. اگر پولش پیش از برنامه گرفته شده و در حساب‌ها هست، خالی بگذارید.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
      </div>
    </Modal>
  );
}

/** One month's money of the member's row in the Excel book, corrected by a partner. */
function ExcelCell({ memberId, cell, onClose }: { memberId: string; cell: { kind: string; year: number; month: number; amount: number }; onClose: (saved: boolean) => void }) {
  const [value, setValue] = useState(cell.amount ? String(cell.amount) : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await api.setExcelMonth(memberId, { ...cell, amount: amount(value) }); onClose(true); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal label="اصلاح فیس اکسل" onClose={() => onClose(false)}>
      <h2>{cell.kind === "internet" ? "انترنت" : "عضویت"} {MONTHS[cell.month - 1]} {cell.year}</h2>
      <label className="field wide"><span>مبلغ (افغانی)</span><input dir="ltr" inputMode="decimal" autoFocus value={value} onChange={(e) => setValue(decimal(e.target.value))} /></label>
      <p className="muted small">این پول در درآمد همان ماه است و گزارش‌ها با آن عوض می‌شوند. خالی یا 0 یعنی این ماه پولی نداده. اگر اکسل دوباره وارد شود، عدد اکسل برمی‌گردد؛ پس در خود اکسل هم درستش کنید.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy} onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
      </div>
    </Modal>
  );
}

/** The fee cells of the member's row in the Excel book, one line per year and kind. */
function ExcelMonths({ months, onEdit }: { months: MemberDetail["excel_months"]; onEdit: ((c: { kind: string; year: number; month: number; amount: number }) => void) | null }) {
  const lines = [...new Set(months.map((x) => `${x.year}|${x.kind}`))];
  return (
    <section className="glass excel-months" aria-label="ماه‌های اکسل">
      <h2>پرداخت‌های اکسل</h2>
      {lines.map((l) => {
        const [y, kind] = l.split("|");
        const row = months.filter((x) => String(x.year) === y && x.kind === kind);
        return (
          <div key={l} className="excel-line">
            <span className="muted">{kind === "internet" ? "انترنت" : "عضویت"} {y}</span>
            <ul>
              {MONTHS.map((name, i) => {
                const cell = row.find((x) => x.month === i + 1);
                const shown = <><span>{name}</span><strong>{cell ? fa(cell.amount) : "—"}</strong></>;
                return (
                  <li key={name} className={cell ? "paid" : ""}>
                    {onEdit
                      ? <button type="button" className="excel-cell" aria-label={`اصلاح ${name}`} onClick={() => onEdit({ kind, year: Number(y), month: i + 1, amount: cell?.amount ?? 0 })}>{shown}</button>
                      : shown}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <p className="muted small">از دفتر اکسل. این پول‌ها در حساب‌ها هستند و دوباره حساب نمی‌شوند.{onEdit && " برای اصلاح، روی ماه بزنید."}</p>
    </section>
  );
}

/** The rest of a period paid in parts: a second bill. */
function PayRest({ first, owing, onClose }: { first: Period; owing: Period[]; onClose: (billId: string | null) => void }) {
  const [period, setPeriod] = useState(first);
  const [amount, setAmount] = useState(String(first.owed));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const n = Number(amount);
  async function pay() {
    setBusy(true);
    try { const r = await api.payRest(period.id, n); onClose(r.receipt_id); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal label="پرداخت باقی" onClose={() => !busy && onClose(null)}>
      <h2>پرداخت باقی · {period.plan_name}</h2>
      {owing.length > 1 && (
        <label className="field">
          <span>کدام دوره؟ ({fa(owing.length)} دوره باقی دارد)</span>
          <select value={period.id} onChange={(e) => { const p = owing.find((x) => x.id === e.target.value)!; setPeriod(p); setAmount(String(p.owed)); }}>
            {[...owing].reverse().map((p) => (
              <option key={p.id} value={p.id}>{formatDay(p.start_date)} تا {formatDay(p.end_date)} · باقی {fa(p.owed)}</option>
            ))}
          </select>
        </label>
      )}
      <p className="muted">
        {period.plan_name}، {formatDay(period.start_date)} تا {formatDay(period.end_date)}. مبلغ {fa(period.fee - period.discount)}، پرداخت‌شده {fa(period.paid)}، باقی <strong className="owed">{fa(period.owed)}</strong> افغانی.
      </p>
      <label className="field">
        <span>پرداخت حالا (افغانی)</span>
        <input dir="ltr" inputMode="numeric" value={amount} autoFocus onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} />
      </label>
      {n > 0 && n < period.owed && <p className="muted small">بعد از این، {fa(period.owed - n)} افغانی باقی می‌ماند.</p>}
      {n > period.owed && <p className="form-error" role="alert">بیشتر از باقی است. حداکثر {fa(period.owed)} افغانی.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || !(n > 0 && n <= period.owed)} onClick={() => void pay()}>{busy ? "در حال ثبت…" : "ثبت و بل"}</button>
        <button className="btn ghost" disabled={busy} onClick={() => onClose(null)}>انصراف</button>
      </div>
    </Modal>
  );
}
