import { useEffect, useState } from "react";
import { api, errorText, type AttendanceDay } from "../lib/api";
import { addDays, fa, formatDay, iso, parseIso } from "../lib/solar";
import { SolarDate } from "../components/SolarDate";

const time = (at: string) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kabul" });

/**
 * Who came on a day and who did not: from the punches the app keeps (the device itself is
 * cleared once a month), against the members whose monthly seat ran that day.
 */
export function Attendance({ openMember }: { openMember: (id: string) => void }) {
  const [on, setOn] = useState(iso(new Date()));
  const [tab, setTab] = useState<"came" | "absent">("came");
  const [d, setD] = useState<AttendanceDay | null>(null);
  const [error, setError] = useState("");
  const today = iso(new Date());

  useEffect(() => {
    if (!on) return;
    const ctl = new AbortController();
    setD(null);
    api.attendanceDay(on, ctl.signal).then((x) => { setD(x); setError(""); }).catch((e) => { if (!ctl.signal.aborted) setError(errorText(e)); });
    return () => ctl.abort();
  }, [on]);
  const step = (n: number) => setOn(iso(addDays(parseIso(on), n)));
  // The punches are read from the device now and then; a day after the last read is not complete.
  const behind = d?.newest && d.newest.slice(0, 10) < on && on <= today;

  return (
    <div className="page">
      <div className="list-tools day-tools">
        <button className="btn ghost small" onClick={() => step(-1)} aria-label="روز قبل">‹ روز قبل</button>
        <SolarDate label="روز" value={on} onChange={setOn} />
        <button className="btn ghost small" disabled={on >= today} onClick={() => step(1)} aria-label="روز بعد">روز بعد ›</button>
        {on !== today && <button className="btn ghost small" onClick={() => setOn(today)}>امروز</button>}
      </div>
      {d && <p className="muted small">{d.newest ? <>آخرین حاضری خوانده‌شده از دستگاه: {formatDay(d.newest.slice(0, 10))} ساعت {time(d.newest)}</> : "هنوز هیچ حاضری از دستگاه خوانده نشده."}</p>}
      {behind && <p className="notice warn">حاضری‌های این روز هنوز کامل از دستگاه خوانده نشده؛ شاید دستگاه در دسترس نبوده.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {d && (
        <>
          <div className="segmented sub" role="tablist">
            <button role="tab" aria-selected={tab === "came"} className={tab === "came" ? "on" : ""} onClick={() => setTab("came")}>آمده‌ها <small>({fa(d.came.length)})</small></button>
            <button role="tab" aria-selected={tab === "absent"} className={tab === "absent" ? "on" : ""} onClick={() => setTab("absent")}>نیامده‌ها <small>({fa(d.absent.length)})</small></button>
          </div>
          <p className="muted small">
            {tab === "came" ? "هر کسی که در این روز انگشت زده؛ اولین و آخرین بار." : "اعضایی که در این روز عضویت ماهانهٔ جاری داشتند و انگشت نزدند."}
          </p>
          <div className="glass table-wrap">
            {tab === "came" ? (
              <table className="table">
                <thead><tr><th>آیدی</th><th>نام</th><th>شماره تماس</th><th>آمد</th><th>رفت</th><th className="num">بار</th></tr></thead>
                <tbody>
                  {d.came.map((c) => (
                    <tr key={c.member_no} className={c.member_id ? "clickable" : ""} onClick={c.member_id ? () => openMember(c.member_id!) : undefined}
                      tabIndex={c.member_id ? 0 : undefined} onKeyDown={c.member_id ? (e) => { if (e.key === "Enter") openMember(c.member_id!); } : undefined}>
                      <td className="num">{c.member_no}</td>
                      <td>{c.name ?? <span className="muted">در برنامه نیست</span>}</td>
                      <td><bdi dir="ltr">{c.phone ?? "—"}</bdi></td>
                      <td className="num">{time(c.first_at)}</td>
                      <td className="num">{c.punches > 1 ? time(c.last_at) : "—"}</td>
                      <td className="num">{fa(c.punches)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <table className="table">
                <thead><tr><th>آیدی</th><th>نام</th><th>شماره تماس</th><th>ختم عضویت</th><th>آخرین بار آمده</th></tr></thead>
                <tbody>
                  {d.absent.map((a) => (
                    <tr key={a.member_id} className="clickable" onClick={() => openMember(a.member_id)} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") openMember(a.member_id); }}>
                      <td className="num">{a.member_no}</td>
                      <td>{a.name}</td>
                      <td><bdi dir="ltr">{a.phone ?? "—"}</bdi></td>
                      <td>{formatDay(a.end_date)}</td>
                      <td>{a.last_seen ? formatDay(a.last_seen.slice(0, 10)) : <span className="muted">هیچ وقت</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(tab === "came" ? d.came : d.absent).length === 0 && <p className="muted empty">{tab === "came" ? "در این روز کسی انگشت نزده." : "همه آمده‌اند."}</p>}
          </div>
        </>
      )}
      {!d && !error && <p className="muted">در حال بارگذاری…</p>}
    </div>
  );
}
