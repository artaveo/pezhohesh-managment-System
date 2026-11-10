import { Modal } from "./Modal";
import { Icon } from "./Icon";

/**
 * A photo or scan over the whole window, fitted so all of it shows without scrolling, with
 * save and print. A PDF is shown in the browser's own viewer, which has both already.
 */
export function ImageViewer({ url, name, pdf, label = "عکس", onClose, failed }: {
  url: string | null;
  /** File name when saved, without the extension. */
  name: string;
  pdf?: boolean;
  label?: string;
  failed?: string;
  onClose: () => void;
}) {
  function save() {
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}.${pdf ? "pdf" : "jpg"}`;
    document.body.append(a);
    a.click();
    a.remove();
  }
  function print() {
    if (!url) return;
    // A frame of its own, so only the picture is printed, one page, as large as fits.
    const f = document.createElement("iframe");
    f.style.cssText = "position:fixed;width:0;height:0;border:0;visibility:hidden";
    f.srcdoc = `<!doctype html><style>@page{margin:10mm}html,body{margin:0;height:100%}body{display:grid;place-items:center}img{max-width:100%;max-height:100vh;object-fit:contain}</style><img src="${url}">`;
    f.onload = () => {
      const img = f.contentDocument?.querySelector("img");
      const go = () => { f.contentWindow?.focus(); f.contentWindow?.print(); window.setTimeout(() => f.remove(), 1000); };
      if (img && !img.complete) img.onload = go; else go();
    };
    document.body.append(f);
  }
  return (
    <Modal label={label} onClose={onClose} bare className="lightbox">
      <div className="lightbox-bar">
        <span className="lightbox-title">{label}</span>
        <div className="lightbox-tools">
          {!pdf && <button className="btn ghost" disabled={!url} onClick={print}><Icon name="print" />چاپ</button>}
          <button className="btn ghost" disabled={!url} onClick={save}><Icon name="download" />ذخیره</button>
          <button className="btn ghost" onClick={onClose} autoFocus aria-label="بستن">بستن ✕</button>
        </div>
      </div>
      <div className="lightbox-stage" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
        {failed ? <p className="form-error">{failed}</p>
          : !url ? <p className="muted">در حال بارگذاری…</p>
          : pdf ? <iframe src={url} title={label} />
          : <img src={url} alt={label} />}
      </div>
    </Modal>
  );
}
