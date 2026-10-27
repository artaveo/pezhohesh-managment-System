import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { api, errorText, type Arrived, type DocKind, type MemberRow, type PhoneUpload } from "../lib/api";
import { firewallOpen, openFirewall } from "../lib/core";
import { fa, formatDay, iso } from "../lib/solar";
import { useAuth } from "../auth/AuthProvider";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";
import { Failed } from "../components/Stat";
import { Icon } from "../components/Icon";

const KINDS: { kind: DocKind; label: string }[] = [
  { kind: "photo", label: "عکس عضو" },
  { kind: "tazkira_front", label: "روی تذکره" },
  { kind: "tazkira_back", label: "پشت تذکره" },
];
const at = new Intl.DateTimeFormat("fa-AF-u-ca-persian-nu-latn", { hour: "2-digit", minute: "2-digit", hour12: false });
const changed = () => window.dispatchEvent(new Event("inbox-changed"));

/** What one sender sent at once: the same member number and phone. */
type Group = { key: string; rows: Arrived[] };

function groups(rows: Arrived[]): Group[] {
  const out = new Map<string, Arrived[]>();
  for (const r of rows) {
    const key = `${r.member_no ?? ""}|${r.phone ?? ""}`;
    out.set(key, [...(out.get(key) ?? []), r]);
  }
  return [...out].map(([key, rows]) => ({ key, rows }));
}

/**
 * «رسیده از موبایل»: photos and tazkira scans members sent from their phones, by the QR
 * code on the laptop. Nothing goes on a member's file until someone here looks at it and
 * puts it there.
 */
export function Inbox({ openMember }: { openMember: (id: string) => void }) {
  const [rows, setRows] = useState<Arrived[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [tick, setTick] = useState(0);
  const [sticker, setSticker] = useState(false);

  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    api.inbox(ctl.signal).then(setRows).catch(() => { if (!ctl.signal.aborted) setFailed(true); });
    // New arrivals show up by themselves while the page is open.
    const t = window.setInterval(() => api.inbox().then(setRows, () => {}), 20_000);
    return () => { ctl.abort(); window.clearInterval(t); };
  }, [tick]);

  const done = (ids: string[]) => {
    setRows((r) => r?.filter((x) => !ids.includes(x.id)) ?? null);
    changed();
  };

  return (
    <div className="page">
      <div className="page-head">
        <p className="muted">
          اعضا با اسکن QR پشت لپ‌تاپ، از موبایل خودشان عکس و تذکره می‌فرستند (بدون انترنت، از وای‌فای همین‌جا).
          آنچه رسیده اینجا می‌ماند تا شما ببینید و روی پروندهٔ درست بگذارید.
        </p>
        <button className="btn" onClick={() => setSticker(true)}><Icon name="qr" size={18} /> QR و تنظیمات</button>
      </div>
      {failed ? <Failed retry={() => setTick((t) => t + 1)} />
        : !rows ? <p className="muted">در حال خواندن…</p>
        : !rows.length ? <p className="glass muted empty">چیزی منتظر نیست. آنچه از موبایل برسد اینجا دیده می‌شود.</p>
        : groups(rows).map((g) => <Sender key={g.key} group={g} onDone={done} openMember={openMember} />)}
      {sticker && <PhoneSticker onClose={() => setSticker(false)} />}
    </div>
  );
}

type Target = { id: string; name: string; no: number | null };

