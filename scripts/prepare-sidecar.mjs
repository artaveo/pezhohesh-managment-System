// Builds the core API and the fingerprint-device helper and places them where Tauri bundles
// them into the installer:
//   desktop/src-tauri/binaries/pezhohesh-api-<target-triple>[.exe]
//   desktop/src-tauri/binaries/pezhohesh-k50-<target-triple>[.exe]
// Usage: node scripts/prepare-sidecar.mjs [--target <triple>]
// Without --target it builds for this computer (for `npm run tauri dev`).
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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

// The helper is 32-bit .NET Framework (ZKTeco's SDK is a 32-bit COM library), built with the
// C# compiler every Windows has; the same file serves x64 and ARM64 laptops.
const helper = join(outDir, `pezhohesh-k50-${target}${ext}`);
const source = join(root, "api", "k50-helper", "K50Helper.cs");
if (process.platform === "win32") {
  const windir = process.env.WINDIR || "C:\\Windows";
  const csc = join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe");
  if (!existsSync(csc)) throw new Error(`C# compiler not found: ${csc}`);
  console.log("building fingerprint helper…");
  execFileSync(csc, ["/nologo", "/optimize+", "/platform:x86", "/target:exe", `/out:${helper}`,
    "/r:Microsoft.CSharp.dll", "/r:System.Core.dll", "/r:System.Web.Extensions.dll", source], { stdio: "inherit" });
} else {
  // The device is only reached from Windows; elsewhere the bundle just needs the file to exist.
  writeFileSync(helper, "");
}
console.log(`helper ready: binaries/pezhohesh-k50-${target}${ext}`);

function hostTriple() {
  const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  return /^host: (\S+)/m.exec(out)[1];
}
