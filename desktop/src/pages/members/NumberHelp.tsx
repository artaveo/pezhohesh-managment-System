import { useEffect, useState } from "react";
import { api, type MemberNumbers } from "../../lib/api";
import { Modal } from "../../components/Modal";

const n = (x: number) => new Intl.NumberFormat("en-US", { useGrouping: false }).format(x);

/**
 * Under the ID of a new member: the last ID given, the next one, whether the typed one is
 * free, and the empty IDs in the middle (a click puts one in the form). A safeguard so the
 * desk always knows where the numbering stands.
 */
export function NumberHelp({ value, onPick }: { value: number | null; onPick: (no: number) => void }) {
  const [info, setInfo] = useState<MemberNumbers | null>(null);
  const [gaps, setGaps] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.memberNumbers(value, ctl.signal).then(setInfo).catch(() => {});
    }, 300);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [value]);
  if (!info) return null;
  const c = info.check && info.check.no === value ? info.check : null;
  return (
    <div className="number-help" aria-live="polite">
      <span>آخرین آیدی: <b dir="ltr">{info.last ? n(info.last.no) : "—"}</b>{info.last && <span className="muted"> ({info.last.name})</span>}</span>
      <span>آیدی بعدی: <b dir="ltr">{n(info.next)}</b>{value !== info.next && <> <button type="button" className="btn ghost small" onClick={() => onPick(info.next)}>همین را بگذار</button></>}</span>
      {c && c.state === "member" && <span className="form-error inline">این آیدی مال {c.name} است.</span>}
      {c && c.state === "removed" && <span className="form-error inline">این آیدی هنوز مال {c.name} (حذف‌شده) است؛ اول در «دستگاه انگشت» آزادش کنید.</span>}
      {c && c.state === "device" && <span className="form-error inline">دستگاه انگشت زیر این آیدی کسی دیگر{c.name ? ` (${c.name})` : ""} را دارد.</span>}
      {c && c.state === "free" && value !== info.next && <span className="form-ok inline">این آیدی خالی است.</span>}
      {info.gap_numbers > 0 && <button type="button" className="btn ghost small" onClick={() => setGaps(true)}>آیدی‌های خالی ({n(info.gap_numbers)})</button>}
      {gaps && (
        <Modal label="آیدی‌های خالی" onClose={() => setGaps(false)}>
          <h2>آیدی‌های خالی</h2>
          <p className="muted small">
            آیدی‌هایی که نه عضوی دارد و نه دستگاه انگشت کسی را زیرش دارد، بزرگ‌ترین بالا. روی یکی بزنید تا در فرم بیاید.
            آیدی‌های دیگر هیچ‌وقت جابه‌جا نمی‌شوند.
          </p>
          <ul className="gap-list">
            {info.gaps.map((g) => (
              <li key={g.from}>
                {g.from === g.to ? (
                  <button type="button" className="btn ghost small" dir="ltr" onClick={() => { onPick(g.from); setGaps(false); }}>{n(g.from)}</button>
                ) : (
                  <>
                    <button type="button" className="btn ghost small" dir="ltr" onClick={() => { onPick(g.from); setGaps(false); }}>{n(g.from)}</button>
                    <span className="muted" dir="ltr"> … {n(g.to)}</span>
                    <span className="muted small"> ({n(g.to - g.from + 1)} آیدی)</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          <div className="actions"><button className="btn ghost" onClick={() => setGaps(false)}>بستن</button></div>
        </Modal>
      )}
    </div>
  );
}
