import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Prints `children` alone on A4 (the app itself is hidden while printing), once it is on
 * the page; `landscape` for the 12-month sheet.
 */
export function PrintCopy({ on, landscape, onDone, children }: { on: boolean; landscape?: boolean; onDone: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!on) return;
    const style = document.createElement("style");
    style.textContent = `@page { size: A4 ${landscape ? "landscape" : "portrait"}; margin: 12mm; }`;
    document.head.appendChild(style);
    const done = () => { style.remove(); onDone(); };
    window.addEventListener("afterprint", done, { once: true });
    const t = window.setTimeout(() => window.print(), 50);
    return () => { window.clearTimeout(t); window.removeEventListener("afterprint", done); style.remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  return on ? createPortal(<div className="print-only report-print">{children}</div>, document.body) : null;
}
