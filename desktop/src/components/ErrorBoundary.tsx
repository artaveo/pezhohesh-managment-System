import { Component, type ErrorInfo, type ReactNode } from "react";
import { api } from "../lib/api";
import { openLogs } from "../lib/savedLogin";

const place = () => location.hash || "app";

/** Errors the screen did not catch go to api.log too, so one file tells the whole story. */
export function watchErrors() {
  window.addEventListener("error", (e) => {
    void api.clientLog({ level: "error", place: place(), message: e.message || "error", stack: e.error instanceof Error ? e.error.stack : `${e.filename}:${e.lineno}` });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const r = e.reason;
    // A request the API refused is already in its log, with its request id.
    if (r && typeof r === "object" && "status" in r && "code" in r) return;
    void api.clientLog({ level: "error", place: place(), message: r instanceof Error ? r.message : String(r), stack: r instanceof Error ? r.stack : undefined });
  });
}

/** A screen that broke: logged, and a way back instead of a white window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    void api.clientLog({ level: "error", place: place(), message: error.message, stack: `${error.stack ?? ""}\n${info.componentStack ?? ""}` });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="page" style={{ padding: 32, maxWidth: 640, margin: "0 auto" }}>
        <div className="panel wide">
          <h1>این صفحه باز نشد</h1>
          <p className="muted">مشکل در گزارش برنامه (api.log) نوشته شد. برنامه را دوباره باز کنید؛ اگر باز هم شد، فایل گزارش را بفرستید.</p>
          <div className="actions">
            <button className="btn" onClick={() => location.reload()}>دوباره باز کن</button>
            <button className="btn ghost" onClick={() => void openLogs()}>پوشهٔ گزارش‌ها</button>
          </div>
        </div>
      </div>
    );
  }
}
