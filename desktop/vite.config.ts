import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri serves the built files offline; the dev server port must match src-tauri/tauri.conf.json.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
});