function Sender({ group, onDone, openMember }: { group: Group; onDone: (ids: string[]) => void; openMember: (id: string) => void }) {
  const toast = useToast();
  const first = group.rows[0];
  const found: Target | null = first.member_id
    ? { id: first.member_id, name: first.member_name ?? "", no: first.member_no }
    : first.by_phone_id ? { id: first.by_phone_id, name: first.by_phone_name ?? "", no: first.by_phone_no } : null;
  const [target, setTarget] = useState<Target | null>(found);
  const [picking, setPicking] = useState(!found);
  const [kinds, setKinds] = useState<Record<string, DocKind>>(() => Object.fromEntries(group.rows.map((r) => [r.id, r.kind])));
  const [busy, setBusy] = useState(false);

  async function accept(list: Arrived[]) {
    if (!target) return;
    setBusy(true);
    const ok: string[] = [];
    try {
      for (const r of list) {
        await api.acceptArrived(r.id, target.id, kinds[r.id]);
        ok.push(r.id);
      }
      toast(`روی پروندهٔ ${target.name} گذاشته شد.`);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
      if (ok.length) onDone(ok);
    }
  }
  async function reject(r: Arrived) {
    setBusy(true);
    try {
      await api.rejectArrived(r.id);
      onDone([r.id]);
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="glass arrived">
      <header className="arrived-head">
        <div>
          <span className="muted small">{formatDay(iso(new Date(first.received_at)))} {at.format(new Date(first.received_at))} · نوشته در موبایل:</span>{" "}
          {first.member_no !== null && <span>آیدی <b>{first.member_no}</b></span>}
          {first.member_no !== null && first.phone && " · "}
          {first.phone && <span>شماره <bdi dir="ltr">{first.phone}</bdi></span>}
        </div>
        <div className="arrived-who">
          {target && !picking ? (
            <>
              <span>برای: <button className="link" onClick={() => openMember(target.id)}><b>{target.name}</b></button>{target.no !== null && <span className="muted"> (آیدی {target.no})</span>}</span>
              {first.member_id && target.id === first.member_id && first.phone && (
                first.phone_matches
                  ? <span className="status on">شماره تماس هم با پرونده یکی است</span>
                  : <span className="status wait">شماره تماس با پرونده یکی نیست ({first.member_phone ? <bdi dir="ltr">{first.member_phone}</bdi> : "در پرونده شماره نیست"})</span>
              )}
              {!first.member_id && first.by_phone_id && target.id === first.by_phone_id && (
                <span className="status wait">{first.member_no !== null ? "این آیدی پیدا نشد؛ " : ""}از روی شماره تماس پیدا شد</span>
              )}
              <button className="btn ghost small" onClick={() => setPicking(true)}>عضو دیگر…</button>
            </>
          ) : (
            <MemberPicker
              hint={found ? undefined : "با این آیدی و شماره عضوی پیدا نشد. عضو را جستجو کنید:"}
              onPick={(t) => { setTarget(t); setPicking(false); }}
              onCancel={target ? () => setPicking(false) : undefined}
            />
          )}
        </div>
      </header>
      <div className="arrived-files">
        {group.rows.map((r) => (
          <div key={r.id} className="arrived-file">
            <Preview row={r} />
            <select aria-label="این فایل چیست" value={kinds[r.id]} onChange={(e) => setKinds((k) => ({ ...k, [r.id]: e.target.value as DocKind }))}>
              {KINDS.map((k) => <option key={k.kind} value={k.kind} disabled={k.kind === "photo" && r.mime_type === "application/pdf"}>{k.label}</option>)}
            </select>
            <span className="muted small">{fa(Math.max(1, Math.round(r.size_bytes / 1024)))} KB</span>
            <div className="doc-actions">
              <button className="btn small" disabled={busy || !target || picking} onClick={() => void accept([r])}>روی پرونده</button>
              <button className="btn ghost small danger" disabled={busy} onClick={() => void reject(r)}>رد</button>
            </div>
          </div>
        ))}
      </div>
      {group.rows.length > 1 && (
        <div className="actions">
          <button className="btn" disabled={busy || !target || picking} onClick={() => void accept(group.rows)}>همه را روی پرونده بگذار</button>
        </div>
      )}
    </section>
  );
}

function Preview({ row }: { row: Arrived }) {
  const [url, setUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    api.inboxFile(row.id).then((b) => { if (live) { made = URL.createObjectURL(b); setUrl(made); } }, () => {});
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [row.id]);
  const pdf = row.mime_type === "application/pdf";
  return (
    <>
      <button className="doc-thumb" onClick={() => setOpen(true)} disabled={!url} aria-label="بزرگ دیدن">
        {pdf ? <span>PDF</span> : url ? <img src={url} alt="" /> : <span className="muted small">…</span>}
      </button>
      {open && url && (
        <Modal label="فایل رسیده" onClose={() => setOpen(false)} className="doc-view">
          {pdf ? <iframe src={url} title="PDF" /> : <img src={url} alt="" />}
        </Modal>
      )}
    </>
  );
}

function MemberPicker({ hint, onPick, onCancel }: { hint?: string; onPick: (t: Target) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const [found, setFound] = useState<MemberRow[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setFound([]); return; }
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      api.members({ scope: "all", q, limit: 8 }, ctl.signal).then((p) => setFound(p.rows.filter((r) => r.member_id)), () => {});
    }, 250);
    return () => { window.clearTimeout(t); ctl.abort(); };
  }, [q]);
  return (
    <div className="member-picker">
      {hint && <p className="small">{hint}</p>}
      <div className="row-actions">
        <input type="search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="نام، آیدی یا شماره تماس" aria-label="جستجوی عضو" />
        {onCancel && <button className="btn ghost small" onClick={onCancel}>لغو</button>}
      </div>
      {found.length > 0 && (
        <ul className="pick-list">
          {found.map((m) => (
            <li key={m.member_id}>
              <button className="link" onClick={() => onPick({ id: m.member_id!, name: m.name, no: m.member_no })}>
                {m.name}{m.father_name && <span className="muted"> فرزند {m.father_name}</span>}
                {m.member_no !== null && <span className="muted"> · آیدی {m.member_no}</span>}
                {m.phone && <span className="muted"> · <bdi dir="ltr">{m.phone}</bdi></span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The sticker for the back of the laptop

const WIFI_KEY = "pz-hotspot-wifi";

function loadWifi(): { ssid: string; password: string } {
  try {
    const v = JSON.parse(localStorage.getItem(WIFI_KEY) ?? "null");
    if (v && typeof v.ssid === "string" && typeof v.password === "string") return v;
  } catch { /* none kept */ }
  return { ssid: "", password: "" };
}

/** The text of a "join this Wi-Fi" QR code, which phone cameras understand. */
function wifiText(ssid: string, password: string) {
  const esc = (s: string) => s.replace(/([\\;,:"])/g, "\\$1");
  return password ? `WIFI:T:WPA;S:${esc(ssid)};P:${esc(password)};;` : `WIFI:T:nopass;S:${esc(ssid)};;`;
}

function useQr(text: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!text) return;
    let live = true;
    let made: string | null = null;
    const t = window.setTimeout(() => {
      api.qr(text).then((b) => { if (live) { made = URL.createObjectURL(b); setUrl(made); } }, () => {});
    }, 300);
    return () => { live = false; window.clearTimeout(t); if (made) URL.revokeObjectURL(made); };
  }, [text]);
  return url;
}

function PhoneSticker({ onClose }: { onClose: () => void }) {
  const { user } = useAuth();
  const partner = user!.role === "partner";
  const toast = useToast();
  const [status, setStatus] = useState<PhoneUpload | null>(null);
  const [failed, setFailed] = useState(false);
  const [address, setAddress] = useState("");
  const [wifi, setWifi] = useState(loadWifi);
  const [firewall, setFirewall] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api.phoneUpload().then((s) => { setStatus(s); setAddress((a) => a || s.hotspot_url); }, () => setFailed(true));
  useEffect(() => { void load(); void firewallOpen().then(setFirewall); }, []);
  useEffect(() => { try { localStorage.setItem(WIFI_KEY, JSON.stringify(wifi)); } catch { /* not kept */ } }, [wifi]);

  const pageQr = useQr(address || null);
  const wifiQr = useQr(wifi.ssid.trim() ? wifiText(wifi.ssid.trim(), wifi.password) : null);

  async function toggle() {
    if (!status) return;
    try {
      await api.setPhoneUpload(!status.enabled);
      await load();
    } catch (e) {
      toast(errorText(e));
    }
  }
  async function allow() {
    setBusy(true);
    try {
      await openFirewall();
      setFirewall(await firewallOpen());
      toast("دیوار آتش ویندوز حالا موبایل‌ها را به این برنامه راه می‌دهد.");
    } catch (e) {
      toast(e === "cancelled" ? "ویندوز اجازه نگرفت؛ دوباره بزنید و «Yes» را انتخاب کنید." : "نشد. یک بار دیگر امتحان کنید.");
    } finally {
      setBusy(false);
    }
  }

  const choices = status ? [{ url: status.hotspot_url, hotspot: true }, ...status.addresses.filter((a) => a.url !== status.hotspot_url)] : [];
  return (
    <Modal label="QR برای ارسال از موبایل" onClose={onClose} className="sticker-modal">
      <div className="modal-tools no-print">
        <button className="btn" disabled={!pageQr} onClick={() => window.print()}>چاپ برچسب</button>
        <button className="btn ghost" onClick={onClose}>بستن</button>
      </div>
      {failed && <p className="form-error">وضعیت خوانده نشد.</p>}
      {status && (
        <div className="sticker-settings">
          <p>
            ارسال از موبایل: {status.enabled ? <span className="status on">باز</span> : <span className="status off">بسته</span>}{" "}
            {partner && <button className="btn ghost small" onClick={() => void toggle()}>{status.enabled ? "ببند" : "باز کن"}</button>}
          </p>
          {firewall !== null && (
            <p>
              دیوار آتش ویندوز: {firewall ? <span className="status on">اجازه دارد</span> : <span className="status wait">هنوز اجازه ندارد</span>}{" "}
              {!firewall && <button className="btn small" disabled={busy} onClick={() => void allow()}>اجازه بده (یک بار)</button>}
            </p>
          )}
          <label className="field">
            <span>آدرس در QR</span>
            <select value={address} onChange={(e) => setAddress(e.target.value)}>
              {choices.map((c) => <option key={c.url} value={c.url}>{c.url}{c.hotspot ? " (هاتسپات خود لپ‌تاپ؛ همیشه همین)" : " (وای‌فای/شبکهٔ فعلی)"}</option>)}
            </select>
          </label>
          <p className="muted small">
            بهترین راه: «Mobile hotspot» ویندوز را روشن کنید (Settings ← Network &amp; internet ← Mobile hotspot). آدرس هاتسپات
            همیشه <bdi dir="ltr">192.168.137.1</bdi> است، پس QR چاپ‌شده همیشه کار می‌کند. آدرس وای‌فای دفتر ممکن است با روشن و خاموش شدن مودم عوض شود.
          </p>
          <div className="form-row">
            <label className="field"><span>نام وای‌فای هاتسپات (اختیاری)</span><input value={wifi.ssid} onChange={(e) => setWifi({ ...wifi, ssid: e.target.value })} dir="ltr" /></label>
            <label className="field"><span>رمز وای‌فای</span><input value={wifi.password} onChange={(e) => setWifi({ ...wifi, password: e.target.value })} dir="ltr" /></label>
          </div>
          <p className="muted small">اگر نام و رمز وای‌فای را بنویسید، یک QR دوم هم روی برچسب می‌آید که موبایل را بدون تایپ رمز به وای‌فای وصل می‌کند.</p>
        </div>
      )}
      <div className="sticker-stage"><Sticker pageQr={pageQr} wifiQr={wifiQr} address={address} ssid={wifi.ssid.trim()} /></div>
      {createPortal(<div className="print-only sticker-print"><Sticker pageQr={pageQr} wifiQr={wifiQr} address={address} ssid={wifi.ssid.trim()} /></div>, document.body)}
    </Modal>
  );
}

function Sticker({ pageQr, wifiQr, address, ssid }: { pageQr: string | null; wifiQr: string | null; address: string; ssid: string }) {
  return (
    <div className="sticker">
      <header>
        <img src="/logo-study-hall.png" alt="" />
        <div>
          <strong>عکس و تذکره را از موبایل بفرستید</strong>
          <span>بدون انترنت · مخصوص اعضای سالن مطالعه پژوهش</span>
        </div>
      </header>
      <div className="sticker-codes">
        {wifiQr && (
          <figure>
            <img src={wifiQr} alt="" />
            <figcaption><b>۱.</b> به وای‌فای وصل شوید<br /><bdi dir="ltr">{ssid}</bdi></figcaption>
          </figure>
        )}
        <figure>
          {pageQr ? <img src={pageQr} alt="" /> : <div className="qr-wait" />}
          <figcaption><b>{wifiQr ? "۲." : ""}</b> این را اسکن کنید<br /><bdi dir="ltr">{address}</bdi></figcaption>
        </figure>
      </div>
    </div>
  );
}
