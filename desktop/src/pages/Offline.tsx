import { useEffect, useRef, useState } from "react";
import { AuthCard } from "./Login";
import { apiLog, canFixPostgres, fixPostgres, health, postgresService, restartApi, setDatabasePassword, type Health, type PgService } from "../lib/core";

type Diag = { health: Health | null; service: PgService | null; log: string };

/**
 * Shown while the app cannot reach a working core. It finds out which part is down, fixes
 * what it can by itself (starts the API or PostgreSQL again), says exactly what is wrong
 * otherwise, and goes on by itself as soon as everything answers.
 */
export function Offline({ onRetry, loading }: { onRetry: () => void; loading: boolean }) {
  const [diag, setDiag] = useState<Diag | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixError, setFixError] = useState("");
  const [password, setPassword] = useState("");
  const [saving, setSaving] = useState(false);
  const [triedAt, setTriedAt] = useState(0);
  const retry = useRef(onRetry);
  retry.current = onRetry;

  useEffect(() => {
    if (loading) return;
    let stop = false;
    let timer = 0;
    async function look() {
      const h = await health();
      if (stop) return;
      if (h?.database) return retry.current();
      // Not answering at all, or PostgreSQL stopped: start whichever is down, where Windows allows it.
      if (!h || h.problem === "postgres_down") await restartApi();
      const [service, log] = await Promise.all([postgresService(), apiLog()]);
      if (stop) return;
      setDiag({ health: h, service, log });
      timer = window.setTimeout(() => void look(), 2500);
    }
    void look();
    return () => { stop = true; clearTimeout(timer); };
  }, [loading]);

  async function fix() {
    setFixing(true);
    setFixError("");
    try {
      await fixPostgres();
    } catch (e) {
      setFixError(String(e) === "cancelled"
        ? "اجازه داده نشد. دوباره دکمه را بزنید و در پنجرهٔ ویندوز «Yes» را انتخاب کنید."
        : "PostgreSQL روشن نشد. کمپیوتر را یک بار ری‌استارت کنید؛ اگر باز هم نشد، جزئیات زیر را برای پشتیبانی بفرستید.");
    } finally {
      setFixing(false);
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFixError("");
    try {
      await setDatabasePassword(password);
      setPassword("");
      setTriedAt(Date.now());
    } catch {
      setFixError("رمز ذخیره نشد. برنامه را ببندید و دوباره باز کنید.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <AuthCard title="در حال وصل شدن…" subtitle="چند لحظه صبر کنید." >{null}</AuthCard>;

  const e = explain(diag);
  const detail = [diag?.health?.detail, diag?.log].filter(Boolean).join("\n\n");
  return (
    <AuthCard title={e.title} subtitle={e.text}>
      {fixError && <p className="form-error" role="alert">{fixError}</p>}
      {diag?.health?.problem === "db_login" && canFixPostgres() && (
        <form className="auth-form" onSubmit={(ev) => void savePassword(ev)}>
          {triedAt > 0 && <p className="form-error" role="alert">با این رمز هم وصل نشد. رمزی را بنویسید که هنگام نصب PostgreSQL گذاشتید.</p>}
          <label className="field">
            <span>رمز PostgreSQL (کاربر postgres)</span>
            <input type="password" dir="ltr" autoComplete="off" value={password} onChange={(ev) => setPassword(ev.target.value)} autoFocus />
          </label>
          <button className="btn big" disabled={saving || !password}>{saving ? "در حال ذخیره…" : "ذخیره و وصل شدن"}</button>
          <p className="muted small">رمز فقط روی همین لپ‌تاپ، در تنظیمات برنامه، نگه داشته می‌شود.</p>
        </form>
      )}
      {e.fix && canFixPostgres() && (
        <button className="btn big" onClick={() => void fix()} disabled={fixing}>
          {fixing ? "در حال روشن کردن…" : "روشن کردن PostgreSQL"}
        </button>
      )}
      <button className={e.fix ? "btn ghost" : "btn big"} onClick={onRetry}>دوباره امتحان کن</button>
      <p className="muted small">برنامه هر چند ثانیه خودش دوباره امتحان می‌کند و به محض درست شدن، ادامه می‌دهد.</p>
      {diag?.health?.problem === "postgres_down" && (
        <details className="offline-details">
          <summary>روشن کردن دستی PostgreSQL</summary>
          <ol>
            <li>کلید Windows و R را با هم بزنید، بنویسید services.msc و Enter بزنید.</li>
            <li>سرویس <bdi dir="ltr">{diag.service?.name ?? "postgresql-x64-…"}</bdi> را پیدا کنید و دوبار کلیک کنید.</li>
            <li>Startup type را Automatic بگذارید، Start و بعد OK را بزنید.</li>
          </ol>
        </details>
      )}
      {detail && (
        <details className="offline-details">
          <summary>جزئیات برای پشتیبانی</summary>
          <pre dir="ltr">{detail}</pre>
        </details>
      )}
    </AuthCard>
  );
}

function explain(d: Diag | null): { title: string; text: string; fix?: boolean } {
  if (!d) return { title: "در حال بررسی…", text: "چند لحظه صبر کنید." };
  const h = d.health;
  if (!h) {
    return {
      title: "هستهٔ برنامه اجرا نمی‌شود",
      text: "برنامه دارد دوباره روشنش می‌کند. اگر چند دقیقه درست نشد، برنامه را ببندید و دوباره باز کنید.",
    };
  }
  switch (h.problem) {
    case "postgres_down":
      if (!d.service) {
        return canFixPostgres()
          ? { title: "دیتابیس (PostgreSQL) جواب نمی‌دهد", text: "سرویس PostgreSQL روی این کمپیوتر پیدا نشد. مطمئن شوید PostgreSQL نصب و روشن است." }
          : { title: "دیتابیس (PostgreSQL) جواب نمی‌دهد", text: "PostgreSQL را روشن کنید." };
      }
      if (d.service.pending) return { title: "PostgreSQL در حال روشن شدن است…", text: "چند لحظه صبر کنید؛ برنامه خودش وصل می‌شود." };
      if (!d.service.running) {
        return {
          title: "دیتابیس (PostgreSQL) خاموش است",
          text: "دکمهٔ زیر را بزنید و وقتی ویندوز اجازه خواست «Yes» را بزنید. همین یک بار کافی است: بعد از این PostgreSQL با ویندوز خودش روشن می‌شود و اگر خاموش شد، برنامه بدون پرسیدن روشنش می‌کند.",
          fix: true,
        };
      }
      return { title: "PostgreSQL روشن است ولی جواب نمی‌دهد", text: "برنامه دوباره امتحان می‌کند. اگر درست نشد، کمپیوتر را یک بار ری‌استارت کنید." };
    case "db_login":
      return {
        title: "رمز دیتابیس درست نیست",
        text: canFixPostgres()
          ? "رمزی را که هنگام نصب PostgreSQL برای کاربر postgres گذاشتید، این‌جا بنویسید. برنامه آن را نگه می‌دارد و دوباره وصل می‌شود."
          : "رمز PostgreSQL که در تنظیمات برنامه (فایل database-url.txt) نوشته شده، با رمز خود PostgreSQL یکی نیست.",
      };
    case "migration":
      return { title: "به‌روزرسانی دیتابیس انجام نشد", text: "نسخهٔ جدید نتوانست جدول‌های دیتابیس را به‌روز کند. هیچ اطلاعاتی پاک نشده است. جزئیات زیر را برای پشتیبانی بفرستید." };
    case "starting":
      return { title: "در حال آماده شدن…", text: "هستهٔ سیستم دارد دیتابیس را آماده می‌کند." };
    case "restoring":
      return { title: "در حال برگرداندن از پشتیبان…", text: "دیتابیس دارد از پشتیبان برگردانده می‌شود. بعد برنامه خودش دوباره وصل می‌شود؛ لطفاً دوباره وارد شوید." };
    default:
      return { title: "دیتابیس خطا داد", text: "برنامه خودش دوباره امتحان می‌کند. اگر درست نشد، جزئیات زیر را برای پشتیبانی بفرستید." };
  }
}
