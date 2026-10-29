import { invoke, isTauri } from "@tauri-apps/api/core";

// "Remember my password": kept by the desktop shell in Windows Credential Manager.
// In a plain browser (development) nothing is saved.
export type SavedLogin = { username: string; password: string };

export async function savedLogin(): Promise<SavedLogin | null> {
  if (!isTauri()) return null;
  try { return await invoke<SavedLogin | null>("saved_login"); } catch { return null; }
}

export async function saveLogin(username: string, password: string) {
  if (!isTauri()) return;
  try { await invoke("save_login", { username, password }); } catch (e) { console.error("save_login", e); }
}

export async function forgetLogin() {
  if (!isTauri()) return;
  try { await invoke("forget_login"); } catch { /* nothing saved */ }
}

/** After a password change, keep a saved copy for the same person up to date. */
export async function updateSavedPassword(username: string, password: string) {
  const s = await savedLogin();
  if (s && s.username === username) await saveLogin(username, password);
}

export const canSaveLogin = isTauri;

/** The Windows folder picker ("This PC"); null when cancelled or outside the desktop app. */
export async function pickFolder(start?: string): Promise<string | null> {
  if (!isTauri()) return null;
  try { return await invoke<string | null>("pick_folder", { start: start || null }); } catch (e) { console.error("pick_folder", e); return null; }
}

export const canPickFolder = () => isTauri();
