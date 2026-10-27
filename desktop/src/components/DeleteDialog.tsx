import { useState, type ReactNode } from "react";
import { errorText } from "../lib/api";
import { Modal } from "./Modal";

/**
 * Asking before a removal, with the reason that goes into «چه کسی چه کرد». Nothing is
 * erased: a partner can bring the line back from there.
 */
export function DeleteDialog({ title, children, action = "حذف کن", reasonRequired, onConfirm, onClose }: {
  title: string;
  children?: ReactNode;
  action?: string;
  reasonRequired?: boolean;
  onConfirm: (reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function confirm() {
    if (reasonRequired && !reason.trim()) { setError("دلیل را بنویسید."); return; }
    setBusy(true);
    try { await onConfirm(reason.trim()); } catch (e) { setError(errorText(e)); setBusy(false); }
  }
  return (
    <Modal label={title} onClose={onClose}>
      <h2>{title}</h2>
      {children && <div className="muted">{children}</div>}
      <label className="field wide">
        <span>دلیل{reasonRequired ? " *" : ""}</span>
        <input value={reason} onChange={(e) => { setReason(e.target.value); setError(""); }} autoFocus placeholder="مثلاً: دو بار ثبت شده بود"
          onKeyDown={(e) => { if (e.key === "Enter") void confirm(); }} />
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn danger" disabled={busy} onClick={() => void confirm()}>{action}</button>
        <button className="btn ghost" onClick={onClose}>انصراف</button>
      </div>
    </Modal>
  );
}
