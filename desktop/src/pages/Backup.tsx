import { useEffect, useState } from "react";
import { api, errorText, type BackupOutcome, type BackupStatus } from "../lib/api";
import { formatDay } from "../lib/solar";

const EVERY = [
  { h: 6, label: "هر 6 ساعت" },
  { h: 12, label: "هر 12 ساعت" },
  { h: 24, label: "روزی یک بار" },
  { h: 0, label: "فقط وقتی دکمه را بزنم" },
];

const when = (at: string) => {
  const d = new Date(at);
  return `${formatDay(d)}، ساعت ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};
const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);

/** Why a folder got no copy, in words the desk can act on. */
function why(error: string) {
  if (/pg_dump/i.test(error) && /(not found|no such file|cannot find|program not found)/i.test(error)) return "برنامهٔ pg_dump پیدا نشد (بخشی از PostgreSQL است).";
  if (/folder|no such file|cannot find|denied|not ready|path/i.test(error)) return "پوشه پیدا نشد یا قابل نوشتن نیست. اگر USB است، وصل است؟";
  return "پشتیبان گرفته نشد.";
}

/**
 * Backups of the whole database (partners): a copy on this laptop, and a second one on a
 * USB stick or a network folder, taken on a schedule and whenever the button is pressed.
 */
export function Backup() {
  const [s, setS] = useState<BackupStatus | null>(null);
  const [folders, setFolders] = useState<[string, string]>(["", ""]);
  const [every, setEvery] = useState(24);
  const [keep, setKeep] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.backup().then((b) => {
      setS(b);
      setFolders([b.plan.folders[0] ?? "", b.plan.folders[1] ?? ""]);
      setEvery(b.plan.every_hours);
      setKeep(String(b.plan.keep));
    }).catch((e) => setError(errorText(e)));
  }, [tick]);

  async function save() {
    setError("");
    try {
      await api.setBackupPlan({ folders: folders.filter((f) => f.trim()), every_hours: every, keep: Number(keep) });
      setSaved(true);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function now() {
    setBusy(true);
    setError("");
    try { await api.backupNow(); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  if (!s) return error ? <p className="form-error">{error}</p> : <p className="muted">در حال بارگذاری…</p>;
  return (
    <div className="page">
      <section className="panel wide">
        <h2>آخرین پشتیبان</h2>
        <LastOutcome last={s.last} />
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions"><button className="btn big" disabled={busy} onClick={() => void now()}>{busy ? "در حال پشتیبان‌گیری…" : "پشتیبان بگیر، همین حالا"}</button></div>
      </section>

      <section className="panel wide">
        <h2>کجا و هر چند وقت</h2>
        <p className="muted">
          نسخهٔ اول روی همین لپ‌تاپ می‌ماند. برای وقتی که لپ‌تاپ خراب یا گم شود، پوشهٔ دوم را روی USB یا کمپیوتر دیگر بگذارید
          (مثلاً <bdi dir="ltr">E:\Pezhohesh</bdi>). اگر USB وصل نباشد، نسخهٔ اول باز هم گرفته می‌شود.
        </p>
        <div className="form-grid">
          <label className="field wide span-2"><span>پوشهٔ اول (همین لپ‌تاپ) *</span><input dir="ltr" value={folders[0]} onChange={(e) => { setSaved(false); setFolders([e.target.value, folders[1]]); }} /></label>
          <label className="field wide span-2"><span>پوشهٔ دوم (USB یا شبکه)</span><input dir="ltr" value={folders[1]} onChange={(e) => { setSaved(false); setFolders([folders[0], e.target.value]); }} placeholder="E:\Pezhohesh" /></label>
          <label className="field wide">
            <span>پشتیبان خودکار</span>
            <select value={every} onChange={(e) => { setSaved(false); setEvery(Number(e.target.value)); }}>
              {EVERY.map((o) => <option key={o.h} value={o.h}>{o.label}</option>)}
              {!EVERY.some((o) => o.h === every) && <option value={every}>هر {every} ساعت</option>}
            </select>
          </label>
          <label className="field wide">
            <span>چند نسخهٔ آخر بماند</span>
            <input dir="ltr" inputMode="numeric" value={keep} onChange={(e) => { setSaved(false); setKeep(e.target.value.replace(/\D/g, "").slice(0, 3)); }} />
          </label>
        </div>
        {saved && <p className="form-ok" role="status">ذخیره شد.</p>}
        <div className="actions"><button className="btn" disabled={!folders[0].trim() || !(Number(keep) >= 1 && Number(keep) <= 365)} onClick={() => void save()}>ذخیره</button></div>
      </section>

      <h2>پشتیبان‌های پوشهٔ اول</h2>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>فایل</th><th>زمان</th><th>اندازه</th></tr></thead>
          <tbody>
            {s.files.map((f) => (
              <tr key={f.name}>
                <td><bdi dir="ltr">{f.name}</bdi></td>
                <td>{f.modified ? when(f.modified) : "—"}</td>
                <td className="num"><bdi dir="ltr">{size(f.size)}</bdi></td>
              </tr>
            ))}
          </tbody>
        </table>
        {!s.files.length && <p className="muted empty">هنوز پشتیبانی در این پوشه نیست.</p>}
      </div>
      <p className="muted small">
        برای برگرداندن یک پشتیبان (مثلاً بعد از خرابی لپ‌تاپ) به من خبر بدهید؛ برگرداندن همهٔ اطلاعات فعلی را جایگزین می‌کند، پس با هم انجامش می‌دهیم.
      </p>
    </div>
  );
}

function LastOutcome({ last }: { last: BackupOutcome | null }) {
  if (!last?.at) return <p className="form-error">هنوز هیچ پشتیبانی گرفته نشده.</p>;
  return (
    <>
      <p className={last.ok ? "form-ok" : "form-error"}>
        {!last.ok ? "پشتیبان گرفته نشد" : last.folders.some((f) => f.error) ? "پشتیبان فقط در بعضی پوشه‌ها گرفته شد" : "پشتیبان گرفته شد"}: {when(last.at)}
      </p>
      <ul className="backup-folders">
        {last.folders.map((f) => (
          <li key={f.folder}>
            <bdi dir="ltr">{f.folder}</bdi>
            {f.error ? <span className="form-error inline"> {why(f.error)} <small dir="ltr">({f.error})</small></span> : <span className="muted"> ✓</span>}
          </li>
        ))}
      </ul>
    </>
  );
}
