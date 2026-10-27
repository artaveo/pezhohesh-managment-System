import { useEffect, useState } from "react";
import { api, errorText, type BackupOutcome, type BackupStatus, type OnlineStatus } from "../lib/api";
import { formatDay } from "../lib/solar";
import { canPickFolder, pickFolder } from "../lib/savedLogin";
import { useToast } from "../components/Toast";

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

const KIND_LABEL = { folder: "پوشه", usb: "فلش", gdrive: "گوگل درایو" } as const;

/** Why a folder got no copy, in words the desk can act on. */
function why(error: string) {
  if (error === "usb_not_found") return "فلش وصل نبود (فلشی با پوشهٔ Pezhohesh-Backup پیدا نشد).";
  if (error === "gdrive_not_found") return "گوگل درایو روی این لپ‌تاپ پیدا نشد.";
  if (error.startsWith("files:")) return "دیتابیس پشتیبان شد، ولی کپی عکس‌ها و تذکره‌ها کامل نشد.";
  if (/pg_dump/i.test(error) && /(not found|no such file|cannot find|program not found)/i.test(error)) return "برنامهٔ pg_dump پیدا نشد (بخشی از PostgreSQL است).";
  if (/folder|no such file|cannot find|denied|not ready|path/i.test(error)) return "پوشه پیدا نشد یا قابل نوشتن نیست. اگر USB است، وصل است؟";
  return "پشتیبان گرفته نشد.";
}

/**
 * Backups of the whole database (partners): a copy on this laptop, and a second one on a
 * USB stick or a network folder, taken on a schedule and whenever the button is pressed.
 */
