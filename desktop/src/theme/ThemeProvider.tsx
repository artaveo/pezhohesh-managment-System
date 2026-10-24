import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { accentTokens, OFFICIAL_GREEN } from "./color";

// The personal color is kept per user in app_users.theme_color (see AuthProvider);
// before anyone signs in the app shows the official green.

type ThemeCtx = { accent: string; isOfficial: boolean; setAccent: (hex: string) => void; reset: () => void };
const Ctx = createContext<ThemeCtx | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [accent, setAccentState] = useState(OFFICIAL_GREEN);
  const [dark, setDark] = useState(() => matchMedia("(prefers-color-scheme: dark)").matches);

  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const on = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

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
    }),
    [accent],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme must be used inside ThemeProvider");
  return ctx;
}
