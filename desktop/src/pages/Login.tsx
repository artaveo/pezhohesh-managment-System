import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errorText } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { PasswordInput } from "../components/PasswordInput";
import { canSaveLogin, forgetLogin, saveLogin, savedLogin, updateSavedPassword, type SavedLogin } from "../lib/savedLogin";

export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="glass auth-card">
        <div className="auth-brand">
          <img src="/logo-study-hall.png" alt="" />
          <div>
            <strong>پژوهش</strong>
            <span>سیستم مدیریت کتابخانه و خدمات تحصیلی</span>
          </div>
        </div>
        <div>
          <h1>{title}</h1>
          <p className="muted">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field(props: { label: string; type?: string; value: string; onChange: (v: string) => void; autoFocus?: boolean; ltr?: boolean; autoComplete?: string }) {
  return (
    <label className="field wide">
      <span>{props.label}</span>
      {props.type === "password" ? (
        <PasswordInput value={props.value} onChange={props.onChange} autoFocus={props.autoFocus} autoComplete={props.autoComplete} />
      ) : (
        <input
          type={props.type ?? "text"}
          dir={props.ltr ? "ltr" : undefined}
          value={props.value}
          autoFocus={props.autoFocus}
          autoComplete={props.autoComplete}
          onChange={(e) => props.onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export function Login() {
  const { signIn } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [saved, setSaved] = useState<SavedLogin | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // A password saved on this computer fills the form; the person still presses "ورود".
  useEffect(() => {
    savedLogin().then((s) => {
      if (!s) return;
      setSaved(s);
      setUsername(s.username);
      setPassword(s.password);
      setRemember(true);
    });
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await api.login(username, password);
      await (remember ? saveLogin(username, password) : forgetLogin());
      signIn(s.token, s.user);
    } catch (err) {
      setError(errorText(err));
      setPassword("");
      // A saved password that no longer works (changed on another computer) is dropped.
      if (err instanceof ApiError && err.code === "invalid_login" && saved?.username === username && saved.password === password) {
        await forgetLogin();
        setSaved(null);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="ورود" subtitle="با نام کاربری و رمز خودتان وارد شوید.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="نام کاربری" value={username} onChange={setUsername} autoFocus ltr autoComplete="username" />
        <Field label="رمز" type="password" value={password} onChange={setPassword} ltr autoComplete="current-password" />
        {canSaveLogin() && (
          <label className="check remember">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            رمز را در این کمپیوتر به خاطر بسپار
          </label>
        )}
        {remember && <p className="muted small">هر کسی که این کمپیوتر را باز کند می‌تواند با حساب شما وارد شود. روی کمپیوتر مشترک تیک نزنید.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn big" disabled={busy || !username || !password}>{busy ? "در حال ورود…" : "ورود"}</button>
      </form>
    </AuthCard>
  );
}

/** First run on a new database: the first account is a partner. */
export function FirstSetup() {
  const { signIn } = useAuth();
  const [fullName, setFullName] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password !== repeat) return setError("دو رمز یکی نیستند.");
    setBusy(true);
    setError("");
    try {
      const s = await api.setup({ full_name: fullName, username, password });
      signIn(s.token, s.user);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="راه‌اندازی اول" subtitle="حساب اولین شریک را بسازید. بعد از آن، حساب بقیه را از بخش «کاربران» می‌سازید.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="نام کامل" value={fullName} onChange={setFullName} autoFocus />
        <Field label="نام کاربری (انگلیسی)" value={username} onChange={setUsername} ltr autoComplete="username" />
        <Field label="رمز (دست‌کم 8 حرف)" type="password" value={password} onChange={setPassword} ltr autoComplete="new-password" />
        <Field label="تکرار رمز" type="password" value={repeat} onChange={setRepeat} ltr autoComplete="new-password" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn big" disabled={busy || !fullName || !username || !password}>ساخت حساب و ورود</button>
      </form>
    </AuthCard>
  );
}

/** Shown after a partner created or reset the account: the person picks their own password. */
export function ForcePasswordChange() {
  const { user, updateUser, signOut } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setError("دو رمز جدید یکی نیستند.");
    setBusy(true);
    setError("");
    try {
      await api.changePassword(current, next);
      if (user) await updateSavedPassword(user.username, next);
      updateUser({ must_change_password: false });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title={`سلام ${user?.full_name ?? ""}`} subtitle="برای حفاظت از حساب، رمز موقت را با رمز خودتان عوض کنید.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="رمز موقت" type="password" value={current} onChange={setCurrent} autoFocus ltr autoComplete="current-password" />
        <Field label="رمز جدید (دست‌کم 8 حرف)" type="password" value={next} onChange={setNext} ltr autoComplete="new-password" />
        <Field label="تکرار رمز جدید" type="password" value={repeat} onChange={setRepeat} ltr autoComplete="new-password" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn big" disabled={busy || !current || !next}>ذخیره و ادامه</button>
        <button type="button" className="btn ghost" onClick={() => void signOut()}>خروج</button>
      </form>
    </AuthCard>
  );
}
