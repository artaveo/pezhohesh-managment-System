import { useId } from "react";
import { fa } from "../lib/solar";
import { inWords } from "../lib/words";

/**
 * An amount in Afghani: digits only, and under it the same amount grouped and in words,
 * so 25000 and 250000 are not mixed up.
 */
export function AmountInput({ label, value, onChange, required, wide = true, autoFocus }: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  wide?: boolean;
  autoFocus?: boolean;
}) {
  const hint = useId();
  const n = Number(value);
  return (
    <label className={`field${wide ? " wide" : ""}`}>
      <span>{label}{required && " *"}</span>
      <input dir="ltr" inputMode="numeric" value={value} autoFocus={autoFocus} aria-describedby={hint}
        onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ""))} />
      <small id={hint} className="field-hint">{value && n > 0 ? `${fa(n)} افغانی · ${inWords(n)}` : " "}</small>
    </label>
  );
}
