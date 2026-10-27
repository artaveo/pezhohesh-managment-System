import { invoke, isTauri } from "@tauri-apps/api/core";
import { API_BASE } from "./api";

// What the offline screen needs to say exactly what is wrong: the API's own health report,
// and from the desktop shell the PostgreSQL service and the API's log.

/** Why the database is not ready (see Core in api/src/main.rs). */
export type Problem = "starting" | "postgres_down" | "db_login" | "migration" | "db_error" | "restoring";
export type Health = { database: boolean; problem: Problem | null; detail: string | null; version: string };
export type PgService = { name: string; running: boolean; pending: boolean; auto_start: boolean };

/** null: the API itself is not answering. */
export async function health(): Promise<Health | null> {
  try {
    const res = await fetch(`${API_BASE}/health`, { signal: AbortSignal.timeout(4000) });
    return (await res.json()) as Health;
  } catch {
    return null;
  }
}

export async function postgresService(): Promise<PgService | null> {
  if (!isTauri()) return null;
  try { return await invoke<PgService | null>("postgres_service"); } catch { return null; }
}

/** Starts PostgreSQL as administrator (Windows asks first). Throws "cancelled", "start_failed"… */
export const fixPostgres = () => invoke<void>("fix_postgres");

export async function restartApi() {
  if (isTauri()) await invoke<boolean>("restart_api").catch(() => false);
}

export async function apiLog(): Promise<string> {
  if (!isTauri()) return "";
  try { return await invoke<string>("api_log"); } catch { return ""; }
}

export const canFixPostgres = isTauri;

/** Whether Windows Firewall lets phones reach the phone page; null outside the desktop app. */
export async function firewallOpen(): Promise<boolean | null> {
  if (!isTauri()) return null;
  try { return await invoke<boolean | null>("firewall_open"); } catch { return null; }
}

/** Opens the phone page's port in Windows Firewall as administrator (Windows asks first). */
export const openFirewall = () => invoke<void>("open_firewall");
