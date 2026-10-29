import { useEffect, useState } from "react";
import { api, type SyncStatus } from "../lib/api";

type Tone = "good" | "warn" | "bad";

/** What the chip says: the worst thing first (error, clock, problems, then waiting). */
export function syncState(s: SyncStatus, unknown: boolean): [Tone, string] {
  if (unknown) return ["bad", "وضع سرور معلوم نیست"];
  if (s.mode === "paused") return ["bad", "جدا از سرور · چیزی به سرور نمی‌رود"];
  if (s.error === "no_internet") return ["warn", s.waiting ? `بی‌اینترنت · ${s.waiting} تغییر منتظر` : "بی‌اینترنت · کار ادامه دارد"];
  if (s.error) return ["bad", "همگام‌سازی نشد"];
  if (s.clock_off_minutes !== null) return ["bad", `ساعت کمپیوتر ${Math.abs(s.clock_off_minutes)} دقیقه فرق دارد`];
  if (s.problems) return ["bad", `${s.problems} تغییر ثبت نشد`];
  if (s.waiting) return ["warn", `${s.waiting} تغییر در حال فرستادن`];
  return ["good", s.mode === "online" ? "روی سرور مرکزی" : "همگام با سرور"];
}

const ago = (at: string) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(at).getTime()) / 60000));
  return min < 1 ? "همین حالا" : `${min} دقیقه پیش`;
};

/**
 * In the side bar, once the computers share the server: is this computer in step with it,
 * and how many changes still wait to go out. Checked every 20 seconds; when a check fails
 * the last state stays and the chip says the state is not known.
 */
export function SyncChip({ onOpen }: { onOpen?: () => void }) {
  const [s, setS] = useState<SyncStatus | null>(null);
  const [unknown, setUnknown] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () => api.sync().then((x) => { if (live) { setS(x); setUnknown(false); } }, () => live && setUnknown(true));
    void load();
    const t = window.setInterval(load, 20_000);
    window.addEventListener("sync-changed", load);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("sync-changed", load); };
  }, []);
  if (!s || s.mode === "off") return null;

  const [tone, text] = syncState(s, unknown);
  const title = s.mode === "node" && s.ok_at ? `آخرین همگام‌سازی: ${ago(s.ok_at)}` : "سرور مرکزی";
  const body = (
    <>
      <span className="dot" aria-hidden="true" />
      <span>{text}</span>
    </>
  );
  return (
    <>
      {onOpen
        ? <button className={`sync-chip ${tone}`} onClick={onOpen} title={title} aria-label={`سرور مرکزی: ${text}`}>{body}</button>
        : <div className={`sync-chip ${tone}`} title={title}>{body}</div>}
      {/* Its words change only when the state does, so it is read out only then. */}
      <span className="sr-only" role="status" aria-live="polite">{text}</span>
    </>
  );
}
