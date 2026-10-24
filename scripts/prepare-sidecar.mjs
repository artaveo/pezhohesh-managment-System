// Builds the core API and places it where Tauri bundles it into the installer:
//   desktop/src-tauri/binaries/pezhohesh-api-<target-triple>[.exe]
// Usage: node scripts/prepare-sidecar.mjs [--target <triple>]
// Without --target it builds for this computer (for `npm run tauri dev`).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const i = process.argv.indexOf("--target");
const target = i > 0 ? process.argv[i + 1] : hostTriple();
const ext = target.includes("windows") ? ".exe" : "";

const args = ["build", "--release", "--target", target];
console.log(`building API for ${target}…`);
execFileSync("cargo", args, { cwd: join(root, "api"), stdio: "inherit" });

const from = join(root, "api", "target", target, "release", `pezhohesh-api${ext}`);
const outDir = join(root, "desktop", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
copyFileSync(from, join(outDir, `pezhohesh-api-${target}${ext}`));
console.log(`sidecar ready: binaries/pezhohesh-api-${target}${ext}`);

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /^host: (\S+)/m.exec(out)[1];
}
