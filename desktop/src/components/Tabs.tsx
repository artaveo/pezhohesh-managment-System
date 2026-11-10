/** A row of buttons that picks one of a few views (the pressed one is the view shown). */
export function Tabs<T extends string>({ label, value, items, onChange, sub }: {
  label: string; value: T; items: { id: T; label: string; hint?: string; badge?: number }[]; onChange: (v: T) => void; sub?: boolean;
}) {
  return (
    <div className={`segmented${sub ? " sub" : ""}`} role="group" aria-label={label}>
      {items.map((i) => (
        <button key={i.id} aria-pressed={value === i.id} className={value === i.id ? "on" : ""} onClick={() => onChange(i.id)}>
          {i.label}{i.hint && <small className="muted"> {i.hint}</small>}
          {!!i.badge && <span className="badge" aria-label={`${i.badge} منتظر`}>{i.badge}</span>}
        </button>
      ))}
    </div>
  );
}
