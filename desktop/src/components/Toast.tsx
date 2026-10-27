import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { errorText } from "../lib/api";

type Toast = { id: number; text: string; undo?: () => Promise<void> };
const Ctx = createContext<(text: string, undo?: () => Promise<void>) => void>(() => {});

/** A short note at the bottom of the window, with «برگرداندن» after a removal. */
export function useToast() {
  return useContext(Ctx);
}

export function ToastHost({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const show = useCallback((text: string, undo?: () => Promise<void>) => setToast({ id: Date.now(), text, undo }), []);
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast((x) => (x?.id === toast.id ? null : x)), toast.undo ? 8000 : 4000);
    return () => window.clearTimeout(t);
  }, [toast]);
  async function undo(t: Toast) {
    try { await t.undo!(); setToast({ id: Date.now(), text: "برگردانده شد." }); } catch (e) { setToast({ id: Date.now(), text: errorText(e) }); }
  }
  return (
    <Ctx.Provider value={show}>
      {children}
      <div className="toast-slot" role="status" aria-live="polite">
        {toast && (
          <div className="toast" key={toast.id}>
            <span>{toast.text}</span>
            {toast.undo && <button className="btn small" onClick={() => void undo(toast)}>برگرداندن</button>}
            <button className="btn small ghost" aria-label="بستن" onClick={() => setToast(null)}>×</button>
          </div>
        )}
      </div>
    </Ctx.Provider>
  );
}
