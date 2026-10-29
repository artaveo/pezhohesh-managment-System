import { useEffect, useRef, useState } from "react";
import { Modal } from "./Modal";

/**
 * Takes a picture with the laptop's camera (or a USB webcam). For a member's photo the
 * frame is cut to the card's 3:4 portrait shape.
 */
export function CameraCapture({ portrait, onTaken, onClose }: { portrait: boolean; onTaken: (b: Blob) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let live = true;
    if (!navigator.mediaDevices) {
      setError("کمره در این کمپیوتر در دسترس نیست.");
      return;
    }
    navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
      .then((s) => {
        if (!live) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError("کمره پیدا نشد یا اجازهٔ استفاده از آن داده نشد."));
    return () => { live = false; stream?.getTracks().forEach((t) => t.stop()); };
  }, []);

  function take() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    let [w, h] = [v.videoWidth, v.videoHeight];
    let [x, y] = [0, 0];
    if (portrait) {
      // The widest 3:4 portrait frame in the middle of the picture.
      const cw = Math.min(w, (h * 3) / 4);
      x = (w - cw) / 2;
      w = cw;
      h = (cw * 4) / 3;
      y = (v.videoHeight - h) / 2;
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w);
    canvas.height = Math.round(h);
    canvas.getContext("2d")!.drawImage(v, x, y, w, h, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((b) => b && onTaken(b), "image/jpeg", 0.9);
  }

  return (
    <Modal label="کمره" onClose={onClose} bare className="camera">
      <div className={portrait ? "camera-frame portrait" : "camera-frame"}>
        <video ref={video} autoPlay playsInline muted onLoadedMetadata={() => setReady(true)} />
      </div>
      {error && <p className="form-error">{error}</p>}
      <div className="actions">
        <button className="btn big" disabled={!ready} onClick={take}>عکس بگیر</button>
        <button className="btn ghost" onClick={onClose}>بستن</button>
      </div>
    </Modal>
  );
}
