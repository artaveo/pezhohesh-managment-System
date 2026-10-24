import { useEffect, useRef, useState, type FormEvent } from "react";
import { api, errorText } from "../lib/api";
import { useAuth } from "../auth/AuthProvider";
import { ColorWheel } from "../components/ColorWheel";
import { useTheme } from "../theme/ThemeProvider";
import { hexToRgb, OFFICIAL_GREEN } from "../theme/color";

export function Settings() {
  return (
    <>
      <MyColor />
      <MyPassword />
    </>
  );
}

function MyColor() {
  const { accent, isOfficial, setAccent, reset } = useTheme();
  const { user, updateUser } = useAuth();
  const [hex, setHex] = useState(accent);
  const [saved, setSaved] = useState<"" | "saving" | "saved" | "error">("");
  useEffect(() => setHex(accent), [accent]);

  // Save to the account a moment after the person stops dragging, so it follows them to any laptop.
  const timer = useRef<number>();
  useEffect(() => {
    const color = isOfficial ? null : accent;
    if (!user || color === user.theme_color) return;
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setSaved("saving");
      api.setTheme(color)
        .then(() => { updateUser({ theme_color: color }); setSaved("saved"); })
        .catch(() => setSaved("error"));
    }, 600);
    return () => window.clearTimeout(timer.current);
  }, [accent, isOfficial, user, updateUser]);

  return (
    <section className="panel">
      <h2>رنگ من</h2>
      <p className="muted">
        رنگ رسمی مجموعه سبز است. هر کاربر می‌تواند برای اپ خودش رنگ دیگری انتخاب کند. بل، رسید و کارت چاپی همیشه با رنگ رسمی چاپ می‌شوند.
      </p>
      <div className="theme-row">
        <ColorWheel value={accent} onChange={setAccent} />
        <div className="theme-side">
          <label className="field">
            <span>کد رنگ</span>
            <input
              id="accent-hex"
              dir="ltr"
              value={hex}
              onChange={(e) => {
                setHex(e.target.value);
                if (hexToRgb(e.target.value)) setAccent(e.target.value.startsWith("#") ? e.target.value : "#" + e.target.value);
              }}
            />
          </label>
          <div className="preview">
            <button className="btn">ثبت عضویت</button>
            <span className="chip">فعال</span>
            <a className="link">نمایش بل</a>
          </div>
          <button className="btn ghost" onClick={reset} disabled={isOfficial}>
            برگشت به رنگ رسمی <bdi dir="ltr">{OFFICIAL_GREEN}</bdi>
          </button>
          <span className="muted small" role="status">
            {saved === "saving" ? "در حال ذخیره…" : saved === "saved" ? "در حساب شما ذخیره شد." : saved === "error" ? "ذخیره نشد؛ دوباره امتحان کنید." : ""}
          </span>
        </div>
      </div>
    </section>
  );
}

function MyPassword() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== repeat) return setMsg({ ok: false, text: "دو رمز جدید یکی نیستند." });
    try {
      await api.changePassword(current, next);
      setCurrent(""); setNext(""); setRepeat("");
      setMsg({ ok: true, text: "رمز شما عوض شد." });
    } catch (err) {
      setMsg({ ok: false, text: errorText(err) });
    }
  }

  return (
    <form className="panel" onSubmit={submit}>
      <h2>رمز من</h2>
      <div className="form-grid">
        <label className="field wide"><span>رمز فعلی</span><input type="password" dir="ltr" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" /></label>
        <label className="field wide"><span>رمز جدید (دست‌کم ۸ حرف)</span><input type="password" dir="ltr" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></label>
        <label className="field wide"><span>تکرار رمز جدید</span><input type="password" dir="ltr" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" /></label>
      </div>
      {msg && <p className={msg.ok ? "form-ok" : "form-error"} role="status">{msg.text}</p>}
      <div className="actions"><button className="btn" disabled={!current || !next}>عوض کردن رمز</button></div>
    </form>
  );
}
