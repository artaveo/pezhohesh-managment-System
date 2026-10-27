import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A dialog over the page: Esc or a click outside closes it, Tab stays inside it, and the
 * focus goes back to the button that opened it. `bare` leaves out the panel (for a picture
 * or a printable card that brings its own frame).
 */
export function Modal({ label, onClose, children, bare, className = "" }: {
  label: string;
  onClose: () => void;
  children: ReactNode;
  bare?: boolean;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const el = box.current;
    if (el && !el.contains(document.activeElement)) (el.querySelector<HTMLElement>("[autofocus]") ?? el.querySelector<HTMLElement>(FOCUSABLE) ?? el).focus();
    function key(e: KeyboardEvent) {
      if (e.key === "Escape") { e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab" || !el) return;
      const all = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((x) => x.offsetParent !== null);
      if (!all.length) return;
      const [first, last] = [all[0], all[all.length - 1]];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", key, true);
    return () => { document.removeEventListener("keydown", key, true); opener?.focus?.(); };
  }, []);

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={label} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={box} tabIndex={-1} className={`modal-body${bare ? "" : " panel"} ${className}`.trim()}>{children}</div>
    </div>
  );
}
