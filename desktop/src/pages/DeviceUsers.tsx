import { useMemo, useState } from "react";
import { api, errorText, k50ErrorText, type K50Comparison, type K50DeviceUser, type MemberNumbers } from "../lib/api";
import { fa, formatDay, parseIso } from "../lib/solar";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";
import { SolarDate } from "../components/SolarDate";

const n = (x: number) => new Intl.NumberFormat("en-US", { useGrouping: false }).format(x);
const day = (iso: string | null) => (iso ? formatDay(parseIso(iso)) : "—");

type Filter = "all" | "member" | "device" | "differs" | "closed";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "همه" },
  { id: "member", label: "عضو برنامه" },
  { id: "device", label: "فقط روی دستگاه" },
  { id: "differs", label: "نام فرق دارد" },
  { id: "closed", label: "بسته" },
];

/**
 * «کاربران دستگاه»: every user the fingerprint device holds, read from it, searchable by ID
 * and name. A member of the app is changed on their own page (the app then writes the device),
 * so the two never tell different stories; a user added only in ZKAccess is changed or
 * removed here, straight on the device. No other ID ever moves to fill a gap.
 */
export function DeviceUsers({ openMember }: { openMember: (id: string) => void }) {
  const toast = useToast();
  const [list, setList] = useState<K50Comparison | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [shown, setShown] = useState(200);
  const [editing, setEditing] = useState<K50DeviceUser | null>(null);
  const [removing, setRemoving] = useState<K50DeviceUser | null>(null);
  const [gaps, setGaps] = useState<MemberNumbers | null>(null);

  async function read() {
    setBusy(true);
    setError("");
    try {
      const r = await api.compareK50(true);
      if (r.Ok) setList(r.Ok); else setError(k50ErrorText(r.Err));
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  async function showGaps() {
    try { setGaps(await api.memberNumbers()); } catch (e) { setError(errorText(e)); }
  }

  const rows = useMemo(() => {
    if (!list) return [];
    const needle = q.trim().toLowerCase();
    const sorted = [...list.rows].sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
    return sorted.filter((r) => {
      if (filter === "member" && !r.member_id) return false;
      if (filter === "device" && r.member_id) return false;
      if (filter === "differs" && r.state !== "differs") return false;
      if (filter === "closed" && r.enabled) return false;
      return !needle || r.no.includes(needle) || r.device_name.toLowerCase().includes(needle) || (r.app_name ?? "").includes(needle);
    });
  }, [list, q, filter]);
  const count = (f: Filter) => !list ? 0 : list.rows.filter((r) =>
    f === "all" ? true : f === "member" ? !!r.member_id : f === "device" ? !r.member_id : f === "differs" ? r.state === "differs" : !r.enabled).length;

  return (
    <div className="page">
      <section className="panel wide">
        <h2>کاربران دستگاه انگشت</h2>
        <p className="muted">
          همهٔ کسانی که روی دستگاه ثبت‌اند، با آیدی، نام و روزهایی که دستگاه راهشان می‌دهد. عضو برنامه را از صفحهٔ خودش عوض کنید
          (نام، آیدی، تاریخ) تا برنامه همان را روی دستگاه بنویسد. کسی که فقط در ZKAccess ثبت شده، همین‌جا ویرایش یا پاک می‌شود.
          وقتی یک آیدی پاک می‌شود، فقط همان آیدی خالی می‌ماند و آیدی هیچ کس دیگری جابه‌جا نمی‌شود.
        </p>
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => void read()}>
            {busy ? "در حال خواندن از دستگاه… (چند دقیقه)" : list ? "خواندن دوباره از دستگاه" : "خواندن از دستگاه"}
          </button>
          <button className="btn ghost" onClick={() => void showGaps()}>آیدی‌های خالی</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>

      {list && (
        <section className="panel wide">
          <div className="device-users-tools">
            <input className="search" type="search" placeholder="جستجوی آیدی یا نام" value={q} aria-label="جستجوی کاربر دستگاه"
              onChange={(e) => { setQ(e.target.value); setShown(200); }} />
            <div className="segmented" role="tablist" aria-label="نمایش">
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? "on" : ""}
                  onClick={() => { setFilter(f.id); setShown(200); }}>
                  {f.label} <span className="muted small">{fa(count(f.id))}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="table-wrap flush">
            <table className="table">
              <thead>
                <tr><th>آیدی</th><th>نام روی دستگاه</th><th>عضو در برنامه</th><th>وضع</th><th>از</th><th>تا</th><th><span className="sr-only">کارها</span></th></tr>
              </thead>
              <tbody>
                {rows.slice(0, shown).map((r) => (
                  <tr key={r.no}>
                    <td className="num"><bdi dir="ltr">{r.no}</bdi></td>
                    <td>{r.device_name || <span className="muted">بی‌نام</span>}{r.admin && <span className="chip">مدیر دستگاه</span>}</td>
                    <td>
                      {r.app_name ?? <span className="muted">—</span>}
                      {r.state === "differs" && <span className="status bad">نام فرق دارد</span>}
                    </td>
                    <td><span className={`status ${r.enabled ? "on" : "off"}`}>{r.enabled ? "باز" : "بسته"}</span></td>
                    <td className="muted">{day(r.start)}</td>
                    <td className="muted">{day(r.end)}</td>
                    <td>
                      <div className="row-actions">
                        {r.member_id ? (
                          <button className="btn small ghost" onClick={() => openMember(r.member_id!)}>صفحهٔ عضو</button>
                        ) : !r.admin && (
                          <>
                            <button className="btn small ghost" onClick={() => setEditing(r)}>ویرایش</button>
                            <button className="btn small ghost danger" onClick={() => setRemoving(r)}>پاک کردن</button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!rows.length && <p className="muted empty">کسی با این جستجو پیدا نشد.</p>}
          </div>
          {rows.length > shown && (
            <div className="list-more">
              <span className="muted small">{fa(shown)} از {fa(rows.length)} نفر</span>
              <button className="btn ghost small" onClick={() => setShown((x) => x + 200)}>نمایش بیشتر</button>
            </div>
          )}
        </section>
      )}

      {editing && (
        <EditDeviceUser user={editing} onClose={(saved) => {
          if (saved) {
            setList((l) => l && { ...l, rows: l.rows.map((r) => (r.no === saved.no ? saved : r)) });
            toast(`آیدی ${saved.no} روی دستگاه عوض شد.`);
          }
          setEditing(null);
        }} />
      )}
      {removing && (
        <RemoveDeviceUser user={removing} onClose={(gone) => {
          if (gone) {
            setList((l) => l && { ...l, device_users: l.device_users - 1, rows: l.rows.filter((r) => r.no !== removing.no) });
            toast(`آیدی ${removing.no} از دستگاه پاک شد و خالی است.`);
          }
          setRemoving(null);
        }} />
      )}
      {gaps && (
        <Modal label="آیدی‌های خالی" onClose={() => setGaps(null)}>
          <h2>آیدی‌های خالی</h2>
          <p className="muted small">
            آخرین آیدی <b dir="ltr">{gaps.last ? n(gaps.last.no) : "—"}</b> و آیدی بعدی <b dir="ltr">{n(gaps.next)}</b> است. این‌ها آیدی‌هایی است که
            نه عضوی دارد و نه دستگاه کسی را زیرش دارد. برای دادن یکی از این‌ها، در فرم عضو تازه یا ویرایش عضو همان را بنویسید.
          </p>
          {gaps.gaps.length ? (
            <ul className="gap-list">
              {gaps.gaps.map((g) => (
                <li key={g.from}>
                  <b dir="ltr">{n(g.from)}</b>
                  {g.to !== g.from && <><span className="muted" dir="ltr"> … {n(g.to)}</span><span className="muted small"> ({n(g.to - g.from + 1)} آیدی)</span></>}
                </li>
              ))}
            </ul>
          ) : <p className="form-ok">هیچ آیدی خالی در میانه نیست.</p>}
          <div className="actions"><button className="btn ghost" onClick={() => setGaps(null)}>بستن</button></div>
        </Modal>
      )}
    </div>
  );
}

function EditDeviceUser({ user, onClose }: { user: K50DeviceUser; onClose: (saved: K50DeviceUser | null) => void }) {
  const [name, setName] = useState(user.device_name);
  const [enabled, setEnabled] = useState(user.enabled);
  const [dated, setDated] = useState(!!(user.start && user.end));
  const today = new Date().toISOString().slice(0, 10);
  const [start, setStart] = useState(user.start ?? today);
  const [end, setEnd] = useState(user.end ?? today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const body = { no: user.no, was: user.device_name, name: name.trim(), enabled, start: dated ? start : null, end: dated ? end : null };
      const r = await api.editK50User(body);
      if (!r.ok) {
        setError(r.error?.startsWith("taken") ? "نام این آیدی روی دستگاه در این میان عوض شده. بستن را بزنید و فهرست را دوباره بخوانید." : k50ErrorText(r.error));
        return;
      }
      onClose({ ...user, device_name: name.trim(), enabled, start: body.start, end: body.end });
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal label="ویرایش کاربر دستگاه" onClose={() => onClose(null)}>
      <h2>آیدی <bdi dir="ltr">{user.no}</bdi> روی دستگاه</h2>
      <p className="muted small">این شخص در برنامه عضو نیست. تغییر مستقیم روی دستگاه نوشته می‌شود. دستگاه نام را تا ۲۴ حرف نگه می‌دارد.</p>
      <div className="form-grid">
        <label className="field"><span>نام روی دستگاه</span><input value={name} maxLength={24} onChange={(e) => setName(e.target.value)} /></label>
      </div>
      <label className="check"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> دستگاه راهش بدهد (باز)</label>
      <label className="check"><input type="checkbox" checked={dated} onChange={(e) => setDated(e.target.checked)} /> فقط میان دو تاریخ</label>
      {dated && (
        <div className="form-grid">
          <SolarDate label="از" value={start} onChange={setStart} />
          <SolarDate label="تا" value={end} onChange={setEnd} />
        </div>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? "در حال نوشتن روی دستگاه…" : "ذخیره روی دستگاه"}</button>
        <button className="btn ghost" onClick={() => onClose(null)}>انصراف</button>
      </div>
    </Modal>
  );
}

function RemoveDeviceUser({ user, onClose }: { user: K50DeviceUser; onClose: (gone: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const no = Number(user.no);
  async function remove() {
    setBusy(true);
    setError("");
    try {
      const r = await api.freeK50([no]);
      const one = r.Ok?.[0];
      if (r.Err) setError(k50ErrorText(r.Err));
      else if (!one?.ok) setError(k50ErrorText(one?.error));
      else onClose(true);
    } catch (e) { setError(errorText(e)); } finally { setBusy(false); }
  }
  return (
    <Modal label="پاک کردن از دستگاه" onClose={() => onClose(false)}>
      <h2>پاک کردن آیدی <bdi dir="ltr">{user.no}</bdi></h2>
      <p>
        «{user.device_name || "بی‌نام"}» با همهٔ انگشت‌هایش از دستگاه پاک می‌شود و آیدی <bdi dir="ltr">{user.no}</bdi> خالی می‌ماند.
        آیدی کس دیگری عوض نمی‌شود. این کار برنمی‌گردد.
      </p>
      {!Number.isFinite(no) && <p className="form-error">این آیدی عدد نیست؛ آن را در ZKAccess پاک کنید.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn danger" disabled={busy || !Number.isFinite(no)} onClick={() => void remove()}>{busy ? "در حال پاک کردن…" : "پاک کن"}</button>
        <button className="btn ghost" onClick={() => onClose(false)}>انصراف</button>
      </div>
    </Modal>
  );
}
