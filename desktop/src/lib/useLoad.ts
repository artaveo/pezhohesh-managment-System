import { useEffect, useState } from "react";

/** Loads data for a screen; `retry` runs it again after a failure. */
export function useLoad<T>(load: (signal: AbortSignal) => Promise<T>, deps: unknown[], fallback?: (e: unknown) => T | null) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setFailed(false);
    load(ctl.signal)
      .then((d) => setData(d))
      .catch((e) => {
        if (ctl.signal.aborted) return;
        const f = fallback?.(e);
        if (f) return setData(f);
        console.error(e);
        setFailed(true);
      });
    return () => ctl.abort();
  }, [...deps, attempt]);
  return { data, failed, retry: () => setAttempt((n) => n + 1) };
}
