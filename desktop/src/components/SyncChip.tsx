import { useEffect, useState } from "react";
import { api, type SyncStatus } from "../lib/api";

/**
 * In the side bar, once the computers share the server: is this computer in step with it,
 * and how many changes still wait to go out. Checked every 20 seconds.
 */
export function SyncChip({ onOpen }: { onOpen?: () => void }) {
  const [s, setS] = useState<SyncStatus | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.sync().then((x) => live && setS(x), () => live && setS(null));
    void load();
    const t = window.setInterval(load, 20_000);
    return () => { live = false; window.clearInterval(t); };
  }, []);
  if (!s || s.mode === "off") return null;

  const [tone, text] =
    s.mode === "online" ? ["good", "روی سرور مرکزی"]
    : s.error === "no_internet" ? ["warn", s.waiting ? `بی‌اینترنت · ${s.waiting} تغییر منتظر` : "بی‌اینترنت · کار ادامه دارد"]
    : s.error ? ["bad", "همگام‌سازی نشد"]
    : s.waiting ? ["warn", `${s.waiting} تغییر در حال فرستادن`]
    : s.problems ? ["bad", `${s.problems} تغییر ثبت نشد`]
    : ["good", "همگام با سرور"];
  const Tag = onOpen ? "button" : "div";
  return (
    <Tag className={`sync-chip ${tone}`} role="status" onClick={onOpen} title="سرور مرکزی">
      <span className="dot" aria-hidden="true" />
      <span>{text}</span>
    </Tag>
  );
}
