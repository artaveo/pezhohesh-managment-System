import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, hasToken, onSessionExpired, setToken, type User } from "../lib/api";
import { useTheme } from "../theme/ThemeProvider";
import { OFFICIAL_GREEN } from "../theme/color";

type Status = "loading" | "offline" | "setup" | "signed_out" | "signed_in";

type AuthCtx = {
  status: Status;
  user: User | null;
  signIn: (token: string, user: User) => void;
  signOut: () => Promise<void>;
  updateUser: (patch: Partial<User>) => void;
  retry: () => void;
};
const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>("loading");
  const [user, setUser] = useState<User | null>(null);
  const { setAccent } = useTheme();

  const applyUser = useCallback((u: User | null) => {
    setUser(u);
    // The personal color follows the person, on whichever laptop they sign in.
    setAccent(u?.theme_color ?? OFFICIAL_GREEN);
  }, [setAccent]);

  const check = useCallback(async () => {
    setStatus("loading");
    try {
      if (hasToken()) {
        try {
          applyUser(await api.me());
          setStatus("signed_in");
          return;
        } catch {
          setToken(null);
        }
      }
      const { needs_setup } = await api.setupStatus();
      setStatus(needs_setup ? "setup" : "signed_out");
    } catch {
      setStatus("offline");
    }
  }, [applyUser]);

  useEffect(() => {
    onSessionExpired(() => {
      setToken(null);
      applyUser(null);
      setStatus("signed_out");
    });
    void check();
  }, [check, applyUser]);

  const value: AuthCtx = {
    status,
    user,
    signIn: (token, u) => {
      setToken(token);
      applyUser(u);
      setStatus("signed_in");
    },
    signOut: async () => {
      await api.logout().catch(() => {});
      setToken(null);
      applyUser(null);
      setStatus("signed_out");
    },
    updateUser: (patch) => setUser((u) => (u ? { ...u, ...patch } : u)),
    retry: () => void check(),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
