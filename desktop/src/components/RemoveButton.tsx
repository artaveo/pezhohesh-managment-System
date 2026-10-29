import { useEffect, useState } from "react";

/** "حذف", then "حذف شود؟" for a few seconds: one slip of the mouse does not remove a line. */
export function RemoveButton({ onConfirm }: { onConfirm: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = window.setTimeout(() => setAsking(false), 4000);
    return () => window.clearTimeout(t);
  }, [asking]);
  return asking
    ? <button className="btn small danger" onClick={() => { setAsking(false); onConfirm(); }}>حذف شود؟</button>
    : <button className="btn small ghost" onClick={() => setAsking(true)}>حذف</button>;
}
