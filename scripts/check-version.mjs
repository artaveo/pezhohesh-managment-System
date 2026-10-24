// Fails unless the app version is the same everywhere (and matches the git tag, if given).
// Usage: node scripts/check-version.mjs [v1.2.3]
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
const cargo = (p) => /^version\s*=\s*"([^"]+)"/m.exec(read(p))[1];

const versions = {
  "desktop/package.json": JSON.parse(read("desktop/package.json")).version,
  "desktop/src-tauri/tauri.conf.json": JSON.parse(read("desktop/src-tauri/tauri.conf.json")).version,
  "desktop/src-tauri/Cargo.toml": cargo("desktop/src-tauri/Cargo.toml"),
  "api/Cargo.toml": cargo("api/Cargo.toml"),
};
const tag = process.argv[2];
if (tag) versions[`git tag ${tag}`] = tag.replace(/^v/, "");

const distinct = new Set(Object.values(versions));
for (const [file, v] of Object.entries(versions)) console.log(`${v.padEnd(10)} ${file}`);
if (distinct.size !== 1) {
  console.error("Version mismatch: set the same version in every file above.");
  process.exit(1);
}
console.log(`OK: ${[...distinct][0]}`);
