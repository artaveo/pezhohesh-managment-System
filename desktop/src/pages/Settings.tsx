import { useEffect, useState } from "react";
import { ColorWheel } from "../components/ColorWheel";
import { useTheme } from "../theme/ThemeProvider";
import { hexToRgb, OFFICIAL_GREEN } from "../theme/color";

export function Settings() {
  const { accent, isOfficial, setAccent, reset } = useTheme();
  const [hex, setHex] = useState(accent);
  useEffect(() => setHex(accent), [accent]);

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
        </div>
      </div>
    </section>
  );
}
