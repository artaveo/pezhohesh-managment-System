import { useEffect, useState } from "react";
import { api, errorText, k50ErrorText, type MemberK50 } from "../../lib/api";
import { fa, formatDay } from "../../lib/solar";
import { Modal } from "../../components/Modal";
import { Icon } from "../../components/Icon";
import { useToast } from "../../components/Toast";

/** The device's finger numbers, as a person faces their own hands. */
const FINGERS = [
  { n: 4, label: "شست چپ" }, { n: 3, label: "اشارهٔ چپ" }, { n: 2, label: "وسطی چپ" }, { n: 1, label: "حلقهٔ چپ" }, { n: 0, label: "کوچک چپ" },
  { n: 5, label: "شست راست" }, { n: 6, label: "اشارهٔ راست" }, { n: 7, label: "وسطی راست" }, { n: 8, label: "حلقهٔ راست" }, { n: 9, label: "کوچک راست" },
];

const time = (at: string) => {
  const d = new Date(at);
  return `${formatDay(d)} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

/** The member on the fingerprint device: open until when, their fingers, their last visits. */
export function Fingerprint({ memberId, reload }: { memberId: string; reload: number }) {
  const toast = useToast();
  const [k, setK] = useState<MemberK50 | null>(null);
  const [fingers, setFingers] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [enrolling, setEnrolling] = useState(false);

  const load = () => api.memberK50(memberId).then((x) => { setK(x); setFingers((f) => f ?? x.sent?.fingers ?? null); }).catch((e) => setError(errorText(e)));
  // A renewal sends the new dates a few seconds later; look again then.
  useEffect(() => {
    void load();
    const t = setTimeout(() => void load(), 6000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [memberId, reload]);

  async function act(what: string, f: () => Promise<{ ok: boolean; error: string | null }>, done: string) {
    setBusy(what);
    setError("");
    try {
      const r = await f();
      if (r.ok) toast(done); else setError(k50ErrorText(r.error));
      return r;
    } catch (e) {
      setError(errorText(e));
      return null;
    } finally {
      setBusy("");
      void load();
    }
  }
  const check = () => act("check", async () => {
    const r = await api.checkMemberK50(memberId);
    if (r.ok) setFingers(r.exists ? r.fingers ?? 0 : 0);
    return r;
  }, "از دستگاه پرسیده شد.");

  if (!k) return error ? <p className="form-error">{error}</p> : null;
  if (!k.configured) return null;
  const s = k.sent;
  const onDevice = s?.pushed_at != null;
  const upToDate = onDevice && s.pushed_enabled === k.enabled && s.pushed_end === k.end_date && s.pushed_start === k.start_date;
  return (
    <>
    <section className="panel wide">
      <h2><Icon name="fingerprint" /> دستگاه انگشت</h2>
      <div className="k50-state">
        {!onDevice ? <span className="muted">هنوز به دستگاه فرستاده نشده{k.enabled && k.auto ? " (چند لحظه بعد خودش فرستاده می‌شود)" : ""}.</span>
          : s.pushed_enabled ? <span className="chip kind-monthly new">باز تا {s.pushed_end ? formatDay(s.pushed_end) : "—"}</span>
          : <span className="chip kind-remove">روی دستگاه بسته است</span>}
        {onDevice && !upToDate && <span className="muted small">تاریخ تازه هنوز به دستگاه نرفته.</span>}
        {s?.valid_dates === false && <span className="muted small">این دستگاه تاریخ نمی‌گیرد؛ برنامه خودش در روز ختم آن را می‌بندد.</span>}
        {fingers != null && <span className="muted">انگشت ثبت‌شده: {fa(fingers)}</span>}
        {s?.error && <span className="form-error inline">{k50ErrorText(s.error)}</span>}
      </div>
      <div className="actions">
        <button className="btn" disabled={!!busy || !k.enabled} onClick={() => setEnrolling(true)}
          title={k.enabled ? undefined : "اول عضویت را تمدید کنید"}>ثبت انگشت</button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void act("push", () => api.pushMemberK50(memberId), "به دستگاه فرستاده شد.")}>
          {busy === "push" ? "در حال فرستادن…" : "همین حالا به دستگاه بفرست"}
        </button>
        <button className="btn ghost" disabled={!!busy} onClick={() => void check()}>{busy === "check" ? "…" : "از دستگاه بپرس"}</button>
      </div>
      {!k.enabled && <p className="muted small">عضویت سالن این عضو الان فعال نیست؛ دستگاه انگشتش را قبول نمی‌کند.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {k.visits.length > 0 && (
        <>
          <p className="muted small">آخرین آمدن‌ها:</p>
          <ul className="k50-visits">{k.visits.map((v) => <li key={v}><bdi>{time(v)}</bdi></li>)}</ul>
        </>
      )}
    </section>
    {enrolling && <Enroll memberId={memberId} onClose={() => { setEnrolling(false); void check(); }} />}
    </>
  );
}

function Enroll({ memberId, onClose }: { memberId: string; onClose: () => void }) {
  const [finger, setFinger] = useState(6);
  const [state, setState] = useState<"pick" | "busy" | "waiting">("pick");
  const [error, setError] = useState("");
  async function start() {
    setState("busy");
    setError("");
    try {
      const r = await api.enrollK50(memberId, finger);
      if (r.ok) setState("waiting"); else { setError(k50ErrorText(r.error)); setState("pick"); }
    } catch (e) {
      setError(errorText(e));
      setState("pick");
    }
  }
  return (
    <Modal label="ثبت انگشت" onClose={onClose}>
      <h2>ثبت انگشت</h2>
      {state !== "waiting" ? (
        <>
          <p className="muted">کدام انگشت؟</p>
          <div className="finger-grid">
            {FINGERS.map((f) => (
              <button key={f.n} type="button" className={`btn ghost small ${finger === f.n ? "picked" : ""}`} onClick={() => setFinger(f.n)}>{f.label}</button>
            ))}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn big" disabled={state === "busy"} onClick={() => void start()}>{state === "busy" ? "در حال آماده کردن دستگاه…" : "دستگاه را آماده کن"}</button>
            <button className="btn ghost" onClick={onClose}>انصراف</button>
          </div>
        </>
      ) : (
        <>
          <p className="form-ok">دستگاه آماده است.</p>
          <p>عضو همان انگشت را <strong>سه بار</strong> روی دستگاه بگذارد و بردارد، تا دستگاه بگوید ثبت شد.</p>
          <p className="muted small">اگر دستگاه چیزی نگفت، دوباره «دستگاه را آماده کن» بزنید.</p>
          <div className="actions"><button className="btn big" onClick={onClose}>تمام شد</button></div>
        </>
      )}
    </Modal>
  );
}
