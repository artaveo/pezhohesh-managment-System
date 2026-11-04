import { useState } from "react";
import { api, errorText, k50ErrorText, type K50DateRow, type K50Dates } from "../lib/api";
import { fa, formatDay } from "../lib/solar";
import { useToast } from "./Toast";

/**
 * Membership days from the fingerprint device: the Excel book brings names and money but no
 * days, the device has them. Members with no days in the app get the device's; members whose
 * app days end before the device's (renewed outside the app) get the rest, while it still
 * runs. Shown first, written only when a partner says so. On «دستگاه انگشت» and after an
 * Excel import.
 */
export function DeviceDates({ ready, onDone }: { ready: boolean; onDone?: () => void }) {
  const toast = useToast();
  const [dates, setDates] = useState<K50Dates | null>(null);
  const [withDiffers, setWithDiffers] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function read(commit: boolean, include = withDiffers) {
    setBusy(true);
    setError("");
    try {
      const r = await api.k50Dates(commit, include);
      if (!r.Ok) { setError(k50ErrorText(r.Err)); return; }
      setDates(r.Ok);
      if (r.Ok.committed) {
        toast(`از دستگاه: تاریخ ${fa(r.Ok.added.length)} عضو ثبت و ${fa(r.Ok.extended.length)} عضو تمدید شد.`);
        onDone?.();
      }
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  const rows = (list: K50DateRow[], kind: "new" | "more") => list.map((r) => (
    <tr key={`${kind}-${r.no}`}>
      <td><bdi dir="ltr">{r.no}</bdi></td>
      <td>{r.device_name || "—"}</td>
      <td>{r.app_name}</td>
      <td>{kind === "new" ? "تاریخ تازه" : "تمدید"}</td>
      <td>{r.start ? formatDay(r.start) : "—"}</td>
      <td>{r.end ? formatDay(r.end) : "—"}</td>
    </tr>
  ));
  const waiting = dates ? dates.added.length + dates.extended.length : 0;

  return (
    <>
      <div className="actions">
        <button className="btn ghost" disabled={busy || !ready} onClick={() => void read(false)}>
          {busy && !dates ? "در حال خواندن دستگاه…" : dates ? "دوباره از دستگاه بخوان" : "اول ببینم چه ثبت می‌شود"}
        </button>
      </div>
      {!ready && <p className="muted small">دستگاه انگشت هنوز در «دستگاه انگشت» تنظیم نشده.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {dates && (
        <>
          <div className="stats-row">
            <div><span className="muted small">{dates.committed ? "تاریخ گرفتند" : "تاریخ می‌گیرند"}</span><strong>{fa(dates.added.length)}</strong></div>
            <div><span className="muted small">{dates.committed ? "تمدید شدند" : "تمدید می‌شوند"}</span><strong>{fa(dates.extended.length)}</strong></div>
            <div><span className="muted small">تاریخ برنامه درست است</span><strong>{fa(dates.has_dates)}</strong></div>
            <div><span className="muted small">در دستگاه تاریخ ندارند</span><strong>{fa(dates.no_dates)}</strong></div>
            <div><span className="muted small">در برنامه نیستند</span><strong>{fa(dates.not_in_app)}</strong></div>
          </div>
          {dates.name_differs.length > 0 && (
            <>
              <p className="notice warn">
                نام {fa(dates.name_differs.length)} عضو روی دستگاه با نامش در برنامه یکی به نظر نمی‌رسد. این‌ها جدا
                نشان داده شده‌اند و تا شما نخواهید تاریخ نمی‌گیرند.
              </p>
              <label className="check">
                <input type="checkbox" checked={withDiffers} disabled={busy || dates.committed} onChange={(e) => { setWithDiffers(e.target.checked); void read(false, e.target.checked); }} />
                اعضای اکسل در این فهرست هم تاریخ بگیرند (همان آیدی در اکسل و ZKAccess یعنی همان شخص)
              </label>
            </>
          )}
          {(waiting > 0 || dates.name_differs.some((r) => !r.taken)) && (
            <div className="table-wrap flush">
              <table className="table">
                <thead><tr><th>آیدی</th><th>نام روی دستگاه</th><th>نام در برنامه</th><th>چه می‌شود</th><th>از</th><th>تا</th></tr></thead>
                <tbody>
                  {dates.name_differs.filter((r) => !r.taken).slice(0, 100).map((r) => (
                    <tr key={`differs-${r.no}`} className="muted">
                      <td><bdi dir="ltr">{r.no}</bdi> <span className="chip">نام فرق دارد</span></td>
                      <td>{r.device_name || "—"}</td>
                      <td>{r.app_name}</td>
                      <td>هیچ</td>
                      <td>{r.start ? formatDay(r.start) : "—"}</td>
                      <td>{r.end ? formatDay(r.end) : "—"}</td>
                    </tr>
                  ))}
                  {rows(dates.extended, "more")}
                  {rows(dates.added, "new")}
                </tbody>
              </table>
            </div>
          )}
          {waiting === 0 && <p className="muted">چیزی برای ثبت نیست: تاریخ برنامه برای همه همان قدر یا بیشتر از دستگاه است.</p>}
          {!dates.committed && waiting > 0 && (
            <div className="actions">
              <button className="btn" disabled={busy} onClick={() => void read(true)}>
                {busy ? "در حال ثبت…" : "همین تاریخ‌ها را ثبت کن"}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