export function Backup() {
  const toast = useToast();
  const [s, setS] = useState<BackupStatus | null>(null);
  const [folders, setFolders] = useState<[string, string]>(["", ""]);
  const [usb, setUsb] = useState(true);
  const [gdrive, setGdrive] = useState(true);
  const [every, setEvery] = useState(24);
  const [keep, setKeep] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.backup().then((b) => {
      setS(b);
      setFolders([b.plan.folders[0] ?? "", b.plan.folders[1] ?? ""]);
      setUsb(b.plan.usb);
      setGdrive(b.plan.gdrive);
      setEvery(b.plan.every_hours);
      setKeep(String(b.plan.keep));
    }).catch((e) => setError(errorText(e)));
  }, [tick]);

  // Every change is saved at once: a folder typed in and then «پشتیبان بگیر» must not be lost.
  type Patch = Partial<{ folders: [string, string]; usb: boolean; gdrive: boolean; every: number; keep: string }>;
  async function persist(p: Patch = {}) {
    const f = p.folders ?? folders;
    const k = Number(p.keep ?? keep);
    if (!f[0].trim()) { setError("پوشهٔ همین لپ‌تاپ را انتخاب کنید."); return false; }
    if (!(k >= 1 && k <= 365)) { setError("تعداد نسخه‌ها باید بین 1 و 365 باشد."); return false; }
    setError("");
    try {
      await api.setBackupPlan({ folders: f.filter((x) => x.trim()), usb: p.usb ?? usb, gdrive: p.gdrive ?? gdrive, every_hours: p.every ?? every, keep: k });
      toast("ذخیره شد.");
      setTick((t) => t + 1);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  const dirty = !!s && (folders[0] !== (s.plan.folders[0] ?? "") || folders[1] !== (s.plan.folders[1] ?? "") || keep !== String(s.plan.keep));
  async function choose(i: 0 | 1) {
    const picked = await pickFolder(folders[i] || folders[0]);
    if (!picked) return;
    const next: [string, string] = i === 0 ? [picked, folders[1]] : [folders[0], picked];
    setFolders(next);
    await persist({ folders: next });
  }
  async function prepare(root: string) {
    setError("");
    try { await api.prepareUsb(root); toast(`پشتیبان فلش از این به بعد روی ${root} گرفته می‌شود.`); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); }
  }
  async function now() {
    if (dirty && !(await persist())) return;
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
          نسخهٔ اول روی همین لپ‌تاپ می‌ماند. برای وقتی که لپ‌تاپ خراب یا گم شود، یک نسخه روی فلش و یک نسخه در گوگل درایو هم گرفته می‌شود.
          اگر فلش وصل نباشد، بقیه باز هم گرفته می‌شوند.
        </p>
        <div className="form-grid">
          <FolderField label="پوشهٔ همین لپ‌تاپ *" value={folders[0]} onChange={(v) => setFolders([v, folders[1]])}
            onCommit={() => { if (dirty) void persist(); }} onPick={() => void choose(0)} />
        </div>

        <div className="dest">
          <label className="check big"><input type="checkbox" checked={usb} onChange={(e) => { setUsb(e.target.checked); void persist({ usb: e.target.checked }); }} /> روی فلش هم بگیر</label>
          <p className="muted small">
            درایو فلش یا هارد بیرونی را انتخاب کنید. برنامه آن را به یاد می‌سپارد، حتی اگر دفعهٔ بعد حرف دیگری (E: یا F:) بگیرد.
            {s.usb ? <> پشتیبان فلش الان می‌رود به: <bdi dir="ltr">{s.usb}</bdi></> : s.drives.some((d) => d.picked) ? "" : " هنوز درایوی انتخاب نشده."}
          </p>
          {s.drives.length > 0 ? (
            <ul className="drive-list">
              {s.drives.map((d) => (
                <li key={d.root} className={d.picked ? "picked" : ""}>
                  <bdi dir="ltr"><strong>{d.root}</strong></bdi>
                  <span className="muted small">{d.removable ? "فلش / هارد USB" : "بخشی از دیسک خود لپ‌تاپ"}</span>
                  {d.picked
                    ? <span className="chip">انتخاب شده</span>
                    : <button className="btn ghost small" onClick={() => void prepare(d.root)}>پشتیبان روی این درایو</button>}
                  {!d.removable && !d.picked && <span className="muted small">(اگر لپ‌تاپ خراب شود، این هم از دست می‌رود)</span>}
                </li>
              ))}
            </ul>
          ) : <p className="muted small">فلشی وصل نیست. فلش را وصل کنید و صفحه را دوباره باز کنید.</p>}
          {s.plan.usb_drive && !s.drives.some((d) => d.picked) && (
            <p className="notice warn">درایو انتخاب‌شده (<bdi dir="ltr">{s.plan.usb_drive}</bdi>) الان وصل نیست؛ تا وصل نشود، پشتیبان فلش گرفته نمی‌شود.</p>
          )}
        </div>

        <div className="dest">
          <label className="check big"><input type="checkbox" checked={gdrive} onChange={(e) => { setGdrive(e.target.checked); void persist({ gdrive: e.target.checked }); }} /> در گوگل درایو هم بگیر</label>
          <p className="muted small">
            {s.gdrive
              ? <>گوگل درایو پیدا شد: <bdi dir="ltr">{s.gdrive}</bdi>. فایل‌ها خودشان به حساب گوگل شما بالا می‌روند.</>
              : "برنامهٔ «Google Drive for desktop» روی این لپ‌تاپ پیدا نشد. اول نصبش کنید و با حساب گوگل‌تان وارد شوید."}
          </p>
        </div>

        <div className="form-grid">
          <FolderField label="پوشهٔ دیگر (اختیاری، مثلاً کمپیوتر دیگری در شبکه)" value={folders[1]} placeholder="\\PC2\Pezhohesh"
            onChange={(v) => setFolders([folders[0], v])} onCommit={() => { if (dirty) void persist(); }} onPick={() => void choose(1)} />
          <label className="field wide">
            <span>پشتیبان خودکار</span>
            <select value={every} onChange={(e) => { setEvery(Number(e.target.value)); void persist({ every: Number(e.target.value) }); }}>
              {EVERY.map((o) => <option key={o.h} value={o.h}>{o.label}</option>)}
              {!EVERY.some((o) => o.h === every) && <option value={every}>هر {every} ساعت</option>}
            </select>
          </label>
          <label className="field wide">
            <span>چند نسخهٔ آخر بماند</span>
            <input dir="ltr" inputMode="numeric" value={keep} onChange={(e) => setKeep(e.target.value.replace(/\D/g, "").slice(0, 3))}
              onBlur={() => { if (dirty) void persist(); }} />
          </label>
        </div>
        {dirty && <div className="actions"><button className="btn" onClick={() => void persist()}>ذخیره</button></div>}
      </section>

      <Online />

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

/** A folder: typed, or picked in the Windows folder window («انتخاب پوشه…»). */
function FolderField({ label, value, placeholder, onChange, onCommit, onPick }: {
  label: string; value: string; placeholder?: string;
  onChange: (v: string) => void; onCommit: () => void; onPick: () => void;
}) {
  return (
    <label className="field wide span-2">
      <span>{label}</span>
      <span className="folder-field">
        <input dir="ltr" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(); }} />
        {canPickFolder() && <button type="button" className="btn ghost" onClick={onPick}>انتخاب پوشه…</button>}
      </span>
    </label>
  );
}

