import { useEffect, useState } from "react";
import { api, errorText, type BackupOutcome, type BackupStatus, type OnlineStatus, type RestorePoint, type SyncProblem, type SyncServerState, type SyncStatus } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { Modal } from "../components/Modal";
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

type RestoreTab = "all" | "folder" | "usb" | "gdrive" | "monthly";
const RESTORE_TABS: { id: RestoreTab; label: string; has: (p: RestorePoint) => boolean }[] = [
  { id: "all", label: "همه، به ترتیب تاریخ", has: () => true },
  { id: "folder", label: "کمپیوتر", has: (p) => p.kind === "folder" && !p.monthly },
  { id: "usb", label: "فلش", has: (p) => p.kind === "usb" && !p.monthly },
  { id: "gdrive", label: "گوگل درایو", has: (p) => p.kind === "gdrive" && !p.monthly },
  { id: "monthly", label: "ماهانه", has: (p) => p.monthly },
];

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
      setKeep(String(b.plan.keep_days));
    }).catch((e) => setError(errorText(e)));
  }, [tick]);

  // Every change is saved at once: a folder typed in and then «پشتیبان بگیر» must not be lost.
  type Patch = Partial<{ folders: [string, string]; usb: boolean; gdrive: boolean; every: number; keep: string }>;
  async function persist(p: Patch = {}) {
    const f = p.folders ?? folders;
    const k = Number(p.keep ?? keep);
    if (!f[0].trim()) { setError("پوشهٔ همین لپ‌تاپ را انتخاب کنید."); return false; }
    if (!(k >= 1 && k <= 3650)) { setError("تعداد روزها باید بین 1 و 3650 باشد."); return false; }
    setError("");
    try {
      await api.setBackupPlan({ folders: f.filter((x) => x.trim()), usb: p.usb ?? usb, gdrive: p.gdrive ?? gdrive, every_hours: p.every ?? every, keep_days: k });
      toast("ذخیره شد.");
      setTick((t) => t + 1);
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    }
  }
  const dirty = !!s && (folders[0] !== (s.plan.folders[0] ?? "") || folders[1] !== (s.plan.folders[1] ?? "") || keep !== String(s.plan.keep_days));
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
  if (s.online_only) {
    return (
      <div className="page">
        <section className="panel wide">
          <h2>پشتیبان</h2>
          <p className="muted">
            این کمپیوتر مستقیم روی سرور مرکزی کار می‌کند و دیتابیس خودش را ندارد، پس این‌جا چیزی برای پشتیبان گرفتن نیست.
            پشتیبان‌ها را کمپیوتر قرائت‌خانه می‌گیرد (روی خودش، فلش و گوگل درایو)، و همه چیز روی سرور هم هست.
          </p>
        </section>
        <Sync />
      </div>
    );
  }
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
            <span>پشتیبان‌های چند روز اخیر بماند</span>
            <input dir="ltr" inputMode="numeric" value={keep} aria-describedby="keep-hint" onChange={(e) => setKeep(e.target.value.replace(/\D/g, "").slice(0, 4))}
              onBlur={() => { if (dirty) void persist(); }} />
            <small id="keep-hint" className="muted">پشتیبان‌های قدیمی‌تر پاک می‌شوند. آخرین پشتیبان هر ماه در پوشهٔ «ماهانه» برای همیشه می‌ماند.</small>
          </label>
        </div>
        {dirty && <div className="actions"><button className="btn" onClick={() => void persist()}>ذخیره</button></div>}
      </section>

      <Sync />

      <Online />

      <Restore refresh={tick} />
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

/** Typed on any keyboard: Arabic ي and ك count as the Persian ی and ک. */
function sameWord(typed: string, word: string) {
  const norm = (t: string) => t.trim().replace(/\u064A/g, "\u06CC").replace(/\u0643/g, "\u06A9").replace(/\u200C/g, "");
  return norm(typed) === norm(word);
}

