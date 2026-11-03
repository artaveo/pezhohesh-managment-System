import { useEffect, useState } from "react";
import { api, errorText, k50ErrorText, type K50User, type MemberK50 } from "../../lib/api";
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
export function Fingerprint({ memberId, name, reload, onLoaded, onEnroll }: {
  memberId: string; name: string; reload: number; onLoaded: (k: MemberK50) => void; onEnroll: () => void;
}) {
  const toast = useToast();
  const [k, setK] = useState<MemberK50 | null>(null);
  const [fingers, setFingers] = useState<number | null>(null);
  // What the device itself holds for this ID, after «از دستگاه بپرس».
  const [dev, setDev] = useState<K50User | null>(null);
  const [claiming, setClaiming] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  const load = () => api.memberK50(memberId).then((x) => { setK(x); onLoaded(x); setFingers((f) => f ?? x.sent?.fingers ?? null); }).catch((e) => setError(errorText(e)));
  // A renewal sends the new dates a few seconds later; look again then.
  useEffect(() => {
    setFingers(null);
    setDev(null);
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
    if (r.ok) { setFingers(r.exists ? r.fingers ?? 0 : 0); setDev(r); }
    return r;
  }, "از دستگاه پرسیده شد.");
  const claim = () => act("push", () => api.pushMemberK50(memberId, true), "به دستگاه فرستاده شد.").then(() => setClaiming(false));

  if (!k) return error ? <p className="form-error">{error}</p> : null;
  if (!k.configured) return null;
  const s = k.sent;
  const onDevice = s?.pushed_at != null;
  const upToDate = onDevice && s.pushed_enabled === k.enabled && s.pushed_end === k.end_date && s.pushed_start === k.start_date;
  const taken = s?.error?.startsWith("taken") ? s.error.slice("taken:".length).trim() : null;
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
      {s?.device_read && (
        <p className="muted small">دستگاه تاریخ را این‌طور پس داد: <bdi dir="ltr">{s.device_read.start}</bdi> تا <bdi dir="ltr">{s.device_read.end}</bdi></p>
      )}
      {taken != null && (
        <div className="actions">
          <button className="btn ghost small" disabled={!!busy} onClick={() => setClaiming(true)}>«{taken || "بی‌نام"}» روی دستگاه همین {name} است</button>
        </div>
      )}
      {dev && (
        <dl className="k50-device" aria-label="روی دستگاه">
          {!dev.exists ? <><dt>روی دستگاه</dt><dd>این آیدی روی دستگاه نیست.</dd></> : (
            <>
              <dt>نام روی دستگاه</dt><dd><bdi>{dev.name || "—"}</bdi></dd>
              <dt>وضع</dt><dd>{dev.enabled ? "باز" : "بسته"}{dev.privilege ? " (مدیر دستگاه)" : ""}</dd>
              <dt>اعتبار روی دستگاه</dt><dd>{dev.valid ? <><bdi dir="ltr">{dev.valid.start}</bdi> تا <bdi dir="ltr">{dev.valid.end}</bdi>{dev.valid.expires === 0 ? " (بدون ختم)" : ""}</> : "تاریخی ندارد"}</dd>
              <dt>گروه</dt><dd><bdi dir="ltr">{dev.group ?? "—"}</bdi></dd>
              <dt>بازهٔ زمانی</dt><dd><bdi dir="ltr">{dev.zones ?? "—"}</bdi></dd>
            </>
          )}
          <dt>ساعت دستگاه</dt><dd><bdi dir="ltr">{dev.device_time ?? "—"}</bdi></dd>
        </dl>
      )}
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
      {claiming && taken != null && (
        <Modal label="همین شخص است؟" onClose={() => setClaiming(false)}>
          <h2>همین شخص است؟</h2>
          <p>روی دستگاه، آیدی <bdi dir="ltr">{s?.member_no}</bdi> به نام «<bdi>{taken || "بی‌نام"}</bdi>» ثبت است.</p>
          <p>اگر این همان {name} است (مثلاً اسمش در ZKAccess با حروف انگلیسی نوشته شده)، تأیید کنید تا برنامه تاریخ‌هایش را روی همان آیدی بنویسد. اسم و انگشت‌هایش روی دستگاه عوض نمی‌شود.</p>
          <p className="form-error">اگر آدم دیگری است، تأیید نکنید. شمارهٔ عضویت این عضو را عوض کنید.</p>
          <div className="actions">
            <button className="btn" disabled={!!busy} onClick={() => void claim()}>{busy === "push" ? "در حال فرستادن…" : "بله، همین شخص است"}</button>
            <button className="btn ghost" onClick={() => setClaiming(false)}>نه</button>
          </div>
        </Modal>
      )}
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
/**
 * One hand, as a person sees the back of their own hands: fingers numbered 1 (thumb) to 5
 * (little). The right hand has its thumb on the left; the left hand is its mirror image.
 * Each finger is a button; its device number is 5–9 on the right hand, 4–0 on the left.
 */
const HAND = [
  // pos, x, y, width, height, rotation (around the finger's base)
  { pos: 1, x: 40, y: 140, w: 30, h: 70, rot: -34 },
  { pos: 2, x: 62, y: 42, w: 28, h: 112, rot: -6 },
  { pos: 3, x: 95, y: 22, w: 29, h: 128, rot: 0 },
  { pos: 4, x: 129, y: 38, w: 28, h: 114, rot: 6 },
  { pos: 5, x: 161, y: 74, w: 24, h: 88, rot: 13 },
];
const VIEW = 210;
const deviceFinger = (side: "right" | "left", pos: number) => (side === "right" ? 4 + pos : 5 - pos);

function Hand({ side, picked, enrolled, failed, disabled, onPick }: {
  side: "right" | "left"; picked: number; enrolled: number[]; failed: number | null; disabled: boolean; onPick: (n: number) => void;
}) {
  const mirror = (x: number, w = 0) => (side === "right" ? x : VIEW - x - w);
  return (
    <figure className="hand">
      <svg viewBox={`0 0 ${VIEW} 300`} role="group" aria-label={side === "right" ? "دست راست" : "دست چپ"}>
        <defs>
          <linearGradient id={`skin-${side}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--hand-top)" />
            <stop offset="1" stopColor="var(--hand-bottom)" />
          </linearGradient>
        </defs>
        {/* The palm and wrist. */}
        <path className="hand-palm" fill={`url(#skin-${side})`}
          d={side === "right"
            ? "M58 140 C58 128 66 124 80 124 L170 128 C182 130 188 142 186 160 L178 236 C176 262 160 290 134 296 L92 296 C70 290 56 268 52 240 L44 190 C42 172 50 150 58 140 Z"
            : "M152 140 C152 128 144 124 130 124 L40 128 C28 130 22 142 24 160 L32 236 C34 262 50 290 76 296 L118 296 C140 290 154 268 158 240 L166 190 C168 172 160 150 152 140 Z"} />
        {HAND.map((f) => {
          const n = deviceFinger(side, f.pos);
          const x = mirror(f.x, f.w);
          const rot = side === "right" ? f.rot : -f.rot;
          const cx = x + f.w / 2;
          const base = f.y + f.h;
          const state = failed === n ? "failed" : picked === n ? "picked" : enrolled.includes(n) ? "enrolled" : "";
          const label = FINGERS.find((x) => x.n === n)!.label;
          // A point on the finger's centre line, turned with the finger (labels stay upright).
          const turn = (y: number) => {
            const a = (rot * Math.PI) / 180;
            return { x: cx - (y - base) * Math.sin(a), y: base + (y - base) * Math.cos(a) };
          };
          const tip = turn(f.y - 13);
          const mid = turn(f.y + f.h * 0.55);
          return (
            <g key={f.pos} className={`finger ${state}`} role="button" tabIndex={disabled ? -1 : 0} aria-pressed={picked === n} aria-disabled={disabled}
              aria-label={`${label}${enrolled.includes(n) ? "، ثبت شده" : ""}`}
              onClick={() => { if (!disabled) onPick(n); }}
              onKeyDown={(e) => { if (!disabled && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onPick(n); } }}>
              <g transform={`rotate(${rot} ${cx} ${base})`}>
                <rect x={x - 6} y={f.y - 6} width={f.w + 12} height={f.h + 12} rx={(f.w + 12) / 2} className="finger-hit" />
                <rect x={x} y={f.y} width={f.w} height={f.h} rx={f.w / 2} className="finger-body" fill={`url(#skin-${side})`} />
                <rect x={x + f.w * 0.2} y={f.y + 4} width={f.w * 0.6} height={f.w * 0.62} rx={f.w * 0.28} className="finger-nail" />
              </g>
              <text x={tip.x} y={tip.y + 5} textAnchor="middle" className="finger-no">{fa(f.pos)}</text>
              {enrolled.includes(n) && picked !== n && <path d={`M${mid.x - 6} ${mid.y} l4 4 l8 -9`} className="finger-check" />}
            </g>
          );
        })}
      </svg>
      <figcaption>{side === "right" ? "دست راست" : "دست چپ"}</figcaption>
    </figure>
  );
}

export function Enroll({ memberId, name, onClose }: { memberId: string; name: string; onClose: (added: boolean) => void }) {
  const [finger, setFinger] = useState(6);
  const [state, setState] = useState<"pick" | "busy" | "waiting" | "checking" | "done" | "missing">("pick");
  const [error, setError] = useState("");
  const [count, setCount] = useState(0);
  const [before, setBefore] = useState<number | null>(null);
  // Which fingers the device already has for this member (shown on the hands).
  const [enrolled, setEnrolled] = useState<number[]>([]);
  // How many fingers the device has now, to tell a new one from an old one afterwards.
  useEffect(() => {
    api.checkMemberK50(memberId).then((r) => {
      if (!r.ok) return;
      setBefore(r.exists ? r.fingers ?? 0 : 0);
      const list = r.exists ? r.finger_list ?? [] : [];
      setEnrolled(list);
      // Start on a finger the device does not have yet: right index, then left index.
      if (list.includes(6)) setFinger(list.includes(3) ? [7, 2, 5, 4, 8, 1, 9, 0].find((n) => !list.includes(n)) ?? 6 : 3);
    }).catch(() => {});
  }, [memberId]);
  async function verify() {
    setState("checking");
    try {
      const r = await api.checkMemberK50(memberId);
      const now = r.ok && r.exists ? r.fingers ?? 0 : 0;
      setCount(now);
      if (r.ok && r.exists && r.finger_list) setEnrolled(r.finger_list);
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
  const step = state === "pick" || state === "busy" ? 1 : state === "waiting" ? 2 : 3;
  const label = FINGERS.find((f) => f.n === finger)?.label ?? "";
  const picking = state === "pick" || state === "busy";
  const failed = state === "missing" ? finger : null;
  const status = state === "busy" ? { tone: "wait", text: "در حال آماده کردن دستگاه…" }
    : state === "waiting" ? { tone: "live", text: "دستگاه منتظر انگشت است" }
    : state === "checking" ? { tone: "wait", text: "در حال پرسیدن از دستگاه…" }
    : state === "done" ? { tone: "good", text: "انگشت ثبت شد" }
    : state === "missing" ? { tone: "bad", text: "انگشت تازه‌ای دیده نشد" }
    : { tone: "idle", text: "یک انگشت را انتخاب کنید" };
  return (
    <Modal label="ثبت اثر انگشت" onClose={() => onClose(state === "done")} className="enroll-modal">
      <header className="enroll-head">
        <span className="enroll-mark"><Icon name="fingerprint" /></span>
        <div>
          <h2>ثبت اثر انگشت</h2>
          <p className="muted small">{name}</p>
        </div>
      </header>
      <ol className="enroll-steps" aria-label="قدم‌ها">
        {["انتخاب انگشت", "سه بار روی دستگاه", "بررسی"].map((t, i) => (
          <li key={t} className={step === i + 1 ? "on" : step > i + 1 ? "done" : ""} aria-current={step === i + 1 ? "step" : undefined}>
            <span className="dot" aria-hidden="true" />{t}
          </li>
        ))}
      </ol>
      <div className="enroll-body">
        <div className="hands" aria-label="انگشت را روی دست انتخاب کنید">
          <Hand side="right" picked={finger} enrolled={enrolled} failed={failed} disabled={!picking} onPick={setFinger} />
          <Hand side="left" picked={finger} enrolled={enrolled} failed={failed} disabled={!picking} onPick={setFinger} />
        </div>
        <aside className={`enroll-panel tone-${status.tone}`} aria-live="polite">
          <div className="enroll-status">
            <span className={`pulse ${status.tone}`} aria-hidden="true"><Icon name="fingerprint" /></span>
            <strong>{status.text}</strong>
          </div>
          <div className="enroll-picked">
            <span className="muted small">انگشت انتخاب‌شده</span>
            <b>{label}</b>
          </div>
          <p className="enroll-say">
            {picking ? <>روی دست‌ها انگشت را بزنید، بعد «آماده کردن دستگاه». انگشت‌های سبز با تیک از قبل ثبت شده‌اند.</>
              : state === "waiting" ? <>{name} <strong>{label}</strong> را <strong>سه بار</strong> روی حسگر دستگاه بگذارد و بردارد تا دستگاه بگوید ثبت شد. بعد «ثبت شد، بررسی کن».</>
              : state === "checking" ? <>برنامه از دستگاه می‌پرسد چند انگشت دارد.</>
              : state === "done" ? <>حالا {fa(count)} انگشت از {name} روی دستگاه است. برای روزی که این انگشت زخمی شد، بهتر است یک انگشت دیگر هم ثبت شود.</>
              : <>{error || "شاید سه بار کامل نشد یا وقت دستگاه تمام شد."} دوباره امتحان کنید.</>}
          </p>
          {error && picking && <p className="form-error" role="alert">{error}</p>}
          <ul className="enroll-legend" aria-label="راهنمای رنگ‌ها">
            <li><i className="lg-idle" />عادی</li>
            <li><i className="lg-picked" />انتخاب‌شده</li>
            <li><i className="lg-enrolled" />ثبت‌شده</li>
            <li><i className="lg-failed" />خطا</li>
          </ul>
        </aside>
      </div>
      <div className="actions enroll-actions">
        {picking ? (
          <>
            <button className="btn big" disabled={state === "busy"} onClick={() => void start()}>{state === "busy" ? "در حال آماده کردن دستگاه…" : "آماده کردن دستگاه"}</button>
            <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
          </>
        ) : state === "waiting" ? (
          <>
            <button className="btn big" autoFocus onClick={() => void verify()}>ثبت شد، بررسی کن</button>
            <button className="btn ghost" onClick={() => setState("pick")}>از نو</button>
          </>
        ) : state === "checking" ? (
          <button className="btn big" disabled>در حال بررسی…</button>
        ) : state === "done" ? (
          <>
            <button className="btn big" autoFocus onClick={() => onClose(true)}>تمام</button>
            <button className="btn ghost" onClick={() => {
              setBefore(count); setState("pick");
              setFinger([6, 3, 7, 2, 5, 4, 8, 1, 9, 0].find((n) => !enrolled.includes(n)) ?? finger);
            }}>انگشت دیگر</button>
          </>
        ) : (
          <>
            <button className="btn big" autoFocus onClick={() => { setError(""); setState("pick"); }}>دوباره</button>
            <button className="btn ghost" onClick={() => onClose(false)}>بستن</button>
          </>
        )}
      </div>
    </Modal>
  );
}