function LastOutcome({ last }: { last: BackupOutcome | null }) {
  if (!last?.at) return <p className="form-error">هنوز هیچ پشتیبانی گرفته نشده.</p>;
  return (
    <>
      <p className={last.ok ? "form-ok" : "form-error"}>
        {!last.ok ? "پشتیبان گرفته نشد" : last.folders.some((f) => f.error) ? "پشتیبان گرفته شد، ولی نه در همه‌جا" : "پشتیبان گرفته شد"}: {when(last.at)}
      </p>
      <ul className="backup-folders">
        {last.folders.map((f) => (
          <li key={f.kind + f.folder}>
            <strong>{KIND_LABEL[f.kind ?? "folder"]}</strong>{f.folder && <>: <bdi dir="ltr">{f.folder}</bdi></>}
            {f.error === "usb_not_found" || f.error === "gdrive_not_found" ? <span className="muted"> {why(f.error)}</span>
              : f.error ? <span className="form-error inline"> {why(f.error)} <small dir="ltr">({f.error})</small></span>
              : <span className="muted"> ✓</span>}
          </li>
        ))}
      </ul>
    </>
  );
}

const ONLINE_EVERY = [
  { h: 3, label: "هر 3 ساعت" },
  { h: 6, label: "هر 6 ساعت" },
  { h: 12, label: "هر 12 ساعت" },
  { h: 24, label: "روزی یک بار" },
  { h: 0, label: "خاموش" },
];

/** Why the online copy failed, in words the desk can act on. */
function onlineWhy(error: string) {
  if (error === "not_set") return "آدرس دیتابیس آنلاین هنوز داده نشده.";
  if (/connect|timed out|dns|resolve|network|refused|unreachable/i.test(error)) return "به Neon وصل نشد. اینترنت وصل است؟ ساعت بعد خودش دوباره امتحان می‌کند.";
  if (/password|authentication/i.test(error)) return "Neon رمز را قبول نکرد. آدرس دیتابیس آنلاین را دوباره بدهید.";
  return "کپی آنلاین فرستاده نشد.";
}

/** The copy of the database in Neon: where, how often, and the last result. */
function Online() {
  const [s, setS] = useState<OnlineStatus | null>(null);
  const [every, setEvery] = useState(6);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.online().then((o) => { setS(o); setEvery(o.every_hours); }).catch((e) => setError(errorText(e)));
  }, [tick]);

  async function save() {
    setError("");
    try {
      await api.setOnline({ every_hours: every, ...(url.trim() ? { url: url.trim() } : {}) });
      setUrl("");
      setSaved(true);
      setTick((t) => t + 1);
    } catch (e) {
      setError(errorText(e));
    }
  }
  async function now() {
    setBusy(true);
    setError("");
    try { await api.onlineNow(); setTick((t) => t + 1); } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }

  if (!s) return error ? <p className="form-error">{error}</p> : null;
  const last = s.last;
  return (
    <section className="panel wide">
      <h2>نسخهٔ آنلاین (Neon)</h2>
      <p className="muted">
        اصل اطلاعات روی همین لپ‌تاپ است. هر چند ساعت یک کپی کامل به Neon (اینترنت) فرستاده می‌شود، تا بیرون از دفتر هم در دسترس باشد.
        عکس‌ها و تذکره‌ها فرستاده نمی‌شوند.
      </p>
      <p>{s.host ? <>سرور: <bdi dir="ltr">{s.host}</bdi></> : <span className="form-error">آدرس دیتابیس آنلاین هنوز داده نشده.</span>}</p>
      {last?.at && (
        <p className={last.ok ? "form-ok" : "form-error"}>
          {last.ok ? "آخرین کپی فرستاده شد" : "آخرین کپی فرستاده نشد"}: {when(last.at)}
          {!last.ok && last.error && <> · {onlineWhy(last.error)} <small dir="ltr">({last.error})</small></>}
        </p>
      )}
      <div className="form-grid">
        <label className="field wide">
          <span>ارسال خودکار</span>
          <select value={every} onChange={(e) => { setSaved(false); setEvery(Number(e.target.value)); }}>
            {ONLINE_EVERY.map((o) => <option key={o.h} value={o.h}>{o.label}</option>)}
            {!ONLINE_EVERY.some((o) => o.h === every) && <option value={every}>هر {every} ساعت</option>}
          </select>
        </label>
        <label className="field wide span-2">
          <span>{s.host ? "آدرس تازهٔ دیتابیس آنلاین (فقط برای عوض کردن)" : "آدرس دیتابیس آنلاین"}</span>
          <input dir="ltr" type="password" autoComplete="off" value={url} placeholder="postgresql://…" onChange={(e) => { setSaved(false); setUrl(e.target.value); }} />
        </label>
      </div>
      {saved && <p className="form-ok" role="status">ذخیره شد.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" onClick={() => void save()}>ذخیره</button>
        <button className="btn ghost" disabled={busy || !s.host} onClick={() => void now()}>{busy ? "در حال فرستادن…" : "همین حالا بفرست"}</button>
      </div>
    </section>
  );
}