const TABLE_LABEL: Record<string, string> = {
  members: "اعضا", memberships: "دوره‌های عضویت", receipts: "بل‌ها", expenses: "مصارف", expense_categories: "دستهٔ مصارف",
  withdrawals: "برداشت‌ها", salary_accruals: "معاش‌ها", staff: "کارمندان", books: "کتاب‌ها", book_loans: "امانت کتاب",
  loan_deposits: "ضمانت‌ها", hotspot_cards: "کارت هاتسپات", hotspot_buys: "خرید هاتسپات", hotspot_sales: "فروش هاتسپات",
  hotspot_purchases: "خرید هاتسپات", plans: "قیمت‌ها", settings: "تنظیمات", app_users: "کاربران", devices: "کمپیوترها",
  member_documents: "عکس و تذکره", month_summaries: "خلاصهٔ ماه‌ها", partner_shares: "سهم شرکا", attendance: "حاضری",
  pec_clients: "خدمات تحصیلی", pec_contracts: "خدمات تحصیلی", pec_services: "خدمات تحصیلی", import_batches: "ورود از اکسل",
};

/** What a sync error means for the desk. */
export function syncWhy(error: string) {
  if (error === "no_internet") return "اینترنت وصل نیست. کار عادی ادامه دارد؛ تغییرها وقتی اینترنت آمد فرستاده می‌شوند.";
  if (error === "hub_not_ready") return "همگام‌سازی روی سرور شروع نشده.";
  if (error.startsWith("hub_migration")) return "جدول‌های سرور تازه نشدند.";
  if (/password|authentication/i.test(error)) return "سرور رمز را قبول نکرد. آدرس سرور را دوباره بدهید.";
  return "همگام‌سازی نشد.";
}

