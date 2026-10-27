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

/**
 * The member on the fingerprint device: open until when, their fingers, their last visits.
 * Enrolling a finger is the page's own dialog (it is also offered at the top of the page).
 */
export function Fingerprint({ memberId, reload, onLoaded, onEnroll }: {
  memberId: string; reload: number; onLoaded: (k: MemberK50) => void; onEnroll: () => void;
}) {
  const toast = useToast();
  const [k, setK] = useState<MemberK50 | null>(null);
  const [fingers, setFingers] = useState<number | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = () => api.memberK50(memberId).then((x) => { setK(x); onLoaded(x); setFingers((f) => f ?? x.sent?.fingers ?? null); }).catch((e) => setError(errorText(e)));
  // A renewal sends the new dates a few seconds later; look again then.
  useEffect(() => {
    setFingers(null);
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
        <button className="btn" disabled={!!busy || !k.enabled} onClick={onEnroll}
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
    </>
  );
}

/**
 * Enrolling one finger: pick it, the device is made ready, the member presses it three
 * times, and then the device is asked whether the finger is there.
 */
export function Enroll({ memberId, name, onClose }: { memberId: string; name: string; onClose: (added: boolean) => void }) {
  const [finger, setFinger] = useState(6);
  const [state, setState] = useState<"pick" | "busy" | "waiting" | "checking" | "done" | "missing">("pick");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [before, setBefore] = useState<number | null>(null);
  // How many fingers the device has now, to tell a new one from an old one afterwards.
  useEffect(() => {
    api.checkMemberK50(memberId).then((r) => { if (r.ok) setBefore(r.exists ? r.fingers ?? 0 : 0); }).catch(() => {});
  }, [memberId]);
  async function verify() {
    setState("checking");
    try {
      const r = await api.checkMemberK50(memberId);
      const now = r.ok && r.exists ? r.fingers ?? 0 : 0;
      setCount(now);
      setState(r.ok && now > (before ?? 0) ? "done" : "missing");
      if (!r.ok) setError(k50ErrorText(r.error));
    } catch (e) {
      setError(errorText(e));
      setState("missing");
    }
  }
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
    <Modal label="ثبت انگشت" onClose={() => onClose(state === "done")}>
      <h2>ثبت انگشت {name}</h2>
      <ol className="enroll-steps" aria-label="قدم‌ها">
        <li className={state === "pick" || state === "busy" ? "on" : "done"}>انتخاب انگشت</li>
        <li className={state === "waiting" ? "on" : state === "checking" || state === "done" || state === "missing" ? "done" : ""}>سه بار روی دستگاه</li>
        <li className={state === "checking" || state === "done" || state === "missing" ? "on" : ""}>بررسی</li>
      </ol>
      {state === "pick" || state === "busy" ? (
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
            <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
          </div>
        </>
      ) : state === "waiting" ? (
        <>
          <p className="form-ok">دستگاه آماده است.</p>
          <p>{name} <strong>{FINGERS.find((f) => f.n === finger)?.label}</strong> را <strong>سه بار</strong> روی دستگاه بگذارد و بردارد، تا دستگاه بگوید ثبت شد.</p>
          <div className="actions">
            <button className="btn big" autoFocus onClick={() => void verify()}>ثبت شد، بررسی کن</button>
            <button className="btn ghost" onClick={() => setState("pick")}>از نو</button>
          </div>
        </>
      ) : state === "checking" ? (
        <p className="muted" role="status">در حال پرسیدن از دستگاه…</p>
      ) : state === "done" ? (
        <>
          <p className="form-ok" role="status">انگشت ثبت شد. حالا {fa(count)} انگشت از {name} روی دستگاه است.</p>
          <p className="muted small">برای وقتی که این انگشت زخمی شد، بهتر است یک انگشت دیگر هم ثبت شود.</p>
          <div className="actions">
            <button className="btn big" autoFocus onClick={() => onClose(true)}>تمام</button>
            <button className="btn ghost" onClick={() => { setBefore(count); setState("pick"); setFinger(finger === 6 ? 5 : 6); }}>انگشت دیگر</button>
          </div>
        </>
      ) : (
        <>
          <p className="form-error" role="alert">{error || "دستگاه انگشت تازه‌ای نشان نمی‌دهد."}</p>
          <p className="muted small">شاید سه بار کامل نشد یا دستگاه وقتش تمام شد. دوباره امتحان کنید.</p>
          <div className="actions">
            <button className="btn big" autoFocus onClick={() => { setError(""); setState("pick"); }}>دوباره</button>
            <button className="btn ghost" onClick={() => onClose(false)}>بستن</button>
          </div>
        </>
      )}
    </Modal>
  );
}
