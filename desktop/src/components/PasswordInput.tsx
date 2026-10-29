import { useState } from "react";
import { Icon } from "./Icon";

/** Password box with our own show/hide eye; the browser's own reveal button disappears after blur. */
export function PasswordInput(props: { value: string; onChange: (v: string) => void; autoFocus?: boolean; autoComplete?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <span className="pw">
      <input
        type={shown ? "text" : "password"}
        dir="ltr"
        value={props.value}
        autoFocus={props.autoFocus}
        autoComplete={props.autoComplete}
        onChange={(e) => props.onChange(e.target.value)}
      />
      <button type="button" className="pw-eye" aria-label={shown ? "پنهان کردن رمز" : "نمایش رمز"} aria-pressed={shown}
        title={shown ? "پنهان کردن رمز" : "نمایش رمز"} onClick={() => setShown((s) => !s)}>
        <Icon name={shown ? "eyeOff" : "eye"} size={18} />
      </button>
    </span>
  );
}
