import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * A smaller JPEG of a picture, at most `side` pixels on its longer side, so a phone photo
 * of a few MB is stored as a few hundred KB. A PDF (a scanned tazkira) is kept as it is.
 */
export async function shrink(file: Blob, side: number, quality = 0.86): Promise<Blob> {
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
  return new Promise((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("encode"))), "image/jpeg", quality));
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
