import { useEffect, useRef, useState } from "react";
import jsQR from "jsqr";
import { Modal } from "./Modal";

/**
 * Reads the QR code on the back of a membership card with the laptop's camera and hands
 * back what it says (the member's ID). A USB scanner needs none of this: it types the ID
 * into the search box like a keyboard.
 */
export function ScanCard({ onRead, onClose }: { onRead: (text: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const done = useRef(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    let frame = 0;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    function look() {
      if (!live) return;
      const v = video.current;
      if (v && v.videoWidth) {
        // A smaller copy reads just as well and keeps the laptop cool.
        const k = Math.min(1, 640 / v.videoWidth);
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
        if (code?.data.trim() && !done.current) {
          done.current = true;
          onRead(code.data.trim());
          return;
        }
      }
      frame = window.setTimeout(look, 150);
    }
    if (!navigator.mediaDevices) { setError("کمره در این کمپیوتر در دسترس نیست."); return; }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((s) => {
        if (!live) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (video.current) video.current.srcObject = s;
        look();
      })
      .catch(() => setError("کمره پیدا نشد یا اجازهٔ استفاده از آن داده نشد."));
    return () => { live = false; window.clearTimeout(frame); stream?.getTracks().forEach((t) => t.stop()); };
  }, [onRead]);

  return (
    <Modal label="اسکن کارت عضو" onClose={onClose} bare className="camera">
      <div className="camera-frame scan-frame">
        <video ref={video} autoPlay playsInline muted />
        <span className="scan-target" aria-hidden="true" />
      </div>
      {error ? <p className="form-error">{error}</p> : <p className="muted">پشت کارت را جلوی کمره بگیرید تا QR در چهارگوش سبز بیاید.</p>}
      <div className="actions"><button className="btn ghost" onClick={onClose}>بستن</button></div>
    </Modal>
  );
}
