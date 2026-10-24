import { useEffect, useState, type FormEvent } from "react";
import { api, errorText, ROLE_LABEL, type Role, type UserRow } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { formatShort } from "../lib/solar";

const ROLE_HELP: Record<Role, string> = {
  partner: "همه چیز، با تنظیمات و ساخت حساب",
  manager: "همهٔ کارهای قرائت‌خانه و حساب‌ها؛ بدون تنظیمات و حساب‌ها",
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
    </div>
  );
}

function NewUser({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [fullName, setFullName] = useState("");
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
      await api.createUser({ full_name: fullName, username, password, role, can_see_pec_finance: pecFinance });
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
        <label className="field wide"><span>نام کامل</span><input value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus /></label>
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
