import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { accentTokens, OFFICIAL_GREEN } from "./color";
import type { ThemeMode } from "../lib/api";

// The personal color and light/dark choice are kept per user in app_users (see AuthProvider);
// before anyone signs in the app shows the official green and the last mode used on this laptop.
const MODE_KEY = "pezhohesh.mode";

type ThemeCtx = {
  accent: string;
  isOfficial: boolean;
  setAccent: (hex: string) => void;
  reset: () => void;
  mode: ThemeMode;
  dark: boolean;
  setMode: (m: ThemeMode) => void;
};
const Ctx = createContext<ThemeCtx | null>(null);

function storedMode(): ThemeMode {
  try {
    const m = localStorage.getItem(MODE_KEY);
    return m === "light" || m === "dark" ? m : "system";
  } catch {
    return "system";
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState(OFFICIAL_GREEN);
  const [mode, setModeState] = useState<ThemeMode>(storedMode);
  const [systemDark, setSystemDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);
  const dark = mode === "dark" || (mode === "system" && systemDark);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (mode === "system") delete root.dataset.theme;
    else root.dataset.theme = mode;
    try { localStorage.setItem(MODE_KEY, mode); } catch { /* only a convenience */ }
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    for (const [k, v] of Object.entries(accentTokens(accent, dark))) root.style.setProperty(k, v);
  }, [accent, dark]);

  const value = useMemo<ThemeCtx>(
    () => ({
      accent,
      isOfficial: accent === OFFICIAL_GREEN,
      setAccent: setAccentState,
      reset: () => setAccentState(OFFICIAL_GREEN),
      mode,
      dark,
      setMode: setModeState,
    }),
    [accent, mode, dark],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
