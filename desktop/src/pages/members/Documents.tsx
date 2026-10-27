import { useRef, useState } from "react";
import { api, ApiError, errorText, type DocKind, type MemberDocument } from "../../lib/api";
import { shrink, useDocumentUrl } from "../../lib/images";
import { CameraCapture } from "../../components/CameraCapture";
import { RemoveButton } from "../../components/RemoveButton";
import { Modal } from "../../components/Modal";

const MAX_BYTES = 10 * 1024 * 1024;

const SLOTS: { kind: DocKind; label: string; side: number }[] = [
  { kind: "photo", label: "عکس عضو (برای کارت)", side: 800 },
  { kind: "tazkira_front", label: "تذکره، روی اول", side: 1600 },
  { kind: "tazkira_back", label: "تذکره، روی دوم", side: 1600 },
];

/** The member's photo and tazkira scans: add from a file or the camera, view, remove. */
export function Documents({ memberId, docs, onChange }: { memberId: string; docs: MemberDocument[]; onChange: () => void }) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<DocKind | null>(null);
  const [camera, setCamera] = useState<DocKind | null>(null);
  const [view, setView] = useState<MemberDocument | null>(null);

  async function add(kind: DocKind, file: Blob) {
    const slot = SLOTS.find((s) => s.kind === kind)!;
    setBusy(kind);
    setError("");
    try {
      if (file.type !== "application/pdf" && !file.type.startsWith("image/")) throw new Error("type");
      if (kind === "photo" && file.type === "application/pdf") throw new Error("type");
      const small = await shrink(file, slot.side);
      if (small.size > MAX_BYTES) throw new ApiError(413, "file_too_large");
      await api.addDocument(memberId, kind, small);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? errorText(e)
        : e instanceof Error && e.message === "type" ? errorText(new ApiError(400, "bad_file_type"))
        : "این عکس باز نشد. آن را JPG یا PNG ذخیره کنید و دوباره امتحان کنید.");
    } finally {
      setBusy(null);
    }
  }
  async function remove(id: string) {
    try { await api.deleteDocument(id); onChange(); } catch (e) { setError(errorText(e)); }
  }

  return (
    <section className="panel wide">
      <h2>عکس و تذکره</h2>
      <div className="doc-slots">
        {SLOTS.map((s) => {
          const doc = docs.find((d) => d.kind === s.kind);
          return (
            <Slot key={s.kind} label={s.label} doc={doc} busy={busy === s.kind} pdf={s.kind !== "photo"}
              onFile={(f) => void add(s.kind, f)} onCamera={() => setCamera(s.kind)}
              onView={() => doc && setView(doc)} onRemove={() => doc && void remove(doc.id)} />
          );
        })}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
      {camera && (
        <CameraCapture portrait={camera === "photo"} onClose={() => setCamera(null)}
          onTaken={(b) => { const k = camera; setCamera(null); void add(k, b); }} />
      )}
      {view && <Viewer doc={view} onClose={() => setView(null)} />}
    </section>
  );
}

function Slot({ label, doc, busy, pdf, onFile, onCamera, onView, onRemove }: {
  label: string; doc?: MemberDocument; busy: boolean; pdf: boolean;
  onFile: (f: File) => void; onCamera: () => void; onView: () => void; onRemove: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const { url, failed } = useDocumentUrl(doc && doc.mime_type !== "application/pdf" ? doc.id : null);
  return (
    <div className="doc-slot">
      <span className="muted small">{label}</span>
      <button type="button" className="doc-thumb" onClick={doc ? onView : () => input.current?.click()} aria-label={doc ? `دیدن ${label}` : `افزودن ${label}`}>
        {busy ? <span className="muted">در حال ذخیره…</span>
          : doc?.mime_type === "application/pdf" ? <span>PDF</span>
          : url ? <img src={url} alt="" />
          : failed ? <span className="form-error small">فایل باز نشد</span>
          : doc ? <span className="muted">…</span>
          : <span className="muted">+ افزودن</span>}
      </button>
      <input ref={input} type="file" hidden accept={pdf ? "image/*,application/pdf" : "image/*"}
        onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) onFile(f); }} />
      <div className="doc-actions">
        <button type="button" className="btn ghost small" disabled={busy} onClick={() => input.current?.click()}>{doc ? "تعویض" : "فایل"}</button>
        <button type="button" className="btn ghost small" disabled={busy} onClick={onCamera}>کمره</button>
        {doc && <RemoveButton onConfirm={onRemove} />}
      </div>
    </div>
  );
}

function Viewer({ doc, onClose }: { doc: MemberDocument; onClose: () => void }) {
  const { url, failed } = useDocumentUrl(doc.id);
  return (
    <Modal label="عکس" onClose={onClose} bare className="doc-view">
      <div className="modal-tools"><button className="btn ghost" onClick={onClose}>بستن</button></div>
      {failed ? <p className="form-error">{errorText(new ApiError(404, "file_missing"))}</p>
        : !url ? <p className="muted">در حال بارگذاری…</p>
        : doc.mime_type === "application/pdf" ? <iframe src={url} title="PDF" />
        : <img src={url} alt="" />}
    </Modal>
  );
}
