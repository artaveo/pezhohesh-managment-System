import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * A smaller picture, at most `side` pixels on its longer side: WebP, which is about a third
 * smaller than JPEG at the same look, or JPEG where WebP cannot be made. A phone photo of a
 * few MB is stored as some tens of KB. A PDF (a scanned tazkira) is kept as it is.
 */
export async function shrink(file: Blob, side: number, quality = 0.8): Promise<Blob> {
  if (file.type === "application/pdf") return file;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, side / Math.max(img.width, img.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close();
  const encode = (type: string, q: number) => new Promise<Blob | null>((ok) => canvas.toBlob(ok, type, q));
  const webp = await encode("image/webp", quality);
  if (webp?.type === "image/webp") return webp;
  const jpeg = await encode("image/jpeg", quality + 0.04);
  if (!jpeg) throw new Error("encode");
  return jpeg;
}

// A document id always means the same bytes, so the last few are kept and not fetched again.
const KEEP = 40;
const urls = new Map<string, Promise<string>>();

function fetchUrl(id: string) {
  let p = urls.get(id);
  if (p) {
    urls.delete(id); // most recently used goes last
  } else {
    p = api.documentFile(id).then((b) => URL.createObjectURL(b));
    p.catch(() => urls.delete(id));
  }
  urls.set(id, p);
  for (const [old, u] of urls) {
    if (urls.size <= KEEP) break;
    urls.delete(old);
    void u.then(URL.revokeObjectURL, () => {});
  }
  return p;
}

/**
 * An object URL for a stored photo or scan (the request needs the sign-in token), and
 * whether it could not be loaded.
 */
export function useDocumentUrl(id: string | null | undefined): { url: string | null; failed: boolean } {
  const [state, setState] = useState<{ url: string | null; failed: boolean }>({ url: null, failed: false });
  useEffect(() => {
    setState({ url: null, failed: false });
    if (!id) return;
    let live = true;
    fetchUrl(id).then((url) => live && setState({ url, failed: false }), () => live && setState({ url: null, failed: true }));
    return () => { live = false; };
  }, [id]);
  return state;
}

/**
 * On the hall computer while it shares the server: makes the small copy (about 20 KB) of
 * each member photo that goes to the server, so the partners' laptops see photos too.
 * Tazkira scans never go. Runs now and then in the background.
 */
export function usePhotoCopies(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let live = true;
    async function round() {
      try {
        if ((await api.sync()).mode !== "node") return;
        for (let ids = await api.thumbless(); live && ids.length; ids = await api.thumbless()) {
          for (const id of ids) {
            if (!live) return;
            await api.setThumb(id, await shrink(await api.documentFile(id), 320, 0.75));
          }
        }
      } catch {
        // Tried again at the next round.
      }
    }
    const first = window.setTimeout(() => void round(), 20_000);
    const every = window.setInterval(() => void round(), 10 * 60_000);
    return () => { live = false; window.clearTimeout(first); window.clearInterval(every); };
  }, [on]);
}
