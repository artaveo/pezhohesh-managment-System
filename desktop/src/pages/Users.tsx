import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, ROLE_LABEL, SECTION_LABEL, type PersonRow, type Role, type RoleAccess, type Section, type UserRow } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { fa, formatShort } from "../lib/solar";

const ROLE_HELP: Record<Role, string> = {
  partner: "همه چیز، با تنظیمات و ساخت حساب",
  manager: "کارهای قرائت‌خانه که پایین‌تر برایش تیک زده‌اید؛ بدون تنظیمات و حساب‌ها",
  pec_staff: "فقط پرونده‌ها، بل‌ها و مصارف خدمات تحصیلی",
};

/** Partners create accounts with a temporary password; the person replaces it at first sign-in. */
export function Users() {
  const { user: me } = useAuth();
  const [rows, setRows] = useState<UserRow[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [adding, setAdding] = useState(false);

  const load = () => api.users().then(setRows).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);

  async function change(id: string, patch: Parameters<typeof api.updateUser>[1], done: string) {
    setError("");
    setNotice("");
    try {
      await api.updateUser(id, patch);
      setNotice(done);
      await load();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function resetPassword(u: UserRow) {
    const temp = tempPassword();
    await change(u.id, { reset_password: temp }, `رمز موقت تازهٔ ${u.full_name}: ${temp} — این را به خودش بدهید؛ در ورود بعدی عوضش می‌کند.`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <p className="muted">هر کس با حساب خودش وارد می‌شود و فقط بخش‌هایی را می‌بیند که نقشش اجازه می‌دهد. همهٔ تغییرها با نام کاربر ثبت می‌شوند.</p>
        {!adding && <button className="btn" onClick={() => { setAdding(true); setNotice(""); }}>+ حساب تازه</button>}
      </div>

      {adding && <NewUser onDone={(msg) => { setAdding(false); setNotice(msg); void load(); }} onCancel={() => setAdding(false)} />}
      {notice && <p className="glass notice" role="status">{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="glass table-wrap">
        <table className="table">
          <thead>
            <tr><th>نام</th><th>نام کاربری</th><th>نقش</th><th>آخرین ورود</th><th>وضعیت</th><th /></tr>
          </thead>
          <tbody>
            {rows?.map((u) => (
              <tr key={u.id} className={u.active ? "" : "inactive"}>
                <td><strong>{u.full_name}</strong>{u.id === me?.id && <span className="chip">شما</span>}</td>
                <td><bdi dir="ltr">{u.username}</bdi></td>
                <td>
                  <select value={u.role} disabled={u.id === me?.id}
                    onChange={(e) => void change(u.id, { role: e.target.value as Role }, `نقش ${u.full_name} عوض شد.`)}>
                    {(Object.keys(ROLE_LABEL) as Role[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                  </select>
                  {u.role === "pec_staff" && (
                    <label className="check">
                      <input type="checkbox" checked={u.can_see_pec_finance}
                        onChange={(e) => void change(u.id, { can_see_pec_finance: e.target.checked }, "دسترسی گزارش مالی خدمات تحصیلی عوض شد.")} />
                      گزارش مالی
                    </label>
                  )}
                </td>
                <td className="muted">{u.last_login_at ? formatShort(new Date(u.last_login_at)) : "هنوز وارد نشده"}</td>
                <td>
                  {!u.active ? <span className="status off">غیرفعال</span>
                    : u.must_change_password ? <span className="status wait">منتظر رمز تازه</span>
                    : <span className="status on">فعال</span>}
                </td>
                <td>
                  {u.id !== me?.id && (
                    <div className="row-actions">
                      <button className="btn ghost small" onClick={() => void resetPassword(u)}>رمز موقت تازه</button>
                      <button className="btn ghost small"
                        onClick={() => void change(u.id, { active: !u.active }, u.active ? `حساب ${u.full_name} غیرفعال شد.` : `حساب ${u.full_name} دوباره فعال شد.`)}>
                        {u.active ? "غیرفعال کن" : "فعال کن"}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!rows && !error && <p className="muted">در حال بارگذاری…</p>}
      </div>

      <RoleSections />
      <People onMerged={(msg) => { setNotice(msg); void load(); }} />
    </div>
  );
}

/**
 * Which sections the manager and the education staff see: tick and it is saved. Partners
 * always see everything. Someone already signed in gets the new menu when the app next
 * checks who they are (at the latest when they sign in again); the API refuses closed
 * sections at once.
 */
function RoleSections() {
  const [data, setData] = useState<RoleAccess | null>(null);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  useEffect(() => { api.roleAccess().then(setData, (e) => setError(errorText(e))); }, []);

  async function toggle(role: Role, section: Section, on: boolean) {
    if (!data) return;
    const row = data.roles.find((r) => r.role === role)!;
    const sections = on ? [...row.sections, section] : row.sections.filter((x) => x !== section);
    setData({ roles: data.roles.map((r) => (r.role === role ? { ...r, sections } : r)) });
    setError("");
    setSaved("");
    try {
      await api.setRoleAccess(role, sections);
      setSaved(`ذخیره شد: ${ROLE_LABEL[role]}`);
    } catch (e) {
      setError(errorText(e));
      setData(await api.roleAccess().catch(() => data));
    }
  }

  return (
    <section className="glass role-sections">
      <h2>هر نقش چه بخش‌هایی را ببیند</h2>
      <p className="muted small">
        شرکا همیشه همه چیز را می‌بینند. برای مدیر و کارمند خدمات تحصیلی تیک بزنید؛ همان لحظه ذخیره می‌شود.
        کاربرانی که الان وارد هستند فهرست تازه را با ورود بعدی می‌بینند، ولی بخش بسته از همین حالا برایشان باز نمی‌شود.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      {saved && <p className="muted small" role="status">{saved}</p>}
      {data && (
        <div className="role-grid">
          {data.roles.map((r) => (
            <fieldset key={r.role}>
              <legend>{ROLE_LABEL[r.role]}</legend>
              {r.possible.map((sec) => (
                <label key={sec} className="check big">
                  <input type="checkbox" checked={r.sections.includes(sec)} onChange={(e) => void toggle(r.role, sec, e.target.checked)} />
                  {SECTION_LABEL[sec]}
                </label>
              ))}
              {r.role === "pec_staff" && (
                <p className="muted small">بخش‌های قرائت‌خانه به حساب‌های خدمات تحصیلی داده نمی‌شود؛ دیتابیس هم به این نقش اجازهٔ دیدن آن‌ها را نمی‌دهد. برای کسی که هر دو کار را می‌کند، نقش «مدیر» بدهید.</p>
              )}
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Everyone in the books, and joining two names of one person (a sign-in account typed in
 * English, and the same partner from the Excel book with the withdrawals).
 */
function People({ onMerged }: { onMerged: (msg: string) => void }) {
  const [rows, setRows] = useState<PersonRow[] | null>(null);
  const [from, setFrom] = useState("");
  const [into, setInto] = useState("");
  const [sure, setSure] = useState(false);
  const [error, setError] = useState("");
  const load = () => api.people().then(setRows).catch((e) => setError(errorText(e)));
  useEffect(() => { void load(); }, []);

  async function merge() {
    const a = rows?.find((r) => r.id === from);
    const b = rows?.find((r) => r.id === into);
    if (!a || !b) return;
    setError("");
    try {
      await api.mergePeople(from, into);
      setFrom(""); setInto(""); setSure(false);
      await load();
      onMerged(`«${a.full_name}» و «${b.full_name}» یکی شدند؛ حالا همه‌جا «${b.full_name}» دیده می‌شود.`);
    } catch (e) {
      setError(errorText(e));
    }
  }

  const label = (r: PersonRow) => `${r.full_name}${r.title ? ` (${r.title})` : ""}${r.usernames.length ? ` · حساب ${r.usernames.join("، ")}` : ""} · ${fa(r.withdrawals)} برداشت`;
  return (
    <section className="panel wide">
      <h2>اشخاص</h2>
      <p className="muted">
        همهٔ کسانی که در حساب‌ها نامشان هست. اگر یک نفر دو بار آمده (مثلاً «Zakir Naseri» از حساب ورود و «ذاکر ناصری» از اکسل)،
        اینجا یکی‌شان کنید: حساب ورود و برداشت‌های نام اول به نام دوم می‌رود و نام اول دیگر دیده نمی‌شود.
      </p>
      <div className="glass table-wrap">
        <table className="table">
          <thead><tr><th>نام</th><th>عنوان</th><th>حساب ورود</th><th>برداشت‌ها</th></tr></thead>
          <tbody>
            {rows?.map((r) => (
              <tr key={r.id}>
                <td><strong>{r.full_name}</strong></td>
                <td>{r.title ?? "—"}</td>
                <td>{r.usernames.length ? r.usernames.map((u) => <bdi key={u} dir="ltr">{u} </bdi>) : <span className="muted">ندارد</span>}</td>
                <td className="num">{fa(r.withdrawals)} · {fa(r.withdrawn)} افغانی</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="form-grid">
        <label className="field wide span-2">
          <span>این نام برداشته شود</span>
          <select value={from} onChange={(e) => { setFrom(e.target.value); setSure(false); }}>
            <option value="">انتخاب کنید</option>
            {rows?.map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
          </select>
        </label>
        <label className="field wide span-2">
          <span>و یکی شود با این نام (که می‌ماند)</span>
          <select value={into} onChange={(e) => { setInto(e.target.value); setSure(false); }}>
            <option value="">انتخاب کنید</option>
            {rows?.filter((r) => r.id !== from).map((r) => <option key={r.id} value={r.id}>{label(r)}</option>)}
          </select>
        </label>
      </div>
      {from && into && (
        <label className="check">
          <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} />
          مطمئنم که این دو نام یک نفرند.
        </label>
      )}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions"><button className="btn" disabled={!from || !into || !sure} onClick={() => void merge()}>یکی کن</button></div>
    </section>
  );
}

function NewUser({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [fullName, setFullName] = useState("");
  const [person, setPerson] = useState("");
  const [people, setPeople] = useState<PersonRow[]>([]);
  useEffect(() => { api.people().then((p) => setPeople(p.filter((x) => !x.usernames.length))).catch(() => {}); }, []);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("manager");
  const [pecFinance, setPecFinance] = useState(false);
  const [password] = useState(tempPassword);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api.createUser({ full_name: fullName, username, password, role, can_see_pec_finance: pecFinance, staff_id: person || undefined });
      onDone(`حساب ${fullName} ساخته شد. نام کاربری: ${username.trim().toLowerCase()} — رمز موقت: ${password}. در ورود اول، رمز خودش را می‌گذارد.`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="glass new-user" onSubmit={submit}>
      <h2>حساب تازه</h2>
      <div className="form-grid">
        {people.length > 0 && (
          <label className="field wide">
            <span>از اشخاص موجود (اگر نامش در حساب‌ها هست)</span>
            <select value={person} onChange={(e) => { setPerson(e.target.value); setFullName(people.find((p) => p.id === e.target.value)?.full_name ?? ""); }}>
              <option value="">شخص تازه</option>
              {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}{p.title ? ` (${p.title})` : ""}</option>)}
            </select>
          </label>
        )}
        <label className="field wide"><span>نام کامل</span><input value={fullName} disabled={!!person} onChange={(e) => setFullName(e.target.value)} autoFocus /></label>
        <label className="field wide"><span>نام کاربری (انگلیسی)</span><input dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} /></label>
      </div>
      <fieldset className="roles">
        <legend>نقش</legend>
        {(Object.keys(ROLE_LABEL) as Role[]).map((r) => (
          <label key={r} className={`role-option${role === r ? " on" : ""}`}>
            <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} />
            <strong>{ROLE_LABEL[r]}</strong>
            <span className="muted small">{ROLE_HELP[r]}</span>
          </label>
        ))}
      </fieldset>
      {role === "pec_staff" && (
        <label className="check"><input type="checkbox" checked={pecFinance} onChange={(e) => setPecFinance(e.target.checked)} /> گزارش مالی خدمات تحصیلی را هم ببیند</label>
      )}
      <p className="muted small">رمز موقت: <bdi dir="ltr" className="mono">{password}</bdi></p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn" disabled={busy || !fullName || !username}>ساخت حساب</button>
        <button type="button" className="btn ghost" onClick={onCancel}>انصراف</button>
      </div>
    </form>
  );
}

/** 10 easy-to-read characters (no 0/O, 1/l/I). */
function tempPassword() {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => abc[b % abc.length]).join("");
}
