import { useState, type FormEvent, type ReactNode } from "react";
import { api, errorText } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { PasswordInput } from "../components/PasswordInput";

function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
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
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const s = await api.login(username, password);
      signIn(s.token, s.user);
    } catch (err) {
      setError(errorText(err));
      setPassword("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="ورود" subtitle="با نام کاربری و رمز خودتان وارد شوید.">
      <form className="auth-form" onSubmit={submit}>
        <Field label="نام کاربری" value={username} onChange={setUsername} autoFocus ltr autoComplete="username" />
        <Field label="رمز" type="password" value={password} onChange={setPassword} ltr autoComplete="current-password" />
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
        <Field label="رمز (دست‌کم ۸ حرف)" type="password" value={password} onChange={setPassword} ltr autoComplete="new-password" />
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
        <Field label="رمز جدید (دست‌کم ۸ حرف)" type="password" value={next} onChange={setNext} ltr autoComplete="new-password" />
        <Field label="تکرار رمز جدید" type="password" value={repeat} onChange={setRepeat} ltr autoComplete="new-password" />
        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="btn big" disabled={busy || !current || !next}>ذخیره و ادامه</button>
        <button type="button" className="btn ghost" onClick={() => void signOut()}>خروج</button>
      </form>
    </AuthCard>
  );
}

export function Offline({ onRetry, loading }: { onRetry: () => void; loading: boolean }) {
  return (
    <AuthCard
      title={loading ? "در حال وصل شدن…" : "هستهٔ سیستم در دسترس نیست"}
      subtitle={loading ? "چند لحظه صبر کنید." : "برنامه نتوانست به هستهٔ سیستم وصل شود. مطمئن شوید PostgreSQL روشن است و دوباره امتحان کنید."}
    >
      {!loading && <button className="btn big" onClick={onRetry}>دوباره امتحان کن</button>}
    </AuthCard>
  );
}
