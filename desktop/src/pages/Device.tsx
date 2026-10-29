import { useEffect, useState } from "react";
import { api, errorText, k50ErrorText, type K50Comparison, type K50Config, type K50Dates, type K50Held, type K50Info, type K50Looked, type K50Sdk, type K50Status } from "../lib/api";
import { fa, formatDay } from "../lib/solar";
import { useToast } from "../components/Toast";
import { Modal } from "../components/Modal";

const when = (at: string) => {
  const d = new Date(at);
  return `${formatDay(d)}، ساعت ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
};

/**
 * The fingerprint device at the door (partners): where it is on the network, whether the
 * app keeps it up to date by itself, and how the last round went.
 */
export function Device() {
  const toast = useToast();
  const [s, setS] = useState<K50Status | null>(null);
  const [form, setForm] = useState<K50Config | null>(null);
  const [info, setInfo] = useState<K50Info | null>(null);
  const [found, setFound] = useState<{ ip: string; via: string }[] | null>(null);
  const [busy, setBusy] = useState<"" | "test" | "scan" | "sync" | "time" | "save" | "compare" | "sdk" | "fingers" | "dates" | "names">("");
  const [dates, setDates] = useState<K50Dates | null>(null);
  const [withDiffers, setWithDiffers] = useState(false);
  const [sdk, setSdk] = useState<K50Sdk | null>(null);
  const [sdkFrom, setSdkFrom] = useState("");
  const [sdkError, setSdkError] = useState("");
  // Copies of the SDK in backups or on a USB stick (from the computer that had ZKAccess).
  const [copies, setCopies] = useState<string[]>([]);
  const [copy, setCopy] = useState("");
  useEffect(() => { api.k50SdkCopies().then((c) => { setCopies(c); setCopy(c[0] ?? ""); }).catch(() => {}); }, []);
  const [cmp, setCmp] = useState<K50Comparison | null>(null);
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(300);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);
  const [error, setError] = useState("");
  const [tick, setTick] = useState(0);

  const needle = q.trim().toLowerCase();
  const rows = !cmp ? [] : !needle ? cmp.rows
    : cmp.rows.filter((r) => r.no.includes(needle) || r.device_name.toLowerCase().includes(needle) || (r.app_name ?? "").includes(needle));

  useEffect(() => {
    api.k50().then((x) => { setS(x); setForm((f) => f ?? x.config); }).catch((e) => setError(errorText(e)));
  }, [tick]);
  useEffect(() => {
    api.k50Sdk().then(setSdk).catch(() => setSdk(null));
  }, []);
  // The rounds run in the background; keep the numbers fresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 20000);
    return () => clearInterval(t);
  }, []);

  async function run<T>(what: typeof busy, f: () => Promise<T>): Promise<T | undefined> {
    setBusy(what);
    setError("");
    try { return await f(); } catch (e) { setError(errorText(e)); return undefined; } finally { setBusy(""); setTick((n) => n + 1); }
  }
  const save = (c: K50Config) => run("save", async () => { await api.setK50(c); setForm(c); toast("ذخیره شد."); });
  // Only the switch is saved here; other unsaved edits on the form stay unsaved.
  const setAuto = (enabled: boolean) => run("save", async () => {
    await api.setK50({ ...s!.config, enabled });
    setForm((f) => f && { ...f, enabled });
    setAsking(false);
    toast(enabled ? "به‌روزرسانی خودکار روشن شد." : "به‌روزرسانی خودکار خاموش شد.");
  });
  const test = () => run("test", async () => setInfo(await api.testK50(form!)));
  const scan = () => run("scan", async () => setFound(await api.scanK50()));
  const sync = () => run("sync", async () => {
    const r = await api.syncK50();
    if (r.ok) toast(`انجام شد: ${fa(r.pushed)} عضو فرستاده شد، ${fa(r.punches)} حاضری تازه خوانده شد.`);
  });
  const compare = () => run("compare", async () => {
    const r = await api.compareK50();
    if (r.Ok) setCmp(r.Ok); else setError(k50ErrorText(r.Err));
    setPicked(new Set());
  });
  // The partner has looked at these rows: same person, written another way on the device.
  const confirmNames = () => run("names", async () => {
    const chosen = cmp!.rows.filter((r) => r.state === "differs" && picked.has(r.no));
    await api.k50NamesOk(chosen.map((r) => ({ no: r.no, device_name: r.device_name })));
    setCmp((c) => c && {
      ...c,
      differs: c.differs - chosen.length,
      rows: c.rows.map((r) => (picked.has(r.no) && r.state === "differs" ? { ...r, state: "same" as const } : r)),
    });
    setPicked(new Set());
    toast(`${fa(chosen.length)} نفر «همان شخص» ثبت شد.`);
  });
  const copySdk = (from: string) => run("sdk", async () => {
    setSdkError("");
    const r = await api.copyK50Sdk(from);
    if (!r.ok) { setSdkError(k50ErrorText(r.error)); return; }
    const now = await api.k50Sdk();
    setSdk(now);
    if (now.sdk === "app") toast(`SDK در پوشهٔ برنامه کپی شد (${fa(r.files?.length ?? 0)} فایل).`);
    else setSdkError("فایل‌ها کپی شد ولی برنامه هنوز از نسخهٔ خودش استفاده نمی‌کند. جزئیات در api.log است.");
  });
  const backupFingers = () => run("fingers", async () => {
    const r = await api.backupK50Fingers();
    if (r.Ok) toast(`انگشت‌ها ذخیره شد: ${fa(r.Ok.fingers)} انگشت از ${fa(r.Ok.users)} کاربر.`);
    else setError(k50ErrorText(r.Err));
  });
  const readDates = (commit: boolean, include = withDiffers) => run("dates", async () => {
    const r = await api.k50Dates(commit, include);
    if (!r.Ok) { setError(k50ErrorText(r.Err)); return; }
    setDates(r.Ok);
    if (r.Ok.committed) toast(`تاریخ عضویت ${fa(r.Ok.added.length)} عضو از دستگاه ثبت شد.`);
  });
  const fixTime = () => run("time", async () => {
    const r = await api.k50Time();
    if (r.ok) toast(`ساعت دستگاه درست شد${r.time ? `: ${r.time}` : ""}.`); else setError(k50ErrorText(r.error));
  });

  if (!s || !form) return error ? <p className="form-error">{error}</p> : <p className="muted">در حال بارگذاری…</p>;
  const saved = s.config;
  const changed = JSON.stringify(form) !== JSON.stringify(saved);
  const last = s.last;
  return (
    <div className="page">
      <section className="panel wide">
        <h2>وضع دستگاه</h2>
        {!saved.ip ? <p className="form-error">آدرس دستگاه هنوز تنظیم نشده. پایین‌تر آن را پیدا یا وارد کنید.</p>
          : !saved.enabled ? <p className="notice warn">به‌روز نگه داشتن خودکار خاموش است؛ فقط وقتی دکمه را بزنید چیزی به دستگاه می‌رود.</p>
          : last ? (
            <p className={last.ok ? "form-ok" : "form-error"}>
              {last.ok ? "آخرین همگام‌سازی درست انجام شد" : `آخرین همگام‌سازی نشد: ${k50ErrorText(last.error)}`}
              {last.at && <> ({when(last.at)})</>}
            </p>
          ) : <p className="muted">برنامه هر دو دقیقه دستگاه را به‌روز می‌کند و هر ده دقیقه حاضری‌ها را می‌خواند.</p>}
        <div className="stats-row">
          <div><span className="muted small">روی دستگاه فرستاده شده</span><strong>{fa(s.sent)}</strong></div>
          <div><span className="muted small">در نوبت فرستادن</span><strong>{fa(s.pending)}</strong></div>
          <div><span className="muted small">حاضری امروز</span><strong>{fa(s.punches_today)}</strong></div>
        </div>
        <div className="actions">
          <button className="btn big" disabled={!!busy || !saved.ip} onClick={() => void sync()}>{busy === "sync" ? "در حال همگام‌سازی…" : "همین حالا همگام کن"}</button>
          <button className="btn ghost" disabled={!!busy || !saved.ip} onClick={() => void fixTime()}>{busy === "time" ? "…" : "ساعت دستگاه را با این لپ‌تاپ یکی کن"}</button>
        </div>
        {error && <p className="form-error" role="alert">{error}</p>}
      </section>

      <section className="panel wide">
        <h2>آدرس دستگاه در شبکه</h2>
        <p className="muted">
          دستگاه با کیبل به همان سویچی وصل است که لپ‌تاپ به آن وصل است. «جستجو» دستگاه را در شبکه پیدا می‌کند.
          <strong> ZKAccess را ببندید</strong>؛ تا باز باشد، دستگاه با این برنامه حرف نمی‌زند.
        </p>
        <div className="form-grid">
          <label className="field">
            <span>آدرس IP دستگاه</span>
            <input dir="ltr" value={form.ip} placeholder="192.168.1.201" onChange={(e) => setForm({ ...form, ip: e.target.value.trim() })} />
          </label>
          <label className="field">
            <span>رمز ارتباط (اگر در دستگاه گذاشته شده)</span>
            <input dir="ltr" inputMode="numeric" value={form.comm_key || ""} placeholder="0"
              onChange={(e) => setForm({ ...form, comm_key: Number(e.target.value.replace(/\D/g, "")) || 0 })} />
          </label>
        </div>
        <label className="check big">
          <input type="checkbox" checked={saved.enabled} disabled={!!busy || !saved.ip || (!saved.enabled && (!cmp || cmp.differs > 0))}
            onChange={(e) => { if (e.target.checked) setAsking(true); else void setAuto(false); }} />
          برنامه خودش دستگاه را به‌روز نگه دارد (آیدی، نام و تاریخ عضویت، و خواندن حاضری‌ها)
        </label>
        {!saved.enabled && saved.ip && (
          <p className="muted small">
            {!cmp ? "برای روشن کردن، اول پایین‌تر «مقایسهٔ آیدی‌ها با دستگاه» را بزنید."
              : cmp.differs > 0 ? `${fa(cmp.differs)} آیدی روی دستگاه نام کس دیگری را دارد؛ تا درست نشده، خودکار روشن نمی‌شود.`
              : "آیدی‌ها یکی‌اند؛ می‌توانید خودکار را روشن کنید."}
          </p>
        )}
        <div className="actions">
          <button className="btn" disabled={!!busy || !changed} onClick={() => void save(form)}>ذخیره</button>
          <button className="btn ghost" disabled={!!busy || !form.ip} onClick={() => void test()}>{busy === "test" ? "در حال وصل شدن…" : "آزمایش اتصال"}</button>
          <button className="btn ghost" disabled={!!busy} onClick={() => void scan()}>{busy === "scan" ? "در حال جستجو…" : "جستجوی دستگاه در شبکه"}</button>
        </div>
        {found && (found.length ? (
          <ul className="drive-list">
            {found.map((f) => (
              <li key={f.ip} className={f.ip === form.ip ? "picked" : ""}>
                <bdi dir="ltr"><strong>{f.ip}</strong></bdi>
                <span className="muted small">از راه <bdi dir="ltr">{f.via}</bdi></span>
                {f.ip === form.ip ? <span className="chip">انتخاب شده</span>
                  : <button className="btn ghost small" onClick={() => setForm({ ...form, ip: f.ip })}>همین است</button>}
              </li>
            ))}
          </ul>
        ) : <p className="form-error">دستگاهی پیدا نشد. کیبل دستگاه و لپ‌تاپ به سویچ وصل است؟ (آدرس را از منوی دستگاه هم می‌شود دید: Comm. → Ethernet)</p>)}
        {info && (info.ok ? (
          <p className="form-ok">
            دستگاه جواب داد: شمارهٔ سریال <bdi dir="ltr">{info.serial}</bdi> · {fa(info.users ?? 0)} کاربر · {fa(info.fingers ?? 0)} انگشت
            {info.time && <> · ساعت دستگاه <bdi dir="ltr">{info.time}</bdi></>}
          </p>
        ) : <p className="form-error">{k50ErrorText(info.error)}</p>)}
      </section>

      <section className="panel wide">
        <h2>برنامهٔ ارتباط با دستگاه (SDK)</h2>
        {!sdk ? <p className="muted">در حال بررسی…</p>
          : !sdk.ok ? <p className={sdk.error === "sdk_missing" ? "notice warn" : "form-error"}>{k50ErrorText(sdk.error)}</p>
          : sdk.sdk === "app" ? (
            <p className="form-ok">
              برنامه از نسخهٔ خودش استفاده می‌کند{sdk.app_version && <> (نسخهٔ <bdi dir="ltr">{sdk.app_version}</bdi>)</>}.
              ZKAccess دیگر لازم نیست؛ حذف کردنش یا پاک کردن اطلاعاتش به این برنامه آسیبی نمی‌زند.
            </p>
          ) : (
            <p className="notice warn">
              فعلاً از نسخه‌ای استفاده می‌شود که ZKAccess نصب کرده. یک بار «کپی در پوشهٔ برنامه» را بزنید؛ بعد از آن
              ZKAccess را می‌شود حذف کرد.
            </p>
          )}
        <div className="actions">
          <button className={sdk?.sdk === "app" ? "btn ghost" : "btn"} disabled={!!busy || !sdk?.system} onClick={() => void copySdk("")}>
            {busy === "sdk" ? "در حال کپی…" : sdk?.sdk === "app" ? "دوباره کپی کن از ZKAccess" : "کپی در پوشهٔ برنامه"}
          </button>
          {sdk?.sdk !== "app" && copies.length > 0 && (
            <button className={sdk?.system ? "btn ghost" : "btn"} disabled={!!busy} onClick={() => void copySdk(copy)} title={copy}>
              کپی از پشتیبان یا فلش
            </button>
          )}
        </div>
        {sdk?.sdk !== "app" && copies.length > 0 && (
          copies.length === 1
            ? <p className="muted small">یک نسخهٔ SDK در پشتیبان پیدا شد: <bdi dir="ltr">{copy}</bdi></p>
            : (
              <label className="field">
                <span>{fa(copies.length)} نسخهٔ SDK پیدا شد؛ از کدام کپی شود؟</span>
                <select dir="ltr" value={copy} onChange={(e) => setCopy(e.target.value)}>
                  {copies.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )
        )}
        {sdk?.sdk === "app" && <p className="muted small">هر پشتیبان یک نسخه از آن را هم در پوشهٔ <bdi dir="ltr">zk</bdi> نگه می‌دارد، تا کمپیوتر تازه آن را از فلش یا پشتیبان بردارد.</p>}
        <details>
          <summary className="muted small">ZKAccess نصب نیست؟ از پوشهٔ SDK که از سایت ZKTeco گرفته‌اید</summary>
          <div className="form-grid">
            <label className="field">
              <span>آدرس پوشه (همان که zkemkeeper.dll در آن است)</span>
              <input dir="ltr" value={sdkFrom} placeholder={"C:\\Users\\...\\Standalone SDK\\32bit"} onChange={(e) => setSdkFrom(e.target.value)} />
            </label>
          </div>
          <div className="actions">
            <button className="btn ghost" disabled={!!busy || !sdkFrom.trim()} onClick={() => void copySdk(sdkFrom.trim())}>کپی از این پوشه</button>
          </div>
        </details>
        {sdkError && <p className="form-error" role="alert">{sdkError}</p>}
      </section>

      <section className="panel wide">
        <h2>تاریخ عضویت از دستگاه (یک بار)</h2>
        <p className="muted">
          اکسل تاریخ شروع و ختم عضویت ندارد ولی دستگاه دارد. این کار برای اعضایی که در برنامه هیچ تاریخی ندارند، همان
          تاریخی را که دستگاه برایشان دارد ثبت می‌کند؛ بدون پول و بدون بل. اعضایی که در برنامه تاریخ دارند دست نمی‌خورند.
          از آن به بعد تاریخ برنامه حرف اول را می‌زند و با تمدید به دستگاه می‌رود. روز شروع کار، بعد از ورود آخرین اکسل،
          یک بار این را بزنید.
        </p>
        {s.dates_import && (
          <p className="form-ok">آخرین بار {when(s.dates_import.at)}: تاریخ {fa(s.dates_import.added)} عضو از دستگاه ثبت شد.</p>
        )}
        <div className="actions">
          <button className="btn ghost" disabled={!!busy || !saved.ip} onClick={() => void readDates(false)}>
            {busy === "dates" && !dates ? "در حال خواندن دستگاه…" : "اول ببینم چه ثبت می‌شود"}
          </button>
        </div>
        {dates && (
          <>
            <div className="stats-row">
              <div><span className="muted small">{dates.committed ? "ثبت شد" : "ثبت می‌شود"}</span><strong>{fa(dates.added.length)}</strong></div>
              <div><span className="muted small">از قبل تاریخ دارند</span><strong>{fa(dates.has_dates)}</strong></div>
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
                  <input type="checkbox" checked={withDiffers} disabled={!!busy || dates.committed} onChange={(e) => { setWithDiffers(e.target.checked); void readDates(false, e.target.checked); }} />
                  اعضای اکسل در این فهرست هم تاریخ بگیرند (همان آیدی در اکسل و ZKAccess یعنی همان شخص)
                </label>
              </>
            )}
            <div className="table-wrap flush">
              <table className="table">
                <thead><tr><th>آیدی</th><th>نام روی دستگاه</th><th>نام در برنامه</th><th>شروع</th><th>ختم</th></tr></thead>
                <tbody>
                  {[...dates.name_differs.filter((r) => !r.taken), ...dates.added].slice(0, 300).map((r) => (
                    <tr key={r.no} className={r.taken ? "" : "muted"}>
                      <td><bdi dir="ltr">{r.no}</bdi>{!r.taken && <span className="chip">نام فرق دارد</span>}</td>
                      <td>{r.device_name || "—"}</td>
                      <td>{r.app_name}</td>
                      <td>{r.start ? formatDay(r.start) : "—"}</td>
                      <td>{r.end ? formatDay(r.end) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!dates.committed && dates.added.length > 0 && (
              <div className="actions">
                <button className="btn" disabled={!!busy} onClick={() => void readDates(true)}>
                  {busy === "dates" ? "در حال ثبت…" : "همین تاریخ‌ها را ثبت کن"}
                </button>
              </div>
            )}
          </>
        )}
      </section>

      <section className="panel wide">
        <h2>نسخهٔ پشتیبان اثر انگشت‌ها</h2>
        <p className="muted">
          وقتی به‌روزرسانی خودکار روشن است، برنامه هر روز یک بار همهٔ انگشت‌های دستگاه را در دیتابیس خودش نگه می‌دارد. اگر دستگاه کسی را
          گم کند (ریست شدن دستگاه یا «Sync» در ZKAccess)، آن عضو دوباره با همان انگشت‌ها روی دستگاه می‌رود و لازم نیست
          دوباره انگشت بدهد. این انگشت‌ها فقط روی همین لپ‌تاپ و پشتیبان‌هایش می‌مانند و به نسخهٔ آنلاین نمی‌روند.
        </p>
        <div className="stats-row">
          <div><span className="muted small">انگشت ذخیره‌شده</span><strong>{fa(s.fingers_saved)}</strong></div>
          <div>
            <span className="muted small">آخرین بار</span>
            <strong>{s.fingers_backup ? when(s.fingers_backup.at) : "هنوز نه"}</strong>
          </div>
        </div>
        <div className="actions">
          <button className="btn ghost" disabled={!!busy || !saved.ip} onClick={() => void backupFingers()}>
            {busy === "fingers" ? "در حال خواندن انگشت‌ها…" : "همین حالا از دستگاه بخوان"}
          </button>
        </div>
      </section>

      <section className="panel wide">
        <h2>مقایسهٔ آیدی‌ها با دستگاه</h2>
        <p className="muted">
          پیش از روشن کردن به‌روزرسانی خودکار یک بار این را بزنید. همهٔ کاربران دستگاه خوانده می‌شوند (چیزی عوض نمی‌شود) و نام هر آیدی روی
          دستگاه کنار نام همان آیدی در برنامه می‌آید. نام انگلیسی و فارسی، «Moh» به جای «محمد»، «S» به جای «سید» و نام بی‌تخلص خودش یکی شمرده می‌شود.
        </p>
        <div className="actions">
          <button className="btn ghost" disabled={!!busy || !saved.ip} onClick={() => void compare()}>{busy === "compare" ? "در حال خواندن کاربران دستگاه…" : "مقایسهٔ آیدی‌ها با دستگاه"}</button>
        </div>
        {cmp && (
          <>
            <div className="stats-row">
              <div><span className="muted small">کاربر روی دستگاه</span><strong>{fa(cmp.device_users)}</strong></div>
              <div><span className="muted small">نام یکی است</span><strong>{fa(cmp.in_app - cmp.differs)}</strong></div>
              <div className={cmp.differs ? "bad" : ""}><span className="muted small">نام فرق دارد</span><strong>{fa(cmp.differs)}</strong></div>
              <div><span className="muted small">در برنامه نیست</span><strong>{fa(cmp.not_in_app)}</strong></div>
              <div><span className="muted small">مدیر دستگاه</span><strong>{fa(cmp.admins)}</strong></div>
            </div>
            {cmp.differs > 0 ? (
              <div className="notice bad" role="alert">
                <p>
                  نام {fa(cmp.differs)} آیدی روی دستگاه با نام همان آیدی در برنامه جور نمی‌آید (بالای جدول). هر ردیف را نگاه کنید:
                  اگر همان شخص است و فقط جور دیگری نوشته شده (مثلاً بی‌تخلص یا با املای دیگر)، تیکش را بزنید و «همان شخص‌اند» را بزنید.
                  لازم نیست روی دستگاه درستش کنید. اگر واقعاً دو نفر جدا هستند، تیک نزنید؛ تا آن ردیف‌ها درست نشده، خودکار روشن نمی‌شود.
                </p>
                <div className="actions">
                  <button className="btn ghost small" disabled={!!busy} onClick={() => setPicked(new Set(cmp.rows.filter((r) => r.state === "differs").map((r) => r.no)))}>انتخاب همهٔ «فرق دارد»ها</button>
                  {picked.size > 0 && <button className="btn ghost small" disabled={!!busy} onClick={() => setPicked(new Set())}>هیچ‌کدام</button>}
                  <button className="btn small" disabled={!!busy || picked.size === 0} onClick={() => void confirmNames()}>
                    {busy === "names" ? "در حال ثبت…" : `${fa(picked.size)} انتخاب‌شده همان شخص‌اند`}
                  </button>
                </div>
              </div>
            ) : <p className="form-ok">هر آیدی که در برنامه هست، روی دستگاه هم نام همان کس را دارد.</p>}
            {cmp.zero_padded > 0 && (
              <p className="notice warn">{fa(cmp.zero_padded)} آیدی روی دستگاه با صفر شروع می‌شود (مثل <bdi dir="ltr">051003</bdi>). پیش از فرستادن به من بگویید تا تنظیمش کنم.</p>
            )}
            {cmp.freed > 0 && (
              <p className="form-ok">آیدی {fa(cmp.freed)} عضو حذف‌شده روی دستگاه نبود؛ آزاد شد و به اعضای تازه داده می‌شود.</p>
            )}
            {cmp.resend > 0 && (
              <p className="notice warn">
                {fa(cmp.resend)} عضو که برنامه قبلاً فرستاده بود روی دستگاه نیست. در همگام‌سازی بعدی دوباره فرستاده
                می‌شوند، با انگشت‌هایی که برنامه از آن‌ها نگه داشته.
              </p>
            )}
            <div className="list-more">
              <input className="search" type="search" placeholder="جستجوی آیدی یا نام" value={q} aria-label="جستجو در مقایسه"
                onChange={(e) => { setQ(e.target.value); setShown(300); }} />
              <span className="muted small">{fa(rows.length)} ردیف</span>
            </div>
            <div className="table-wrap flush">
              <table className="table">
                <thead><tr><th><span className="sr-only">انتخاب</span></th><th>وضع</th><th>آیدی روی دستگاه</th><th>نام روی دستگاه</th><th>نام در برنامه</th></tr></thead>
                <tbody>
                  {rows.slice(0, shown).map((r) => (
                    <tr key={r.no}>
                      <td>
                        {r.state === "differs" && (
                          <input type="checkbox" aria-label={`${r.device_name} همان ${r.app_name} است`} checked={picked.has(r.no)}
                            onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(r.no); else n.delete(r.no); return n; })} />
                        )}
                      </td>
                      <td>
                        <span className={`status ${r.state === "differs" ? "bad" : r.state === "missing" ? "off" : "on"}`}>
                          {r.state === "differs" ? "فرق دارد" : r.state === "missing" ? "در برنامه نیست" : "یکی"}
                        </span>
                      </td>
                      <td><bdi dir="ltr">{r.no}</bdi>{r.admin && <span className="chip">مدیر دستگاه</span>}</td>
                      <td>{r.device_name || "—"}</td>
                      <td>{r.app_name ?? <span className="muted">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {rows.length > shown && (
              <div className="list-more">
                <span className="muted small">{fa(shown)} از {fa(rows.length)} ردیف</span>
                <button className="btn ghost small" onClick={() => setShown((n) => n + 300)}>نمایش بیشتر</button>
              </div>
            )}
          </>
        )}
      </section>

      <FreeNumbers configured={!!saved.ip} />

      <section className="panel wide">
        <h2>چطور کار می‌کند</h2>
        <ul className="muted">
          <li>هر عضو با همان آیدی عضویتش روی دستگاه است. وقتی عضو ثبت یا تمدید می‌شود، تاریخ شروع و ختمش به دستگاه می‌رود و دستگاه بعد از تاریخ ختم انگشتش را قبول نمی‌کند، حتی اگر لپ‌تاپ خاموش باشد.</li>
          <li>عضوی که عضویتش تمام شود، روی دستگاه «غیرفعال» می‌شود؛ انگشتش پاک نمی‌شود و با تمدید دوباره باز می‌شود.</li>
          <li>عضوی که با «آیدی آزاد شود» حذف شود، با انگشت‌هایش از دستگاه پاک می‌شود و آیدی‌اش به عضو تازه داده می‌شود. آیدی‌ای که دستگاه دیگر ندارد هم با «مقایسهٔ آیدی‌ها» آزاد می‌شود.</li>
          <li>انگشت تازه از صفحهٔ خود عضو با «ثبت انگشت» گرفته می‌شود.</li>
          <li>مدیرهای خود دستگاه دست نمی‌خورند. اعضایی که عضویت فعال ندارند و قبلاً با ZKAccess ثبت شده‌اند، همان‌طور می‌مانند.</li>
        </ul>
      </section>

      {asking && (
        <Modal label="روشن کردن به‌روزرسانی خودکار" onClose={() => !busy && setAsking(false)}>
          <h2>روشن کردن به‌روزرسانی خودکار</h2>
          <p>
            از این به بعد برنامه آیدی، نام و تاریخ عضویت اعضا را خودش به دستگاه می‌فرستد
            {s.pending > 0 && <>؛ همین حالا <strong>{fa(s.pending)} عضو</strong> در نوبت است</>}.
            عضوی که عضویتش تمام شده روی دستگاه غیرفعال می‌شود (انگشتش پاک نمی‌شود).
          </p>
          <div className="actions">
            <button className="btn" autoFocus disabled={!!busy} onClick={() => void setAuto(true)}>{busy === "save" ? "…" : "روشن کن"}</button>
            <button className="btn ghost" disabled={!!busy} onClick={() => setAsking(false)}>انصراف</button>
          </div>
        </Modal>
      )}

      {s.errors.length > 0 && (
        <section className="glass table-wrap">
          <table className="table">
            <caption>اعضایی که دستگاه نپذیرفت (هر نیم ساعت دوباره امتحان می‌شود)</caption>
            <thead><tr><th>آیدی</th><th>نام</th><th>چرا</th><th>کی</th></tr></thead>
            <tbody>
              {s.errors.map((e) => (
                <tr key={e.member_no}>
                  <td><bdi dir="ltr">{e.member_no}</bdi></td>
                  <td>{e.name}</td>
                  <td>{k50ErrorText(e.error)}</td>
                  <td>{when(e.error_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

const latin = (t: string) => t.replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)));

/**
 * Letting numbers go: removed members still holding theirs, and any other ID a partner
 * wants off the device. Each is read from the device first; freeing takes the user off it
 * with every finger, and the number goes to the next new member.
 */
function FreeNumbers({ configured }: { configured: boolean }) {
  const toast = useToast();
  const [held, setHeld] = useState<K50Held[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [typed, setTyped] = useState("");
  const [looked, setLooked] = useState<K50Looked[] | null>(null);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState<"" | "look" | "free">("");
  const [error, setError] = useState("");
  const load = () => api.k50Held().then(setHeld).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);

  async function look(nos: number[]) {
    setError(""); setLooked(null);
    if (!nos.length) return setError("آیدی را بنویسید یا از فهرست انتخاب کنید.");
    setBusy("look");
    try {
      const r = await api.lookK50(nos);
      if (r.Ok) setLooked(r.Ok); else setError(k50ErrorText(r.Err));
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }
  const typedNos = () => [...new Set(latin(typed).split(/[^0-9]+/).filter(Boolean).map(Number).filter((n) => n > 0))];
  const freeable = (looked ?? []).filter((r) => !r.member && !r.device_admin);
  async function free() {
    setSure(false); setBusy("free"); setError("");
    try {
      const r = await api.freeK50(freeable.map((x) => x.no));
      if (!r.Ok) { setError(k50ErrorText(r.Err)); return; }
      const ok = r.Ok.filter((x) => x.ok);
      const bad = r.Ok.filter((x) => !x.ok);
      if (ok.length) toast(`${fa(ok.length)} آیدی آزاد شد${ok.some((x) => x.device_name) ? " و از دستگاه پاک شد" : ""}.`);
      if (bad.length) setError(bad.map((x) => `${x.no}: ${k50ErrorText(x.error)}`).join(" "));
      setLooked(null); setPicked(new Set()); setTyped("");
      await load();
    } catch (e) { setError(errorText(e)); } finally { setBusy(""); }
  }

  return (
    <section className="panel wide">
      <h2>آزاد کردن آیدی و پاک کردن از دستگاه</h2>
      <p className="muted">
        آیدی عضو حذف‌شده تا وقتی روی دستگاه است مال همان شخص می‌ماند، تا عضو تازه انگشت و تاریخ او را نگیرد. اینجا آیدی از دستگاه
        پاک می‌شود (با همهٔ انگشت‌ها) و به عضو تازه داده می‌شود. آیدی عضو فعلی پاک نمی‌شود.
      </p>
      {held && held.length > 0 && (
        <>
          <h3>اعضای حذف‌شده که آیدی‌شان هنوز گرفته است</h3>
          <div className="table-wrap flush">
            <table className="table">
              <thead><tr><th><span className="sr-only">انتخاب</span></th><th>آیدی</th><th>نام</th><th>حذف شده</th><th>وضع</th></tr></thead>
              <tbody>
                {held.map((h) => (
                  <tr key={h.member_id}>
                    <td><input type="checkbox" aria-label={`انتخاب ${h.name}`} checked={picked.has(h.member_no)}
                      onChange={(e) => setPicked((p) => { const n = new Set(p); if (e.target.checked) n.add(h.member_no); else n.delete(h.member_no); return n; })} /></td>
                    <td><bdi dir="ltr">{h.member_no}</bdi></td>
                    <td>{h.name}</td>
                    <td>{h.deleted_at ? formatDay(new Date(h.deleted_at)) : "—"}</td>
                    <td>{h.error ? <><span className="status bad">نشد</span> <span className="muted small">{k50ErrorText(h.error)}</span></> : h.free_no ? <span className="status off">در نوبت</span> : <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn ghost small" disabled={!!busy} onClick={() => setPicked(new Set(held.map((h) => h.member_no)))}>انتخاب همه</button>
            <button className="btn small" disabled={!!busy || !configured || picked.size === 0} onClick={() => void look([...picked])}>
              {busy === "look" ? "در حال خواندن از دستگاه…" : `دیدن ${fa(picked.size)} آیدی روی دستگاه`}
            </button>
          </div>
        </>
      )}
      {held && held.length === 0 && <p className="muted small">هیچ عضو حذف‌شده‌ای آیدی گرفته ندارد.</p>}
      <div className="form-grid">
        <label className="field wide"><span>آیدی دیگری روی دستگاه (چند تا را با فاصله جدا کنید)</span>
          <input dir="ltr" inputMode="numeric" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="1024 1025"
            onKeyDown={(e) => { if (e.key === "Enter") void look(typedNos()); }} />
        </label>
      </div>
      <div className="actions">
        <button className="btn ghost" disabled={!!busy || !configured || !typed.trim()} onClick={() => void look(typedNos())}>
          {busy === "look" ? "در حال خواندن از دستگاه…" : "دیدن روی دستگاه"}
        </button>
      </div>
      {!configured && <p className="muted small">اول آدرس دستگاه را بالا ذخیره کنید.</p>}
      {looked && (
        <>
          <div className="table-wrap flush">
            <table className="table">
              <thead><tr><th>آیدی</th><th>روی دستگاه</th><th>در برنامه</th></tr></thead>
              <tbody>
                {looked.map((r) => (
                  <tr key={r.no} className={r.member || r.device_admin ? "differs" : ""}>
                    <td><bdi dir="ltr">{r.no}</bdi></td>
                    <td>
                      {r.on_device ? <>{r.device_name || "بی‌نام"} <span className="muted small">· {fa(r.fingers ?? 0)} انگشت</span></> : <span className="muted">روی دستگاه نیست</span>}
                      {r.device_admin && <span className="chip">مدیر دستگاه؛ دست نمی‌خورد</span>}
                    </td>
                    <td>
                      {r.member ? <span className="danger-text">عضو فعلی: {r.member} (پاک نمی‌شود)</span>
                        : r.removed_member ? <>حذف‌شده: {r.removed_member}</> : <span className="muted">در برنامه نیست</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="actions">
            <button className="btn danger" disabled={!!busy || freeable.length === 0} onClick={() => setSure(true)}>
              {busy === "free" ? "در حال پاک کردن…" : `پاک کردن ${fa(freeable.length)} آیدی از دستگاه و آزاد کردن`}
            </button>
            <button className="btn ghost" disabled={!!busy} onClick={() => setLooked(null)}>انصراف</button>
          </div>
        </>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      {sure && (
        <Modal label="پاک کردن از دستگاه" onClose={() => setSure(false)}>
          <h2>پاک کردن از دستگاه</h2>
          <p>
            {fa(freeable.length)} آیدی ({freeable.map((r) => r.no).join("، ")}) با همهٔ انگشت‌هایشان از دستگاه پاک می‌شوند و نسخهٔ انگشت‌هایی که
            برنامه نگه داشته هم پاک می‌شود. این کار برنمی‌گردد. بعد از آن این آیدی‌ها به اعضای تازه داده می‌شوند.
          </p>
          <div className="actions">
            <button className="btn danger" onClick={() => void free()}>پاک کن و آزاد کن</button>
            <button className="btn ghost" onClick={() => setSure(false)}>انصراف</button>
          </div>
        </Modal>
      )}
    </section>
  );
}
