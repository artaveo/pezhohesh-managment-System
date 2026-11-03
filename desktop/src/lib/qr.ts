import { useEffect, useState } from "react";
import { api } from "./api";

/** A picture of `text` as a QR code (made by the app's server), or null while it is made. */
export function useQr(text: string | null, wait = 300) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!text) return;
    let live = true;
    let made: string | null = null;
    const t = window.setTimeout(() => {
      api.qr(text).then((b) => { if (live) { made = URL.createObjectURL(b); setUrl(made); } }, () => {});
    }, wait);
    return () => { live = false; window.clearTimeout(t); if (made) URL.revokeObjectURL(made); };
  }, [text, wait]);
  return url;
}
