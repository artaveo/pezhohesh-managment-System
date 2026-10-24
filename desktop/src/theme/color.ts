// Color math for the per-user accent. Everything else in the UI derives from one hex value.

export const OFFICIAL_GREEN = "#76b82a";

export type Hsv = { h: number; s: number; v: number }; // h 0..360, s and v 0..1

export function hsvToHex({ h, s, v }: Hsv): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return "#" + [f(5), f(3), f(1)].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function hexToHsv(hex: string): Hsv | null {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const [r, g, b] = rgb.map((c) => c / 255);
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
  }
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Black or white, whichever reads better on the given color (WCAG contrast). */
export function textOn(hex: string): string {
  const rgb = hexToRgb(hex) ?? [0, 0, 0];
  const l = luminance(rgb);
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? "#111611" : "#ffffff";
}

function mix(hex: string, with_: string, amount: number): string {
  const a = hexToRgb(hex) ?? [0, 0, 0];
  const b = hexToRgb(with_) ?? [0, 0, 0];
  return "#" + a.map((c, i) => Math.round(c + (b[i] - c) * amount).toString(16).padStart(2, "0")).join("");
}

/** CSS variables for one accent, in light or dark mode. */
export function accentTokens(hex: string, dark: boolean): Record<string, string> {
  return {
    "--accent": hex,
    "--accent-ink": textOn(hex),
    "--accent-strong": dark ? mix(hex, "#ffffff", 0.25) : mix(hex, "#000000", 0.3),
    "--accent-soft": dark ? mix(hex, "#141a13", 0.78) : mix(hex, "#ffffff", 0.86),
  };
}