/** The central server: all computers share one set of data through it. */
function Sync() {
  const toast = useToast();
  const [s, setS] = useState<SyncStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [ask, setAsk] = useState<"start" | "online" | "local" | null>(null);
  const [name, setName] = useState("");
  const [typed, setTyped] = useState("");
  const [server, setServer] = useState<SyncServerState | null>(null);

  useEffect(() => {
    let live = true;
    const load = () => api.sync().then((x) => live && setS(x), (e) => live && setError(errorText(e)));
    void load();
    const t = window.setInterval(load, 15_000);
    return () => { live = false; window.clearInterval(t); };
  }, [tick]);

  async function act(f: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError("");
    try {
      await f();
      setAsk(null);
      toast(ok);
      setTick((t) => t + 1);
      window.dispatchEvent(new Event("sync-changed"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (!s) return error ? <p className="form-error">{error}</p> : null;
  const d = s.device;
  return (
    <section className="panel wide">
      <h2>سرور مرکزی (همگام‌سازی)</h2>
      {s.mode === "off" && (
        <>
          <p className="muted">
            با سرور مرکزی، همهٔ کمپیوترها یک اطلاعات مشترک دارند. کمپیوتر قرائت‌خانه بی‌اینترنت هم کار می‌کند و هر وقت اینترنت آمد،
            تغییرهایش را می‌فرستد و تغییرهای دیگران را می‌گیرد. لپ‌تاپ شرکا مستقیم روی سرور کار می‌کند.
          </p>
          {!s.host && <p className="form-error">اول آدرس سرور را در بخش «نسخهٔ آنلاین» پایین همین صفحه بدهید.</p>}
          <div className="actions">
            <button className="btn" disabled={!s.host || busy} onClick={() => {
              setAsk("start"); setTyped(""); setError(""); setServer(null);
              api.syncServer().then(setServer, (e) => setError(errorText(e)));
            }}>شروع با همین کمپیوتر…</button>
            <button className="btn ghost" disabled={!s.host || busy} onClick={() => { setAsk("online"); setError(""); }}>این کمپیوتر مستقیم روی سرور کار کند…</button>
          </div>
        </>
      )}
      {s.mode === "node" && (
        <>
          <p className="muted">این کمپیوتر بی‌اینترنت هم کار می‌کند و تغییرهایش را به سرور <bdi dir="ltr">{s.host}</bdi> می‌فرستد.</p>
          <SyncLine s={s} />
          <div className="actions">
            <button className="btn ghost" disabled={busy} onClick={() => void act(() => api.syncNow(), "همگام شد.")}>{busy ? "در حال همگام‌سازی…" : "همین حالا همگام کن"}</button>
          </div>
        </>
      )}
      {s.mode === "online" && (
        <>
          <p className="muted">این کمپیوتر مستقیم روی سرور <bdi dir="ltr">{s.host}</bdi> کار می‌کند. بی‌اینترنت، برنامه تا وصل شدن دوباره صبر می‌کند.</p>
          <div className="actions">
            {s.local_db && <button className="btn ghost" disabled={busy} onClick={() => setAsk("local")}>برگشت به دیتابیس خود این کمپیوتر…</button>}
          </div>
        </>
      )}
      {s.mode === "paused" && (
        <>
          <p className="notice warn">
            این کمپیوتر فعلاً جدا از سرور، روی دیتابیس خودش کار می‌کند. هر چه این‌جا ثبت شود فقط روی همین کمپیوتر می‌ماند و به سرور نمی‌رود.
            وقتی اینترنت آمد، دوباره به سرور وصل شوید.
          </p>
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => void act(() => api.syncResume(), "برنامه چند لحظه دوباره شروع می‌شود و به سرور وصل می‌شود.")}>دوباره روی سرور کار کن</button>
          </div>
        </>
      )}
      {d && s.mode !== "off" && s.mode !== "paused" && (
        <p className="muted small">
          این کمپیوتر: <b>{d.name}</b> · حرف بل‌ها: <b dir="ltr">{d.receipt_prefix}</b>
          {d.member_no_from !== null && <> · شمارهٔ عضوهای تازه از <bdi dir="ltr">{d.member_no_from}</bdi> تا <bdi dir="ltr">{d.member_no_to}</bdi></>}
        </p>
      )}
      {error && !ask && <p className="form-error" role="alert">{error}</p>}

      {ask === "start" && (
        <Modal label="شروع همگام‌سازی" onClose={() => !busy && setAsk(null)}>
          <h2>شروع با همین کمپیوتر</h2>
          <p>همهٔ اطلاعات این کمپیوتر به سرور فرستاده می‌شود و از این به بعد هر تغییری این‌جا، به سرور هم می‌رود.</p>
          {!server && !error && <p className="muted">در حال پرسیدن از سرور…</p>}
          {server?.state === "hub" && (
            <p className="notice bad">
              روی این سرور همگام‌سازی از قبل روشن است ({server.devices.join("، ")}). این کار فقط یک بار انجام می‌شود و دوباره زدنش ممکن نیست.
            </p>
          )}
          {server && server.state !== "hub" && (
            <div className="notice warn">
              <p><b>فقط روی کمپیوتر قرائت‌خانه</b>، که همهٔ اطلاعات را دارد. این کمپیوتر: {server.here_members} عضو.</p>
              {server.state === "copy"
                ? <p>روی سرور یک نسخهٔ آنلاین قدیمی با {server.server_members ?? "?"} عضو هست. اطلاعات این کمپیوتر جای آن را می‌گیرد.</p>
                : <p>سرور خالی است.</p>}
            </div>
          )}
          {server && server.state !== "hub" && (
            <label className="field">
              <span>برای اطمینان بنویسید: <b>شروع</b></span>
              <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
            </label>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="actions">
            {server && server.state !== "hub" && (
              <button className="btn danger" disabled={busy || sameWord(typed, "شروع") === false} onClick={() => void act(() => api.syncStart(), "اطلاعات به سرور رفت. همگام‌سازی روشن شد.")}>
                {busy ? "در حال فرستادن…" : "شروع و فرستادن به سرور"}
              </button>
            )}
            <button className="btn ghost" disabled={busy} onClick={() => setAsk(null)}>لغو</button>
          </div>
        </Modal>
      )}
      {ask === "online" && (
        <Modal label="کار مستقیم روی سرور" onClose={() => !busy && setAsk(null)}>
          <h2>این کمپیوتر مستقیم روی سرور کار کند</h2>
          <p>برنامه دوباره شروع می‌شود و از این به بعد اطلاعات سرور را نشان می‌دهد. اطلاعات خود این کمپیوتر دست نمی‌خورد و می‌شود بعداً به آن برگشت.</p>
          <p className="muted small">این کمپیوتر حرف بل جدا و شمارهٔ عضو جدا می‌گیرد، تا با هیچ کمپیوتر دیگری تکراری نشود. بی‌اینترنت کار نمی‌کند.</p>
          <label className="field">
            <span>نام این کمپیوتر</span>
            <input value={name} placeholder="مثلاً لپ‌تاپ ناصری" onChange={(e) => setName(e.target.value)} autoFocus />
            <small className="muted">در «چه کسی چه کرد» کنار هر تغییر این کمپیوتر دیده می‌شود.</small>
          </label>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn" disabled={busy || !name.trim()} onClick={() => void act(() => api.syncGoOnline(name.trim()), "وصل شد. برنامه چند لحظه دوباره شروع می‌شود؛ بعد دوباره وارد شوید.")}>
              {busy ? "در حال وصل شدن…" : "وصل شو"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setAsk(null)}>لغو</button>
          </div>
        </Modal>
      )}
      {ask === "local" && (
        <Modal label="برگشت به دیتابیس این کمپیوتر" onClose={() => !busy && setAsk(null)}>
          <h2>برگشت به دیتابیس خود این کمپیوتر</h2>
          <p>برنامه دوباره شروع می‌شود و اطلاعاتی را نشان می‌دهد که پیش از وصل شدن روی همین کمپیوتر بود. چیزی روی سرور پاک نمی‌شود.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn" disabled={busy} onClick={() => void act(() => api.syncGoLocal(), "برنامه چند لحظه دوباره شروع می‌شود.")}>برگرد</button>
            <button className="btn ghost" disabled={busy} onClick={() => setAsk(null)}>لغو</button>
          </div>
        </Modal>
      )}
    </section>
  );
}

/** The last round, what waits, and problems, in one line. */
function SyncLine({ s }: { s: SyncStatus }) {
  const [list, setList] = useState<SyncProblem[] | null>(null);
  const [seen, setSeen] = useState(false);
  return (
    <>
      <p className={s.error ? "form-error" : "form-ok"}>
        {s.error ? syncWhy(s.error) : s.ok_at ? <>همگام است. آخرین بار: {when(s.ok_at)}</> : "هنوز همگام نشده."}
      </p>
      {s.error && (
        <details className="offline-details">
          <summary>جزئیات برای پشتیبانی</summary>
          <pre dir="ltr">{s.error}</pre>
        </details>
      )}
      {s.clock_off_minutes !== null && (
        <p className="form-error">
          ساعت این کمپیوتر با سرور {Math.abs(s.clock_off_minutes)} دقیقه {s.clock_off_minutes > 0 ? "جلوتر" : "عقب‌تر"} است.
          تاریخ بل‌ها و دوره‌ها از همین ساعت گرفته می‌شود؛ ساعت و تاریخ ویندوز را درست کنید.
        </p>
      )}
      {(s.waiting > 0 || (s.problems > 0 && !seen)) && (
        <p className="muted small">
          {s.waiting > 0 && <>{s.waiting} تغییر منتظر فرستادن است. </>}
          {s.problems > 0 && !seen && (
            <>
              <span className="form-error inline">{s.problems} تغییر از کمپیوترهای دیگر اینجا ثبت نشد.</span>{" "}
              <button className="btn ghost small" onClick={() => void api.syncProblems().then(setList, () => setList([]))}>دیدن</button>
            </>
          )}
        </p>
      )}
      {list && (
        <Modal label="تغییرهایی که ثبت نشد" onClose={() => setList(null)}>
          <h2>تغییرهایی که ثبت نشد</h2>
          <p className="muted small">
            معمولاً یعنی دو کمپیوتر هم‌زمان یک چیز تکراری ساخته‌اند (مثلاً یک نام دسته با دو شکل). همان مورد را در برنامه بررسی و با دست درست کنید،
            بعد «درست شد» را بزنید.
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>زمان</th><th>بخش</th><th>علت</th><th><span className="sr-only">کارها</span></th></tr></thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>{when(p.at)}</td>
                    <td>{(p.tbl && TABLE_LABEL[p.tbl]) ?? p.tbl ?? "—"}</td>
                    <td>
                      {p.error === "hub_refused" ? "سرور این تغییرِ این کمپیوتر را نپذیرفت."
                        : p.error.startsWith("23505") ? "همین چیز در کمپیوتر دیگری هم ساخته شده (تکراری)."
                        : "این تغییر این‌جا نوشته نشد."}
                      <details><summary className="muted small">جزئیات</summary><small dir="ltr">{p.error}</small></details>
                    </td>
                    <td><button className="btn ghost small" onClick={() => void api.syncProblemsSeen(p.id).then(() => setList((l) => l && l.filter((x) => x.id !== p.id)))}>درست شد</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn ghost" onClick={() => { if (list.length === 0) setSeen(true); setList(null); window.dispatchEvent(new Event("sync-changed")); }}>بستن</button>
          </div>
        </Modal>
      )}
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
  const [shared, setShared] = useState(false);
  const [every, setEvery] = useState(6);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.online().then((o) => { setS(o); setEvery(o.every_hours); }).catch((e) => setError(errorText(e)));
    api.sync().then((x) => setShared(x.mode !== "off"), () => {});
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
      <h2>{shared ? "آدرس سرور (Neon)" : "نسخهٔ آنلاین (Neon)"}</h2>
      {shared ? (
        <p className="muted">همگام‌سازی روشن است و کپی کامل دیگر فرستاده نمی‌شود. اینجا فقط آدرس سرور است.</p>
      ) : (
        <p className="muted">
          اصل اطلاعات روی همین لپ‌تاپ است. هر چند ساعت یک کپی کامل به Neon (اینترنت) فرستاده می‌شود، تا بیرون از دفتر هم در دسترس باشد.
          عکس‌ها و تذکره‌ها فرستاده نمی‌شوند.
        </p>
      )}
      <p>{s.host ? <>سرور: <bdi dir="ltr">{s.host}</bdi></> : <span className="form-error">آدرس دیتابیس آنلاین هنوز داده نشده.</span>}</p>
      {!shared && last?.at && (
        <p className={last.ok ? "form-ok" : "form-error"}>
          {last.ok ? "آخرین کپی فرستاده شد" : "آخرین کپی فرستاده نشد"}: {when(last.at)}
          {!last.ok && last.error && <> · {onlineWhy(last.error)} <small dir="ltr">({last.error})</small></>}
        </p>
      )}
      <div className="form-grid">
        <label className="field wide" hidden={shared}>
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
        {!shared && <button className="btn ghost" disabled={busy || !s.host} onClick={() => void now()}>{busy ? "در حال فرستادن…" : "همین حالا بفرست"}</button>}
      </div>
    </section>
  );
}

const WORD = "برگرداندن";

/**
 * Bringing everything back from a backup: the database, and the photos and scans in the
 * backup's files folder. A fresh backup of things as they are now is taken first, so a
 * restore of the wrong file can itself be undone.
 */
function Restore({ refresh }: { refresh: number }) {
  const { signOut } = useAuth();
  const [points, setPoints] = useState<RestorePoint[] | null>(null);
  const [all, setAll] = useState(false);
  const [tab, setTab] = useState<RestoreTab>("all");
  const [chosen, setChosen] = useState<RestorePoint | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => { api.restorePoints().then(setPoints, () => setPoints([])); }, [refresh]);

  async function restore() {
    if (!chosen) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.restore(chosen.path);
      setDone(r.before);
      // The core restarts with the restored database; everyone signs in again.
      window.setTimeout(() => void signOut(), 6000);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const inTab = (points ?? []).filter(RESTORE_TABS.find((t) => t.id === tab)!.has);
  const shown = all ? inTab : inTab.slice(0, 8);
  return (
    <>
      <h2>برگرداندن از پشتیبان</h2>
      <p className="muted small">
        همهٔ پشتیبان‌های پوشه‌ها، فلش و گوگل درایو، تازه‌ترین بالا. برگرداندن، دیتابیس و عکس‌ها را همان‌طور می‌کند که در آن پشتیبان بود؛
        هر چه بعد از آن ثبت شده از برنامه برداشته می‌شود. پیش از برگرداندن، خود برنامه یک پشتیبان تازه از وضع فعلی می‌گیرد تا اگر اشتباه شد، آن هم برگردد.
      </p>
      <div className="segmented" role="tablist" aria-label="کدام پشتیبان‌ها">
        {RESTORE_TABS.map((t) => {
          const n = (points ?? []).filter(t.has).length;
          return (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => { setTab(t.id); setAll(false); }}>
              {t.label}{points && <span className="muted small"> {n}</span>}
            </button>
          );
        })}
      </div>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>زمان</th><th>کجا</th><th>اندازه</th><th><span className="sr-only">کارها</span></th></tr></thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.path}>
                <td>{p.modified ? when(p.modified) : "—"}<div className="muted small"><bdi dir="ltr">{p.name}</bdi></div></td>
                <td>{KIND_LABEL[p.kind]}{p.monthly && <> <span className="chip">ماهانه</span></>}<div className="muted small"><bdi dir="ltr">{p.folder}</bdi></div></td>
                <td className="num"><bdi dir="ltr">{size(p.size)}</bdi></td>
                <td><button className="btn ghost small" onClick={() => { setChosen(p); setTyped(""); setError(""); }}>برگرداندن…</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {points && !inTab.length && <p className="muted empty">{points.length ? "در این بخش پشتیبانی نیست." : "هنوز پشتیبانی پیدا نشد."}</p>}
        {!points && <p className="muted empty">در حال خواندن…</p>}
      </div>
      {!all && inTab.length > 8 && <div className="actions"><button className="btn ghost small" onClick={() => setAll(true)}>همه ({inTab.length})</button></div>}

      {chosen && (
        <Modal label="برگرداندن از پشتیبان" onClose={() => !busy && !done && setChosen(null)}>
          {done !== null ? (
            <div className="restore-done">
              <h2>برگردانده شد</h2>
              <p>اطلاعات حالا همان است که در پشتیبان {chosen.modified ? when(chosen.modified) : chosen.name} بود. برنامه چند لحظه دوباره وصل می‌شود؛ بعد دوباره وارد شوید.</p>
              {done && <p className="muted small">وضع پیش از برگرداندن هم در این پشتیبان ماند: <bdi dir="ltr">{done}</bdi></p>}
            </div>
          ) : (
            <>
              <h2>برگرداندن پشتیبان {chosen.modified ? when(chosen.modified) : ""}</h2>
              <p>هر چه بعد از این زمان در برنامه ثبت شده (بل، عضو، مصرف…) از برنامه برداشته می‌شود. اول یک پشتیبان از وضع فعلی گرفته می‌شود.</p>
              <label className="field">
                <span>برای اطمینان بنویسید: <b>{WORD}</b></span>
                <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
              </label>
              {error && <p className="form-error" role="alert">{error}</p>}
              <div className="actions">
                <button className="btn danger" disabled={busy || typed.trim() !== WORD} onClick={() => void restore()}>
                  {busy ? "در حال برگرداندن…" : "برگردان"}
                </button>
                <button className="btn ghost" disabled={busy} onClick={() => setChosen(null)}>لغو</button>
              </div>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
