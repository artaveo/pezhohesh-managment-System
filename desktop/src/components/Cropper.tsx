import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

type Rect = { x: number; y: number; w: number; h: number };
type Grip = "move" | "nw" | "ne" | "sw" | "se" | "n" | "s" | "e" | "w";
const MIN = 40;

/**
 * Cuts a picture down to the part that matters (a face for the card, the tazkira without the
 * table around it). Drag the box or its corners and edges; «چرخاندن» turns the picture a
 * quarter. The result is a new picture; the original is not changed.
 */
export function Cropper({ src, onCancel, onDone, busy }: {
  src: Blob;
  onCancel: () => void;
  onDone: (b: Blob) => void;
  busy?: boolean;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [source, setSource] = useState<Blob>(src);
  const [rect, setRect] = useState<Rect | null>(null);
  const img = useRef<HTMLImageElement>(null);
  const drag = useRef<{ grip: Grip; x: number; y: number; start: Rect } | null>(null);

  useEffect(() => {
    const u = URL.createObjectURL(source);
    setUrl(u);
    setRect(null);
    return () => URL.revokeObjectURL(u);
  }, [source]);

  // The box starts as the whole picture, once it is drawn and its size on screen is known.
  function loaded() {
    if (!img.current) return;
    const r = img.current.getBoundingClientRect();
    setRect({ x: 0, y: 0, w: r.width, h: r.height });
  }
  // A window resized redraws the picture at another size: the box starts again from the whole.
  useEffect(() => {
    window.addEventListener("resize", loaded);
    return () => window.removeEventListener("resize", loaded);
  }, []);

  function down(grip: Grip) {
    return (e: ReactPointerEvent) => {
      if (!rect) return;
      e.preventDefault();
      e.stopPropagation();
      try { (e.target as Element).setPointerCapture(e.pointerId); } catch { /* the box still follows moves over the whole cropper */ }
      drag.current = { grip, x: e.clientX, y: e.clientY, start: rect };
    };
  }
  function move(e: ReactPointerEvent) {
    const d = drag.current;
    if (!d || !img.current) return;
    const box = img.current.getBoundingClientRect();
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    let { x, y, w, h } = d.start;
    if (d.grip === "move") {
      x = Math.min(Math.max(0, x + dx), box.width - w);
      y = Math.min(Math.max(0, y + dy), box.height - h);
    } else {
      if (d.grip.includes("w")) { const nx = Math.min(Math.max(0, x + dx), x + w - MIN); w += x - nx; x = nx; }
      if (d.grip.includes("e")) w = Math.min(Math.max(MIN, w + dx), box.width - x);
      if (d.grip.includes("n")) { const ny = Math.min(Math.max(0, y + dy), y + h - MIN); h += y - ny; y = ny; }
      if (d.grip.includes("s")) h = Math.min(Math.max(MIN, h + dy), box.height - y);
    }
    setRect({ x, y, w, h });
  }
  function up() { drag.current = null; }

  async function rotate() {
    const bmp = await createImageBitmap(source);
    const c = document.createElement("canvas");
    c.width = bmp.height;
    c.height = bmp.width;
    const ctx = c.getContext("2d")!;
    ctx.translate(c.width, 0);
    ctx.rotate(Math.PI / 2);
    ctx.drawImage(bmp, 0, 0);
    bmp.close();
    const b = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.92));
    if (b) setSource(b);
  }

  async function done() {
    const el = img.current;
    if (!el || !rect) return;
    const box = el.getBoundingClientRect();
    const k = el.naturalWidth / box.width;
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(rect.w * k));
    c.height = Math.max(1, Math.round(rect.h * k));
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(el, rect.x * k, rect.y * k, rect.w * k, rect.h * k, 0, 0, c.width, c.height);
    const webp = await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/webp", 0.85));
    const out = webp?.type === "image/webp" ? webp : await new Promise<Blob | null>((ok) => c.toBlob(ok, "image/jpeg", 0.88));
    if (out) onDone(out);
  }

  const whole = rect && img.current && Math.abs(rect.w - img.current.getBoundingClientRect().width) < 1 && Math.abs(rect.h - img.current.getBoundingClientRect().height) < 1 && rect.x === 0 && rect.y === 0;
  return (
    <div className="cropper" onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      <div className="cropper-stage">
        <div className="cropper-frame">
          {url && <img ref={img} src={url} alt="" onLoad={loaded} draggable={false} />}
          {rect && (
            <div className="crop-box" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} onPointerDown={down("move")}>
              {(["nw", "ne", "sw", "se", "n", "s", "e", "w"] as const).map((g) => (
                <span key={g} className={`crop-grip g-${g}`} onPointerDown={down(g)} />
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="cropper-bar">
        <span className="muted small">گوشه‌ها یا لبه‌های کادر را بکشید.</span>
        <div className="lightbox-tools">
          <button className="btn ghost" onClick={() => void rotate()} disabled={busy}>چرخاندن ⟳</button>
          <button className="btn ghost" onClick={onCancel} disabled={busy}>انصراف</button>
          <button className="btn" onClick={() => void done()} disabled={busy || !rect || !!whole}>{busy ? "در حال ذخیره…" : "ذخیرهٔ برش"}</button>
        </div>
      </div>
    </div>
  );
}
