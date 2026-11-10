import { useEffect, useState } from "react";
import { api, ApiError, type FilesStore } from "./api";

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
    p = load(id).then((b) => URL.createObjectURL(b));
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

/** From this computer, else from the file server (and then kept here too). */
async function load(id: string): Promise<Blob> {
  try {
    return await api.documentFile(id);
  } catch (e) {
    const name = e instanceof ApiError && e.code === "file_missing" ? (e.body.name as string | undefined) : undefined;
    if (!name) throw e;
    const b = await fromStore(name);
    void api.keepFileCopy(id, b).catch(() => {});
    return b;
  }
}

let storeP: Promise<FilesStore | null> | null = null;
function store() {
  storeP ??= api.filesStore().catch(() => { storeP = null; return null; });
  return storeP;
}

async function fromStore(name: string): Promise<Blob> {
  const s = await store();
  if (!s) throw new ApiError(404, "file_missing");
  const res = await fetch(`${s.url}/${name}`, { headers: { "x-pz-key": s.key } });
  if (!res.ok) throw new ApiError(404, "file_missing");
  return res.blob();
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
 * Photos and scans go to the file server, not to the main server: each computer sends the
 * files it has that are not there yet, now and then in the background. Any other computer
 * then fetches a file from there when it is opened.
 */
export function useFileSending(on: boolean) {
  useEffect(() => {
    if (!on) return;
    let live = true;
    async function round() {
      try {
        const s = await store();
        if (!s) return;
        for (let rows = await api.unsentFiles(); live && rows.length; rows = await api.unsentFiles()) {
          for (const r of rows) {
            if (!live) return;
            const b = await api.documentFile(r.id);
            const res = await fetch(`${s.url}/${r.name}`, { method: "PUT", headers: { "x-pz-key": s.key, "content-type": b.type || "application/octet-stream" }, body: b });
            // 409: it is there already (the same bytes, by name).
            if (!res.ok && res.status !== 409) throw new Error(`files ${res.status}`);
            await api.fileSent(r.id);
          }
        }
      } catch (e) {
        void api.clientLog({ level: "warn", place: "file-sending", message: String(e) });
      }
    }
    const first = window.setTimeout(() => void round(), 20_000);
    const every = window.setInterval(() => void round(), 10 * 60_000);
    return () => { live = false; window.clearTimeout(first); window.clearInterval(every); };
  }, [on]);
}

/** After the file server is set, the next fetch reads the new address. */
export function forgetFilesStore() { storeP = null; }
