import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { hexToHsv, hsvToHex, type Hsv } from "../theme/color";

/**
 * Full-spectrum color wheel: angle = hue, distance from center = saturation,
 * plus a brightness slider underneath. Works with mouse, touch and keyboard.
 */
export function ColorWheel({ value, onChange, size = 220 }: { value: string; onChange: (hex: string) => void; size?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? { h: 90, s: 0.8, v: 0.7 });

  // follow outside changes (reset button, hex input)
  useEffect(() => {
    const next = hexToHsv(value);
    if (next && hsvToHex(next) !== hsvToHex(hsv)) setHsv(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const ctx = c.getContext("2d")!;
    const img = ctx.createImageData(c.width, c.height);
    const r = c.width / 2;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const dx = x - r, dy = y - r;
        const d = Math.hypot(dx, dy);
        const i = (y * c.width + x) * 4;
        if (d > r) { img.data[i + 3] = 0; continue; }
        const h = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360;
        const hex = hsvToHex({ h, s: d / r, v: hsv.v });
        const n = parseInt(hex.slice(1), 16);
        img.data[i] = (n >> 16) & 255;
        img.data[i + 1] = (n >> 8) & 255;
        img.data[i + 2] = n & 255;
        img.data[i + 3] = d > r - 1 ? Math.round((r - d) * 255) : 255; // soft edge
      }
    }
    ctx.putImageData(img, 0, 0);
  }, [size, hsv.v]);

  const commit = useCallback((next: Hsv) => { setHsv(next); onChange(hsvToHex(next)); }, [onChange]);

  const pick = (e: PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const r = rect.width / 2;
    const dx = e.clientX - rect.left - r, dy = e.clientY - rect.top - r;
    commit({ ...hsv, h: ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360, s: Math.min(1, Math.hypot(dx, dy) / r) });
  };

  const rad = (hsv.h * Math.PI) / 180;
  const knob = { left: size / 2 + Math.cos(rad) * hsv.s * (size / 2), top: size / 2 + Math.sin(rad) * hsv.s * (size / 2) };

  return (
    <div className="wheel">
      <div className="wheel-disc" style={{ width: size, height: size }}>
        <canvas
          ref={canvas}
          style={{ width: size, height: size }}
          role="slider"
          tabIndex={0}
          aria-label="رنگ"
          aria-valuetext={hsvToHex(hsv)}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); pick(e); }}
          onPointerMove={(e) => { if (e.buttons) pick(e); }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 15 : 3;
            if (e.key === "ArrowLeft") commit({ ...hsv, h: (hsv.h + 360 - step) % 360 });
            else if (e.key === "ArrowRight") commit({ ...hsv, h: (hsv.h + step) % 360 });
            else if (e.key === "ArrowUp") commit({ ...hsv, s: Math.min(1, hsv.s + 0.05) });
            else if (e.key === "ArrowDown") commit({ ...hsv, s: Math.max(0, hsv.s - 0.05) });
            else return;
            e.preventDefault();
          }}
        />
        <span className="wheel-knob" style={{ ...knob, background: hsvToHex(hsv) }} />
      </div>
      <label className="wheel-bright">
        <span>روشنی</span>
        <input
          id="accent-brightness"
          type="range"
          min={15}
          max={100}
          value={Math.round(hsv.v * 100)}
          onChange={(e) => commit({ ...hsv, v: Number(e.target.value) / 100 })}
          style={{ background: `linear-gradient(to left, ${hsvToHex({ ...hsv, v: 1 })}, #000)` }}
        />
      </label>
    </div>
  );
}
