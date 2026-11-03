# Pezhohesh management system — notes for Claude

Offline-first Windows desktop app for Pezhohesh (Afghanistan): the library and study hall
(«قرائت‌خانه»), and later the educational services department (PEC, «خدمات تحصیلی»).
Zakir Naseri is one of the two partners (the other is Mr. Rahimi). Development moved from
claude.ai Projects to this local checkout on 2026-11-03.

## Layout

| Path | What |
| --- | --- |
| `api/` | Core API, Rust (Axum 0.7 + sqlx 0.8, Postgres). Binds `127.0.0.1:8750`; phone upload page on `0.0.0.0:8760`. Runs migrations on start. One module per area (`hall.rs` members/periods/bills, `money.rs`, `k50.rs` fingerprint device, `sync.rs` hub sync, `backup.rs`/`restore.rs`, `import_excel.rs`, …). Routes are all in `main.rs::router`. |
| `api/k50-helper/K50Helper.cs` | 32-bit .NET Framework helper that talks to the ZKTeco K50 fingerprint device through ZKTeco's COM SDK. Built with the `csc.exe` every Windows has. |
| `db/migrations/` | sqlx migrations `NNNN_name.sql`, embedded into the API binary. |
| `desktop/` | Tauri 2 + React 18 + TypeScript + Vite, Persian RTL. No router library: `App.tsx` holds the menu (`NAV`) and a view/history state. API client and all types in `src/lib/api.ts`. Styles in one `src/styles.css` with tokens on `:root`. |
| `desktop/src-tauri/` | Native shell: starts the API sidecar (killed with the app via a job object), Postgres service helpers, firewall, Windows hotspot, saved login (keyring). |
| `scripts/` | `prepare-sidecar.mjs` (builds API + K50 helper into `desktop/src-tauri/binaries/`), `check-version.mjs`. |
| `docs/releases/vX.Y.Z.md` | Release notes in Persian (Dari), used as the GitHub Release body. |

## Rules the code relies on

- IDs are UUIDs made on the device. Nothing is hard-deleted (`deleted_at`, bills are voided).
- Every shared table has the three triggers, as in `0023_book_catalog.sql`:
  `touch_updated_at()`, `write_audit()` and `sync_capture('id')`, plus `GRANT`s to the DB
  roles `pz_partner` / `pz_manager` / `pz_pec`. A new table without `sync_capture` silently
  never reaches the other computers.
- Requests run in a transaction as the user's DB role (`auth::begin_as`), which sets
  `role` and `app.user_id`; the audit log reads them. Section permissions are checked again
  in `access.rs` (the menu hiding in `App.tsx` is only cosmetic). A new section must be added
  to `access.rs::SECTIONS` (and `HALL` if the manager may get it), `Section`/`SECTION_LABEL`/
  `SECTION_TREE` in `api.ts`, and `NAV` in `App.tsx`.
- Never edit an applied migration (checksums); add a new one. Files are LF (`.gitattributes`);
  `main.rs::repair_crlf_checksums` exists because of an old CRLF checkout.
- Amounts carry a currency (AFN / USD). Dates are stored Gregorian, shown Solar Hijri
  (`api/src/solar.rs`, `desktop/src/lib/solar.ts`).
- Bill numbers carry the device prefix (`H-1405-000123`); member numbers can carry a partner
  prefix (1 = Rahimi, 2 = Naseri).
- Brand green `#76b82a`. Each user can pick a personal accent; printed bills, receipts and
  cards always use the official colors. Font: Vazirmatn.

## Sync (see `api/src/sync.rs`, `0018_sync.sql`)

Neon is the hub. An office PC ("node") keeps a local Postgres; triggers write every change
to `sync_log`, the API pushes then pulls when online. A partner laptop ("online device")
has no own database and works on the hub directly, naming itself per connection via
`app.device_id`. Files in `%APPDATA%\Pezhohesh\`: `database-url.txt` (local DB),
`online-url.txt` (hub), `online-device.txt` / `online-device-paused.txt`. These hold
passwords: never print them. The K50 device is driven from the office PC only.

## Building on this laptop (Snapdragon ARM64, no MSVC)

Rust is `stable-aarch64-pc-windows-gnullvm` with LLVM-MinGW. Put LLVM-MinGW on PATH in
each shell first:

```powershell
$llvm = "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\MartinStorsjo.LLVM-MinGW.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe\llvm-mingw-20261020-ucrt-aarch64"
$env:PATH = "$llvm\bin;$llvm\aarch64-w64-mingw32\bin;$env:PATH"
```

- API tests: `cd api; cargo test` (unit tests only, no DB needed).
- Frontend check: `cd desktop; npx tsc -b`. Browser preview: `npm run dev` (port 5173, needs the API on 8750).
- Full app: `cd desktop; npm run tauri dev` (the `pretauri` script builds the sidecars first).
- Local Postgres 16 runs as service `postgresql-x64-16` on 5432; `psql` is in
  `C:\Program Files\PostgreSQL\16\bin` (not on PATH). Pass the URL with `-d` after options.
- Official installers (x64 + arm64) are built by GitHub Actions (`.github/workflows/windows-build.yml`)
  on every push to `main`; a `v*` tag publishes a Release.

## Releasing

1. Same version in `desktop/package.json`, `desktop/src-tauri/tauri.conf.json`,
   `desktop/src-tauri/Cargo.toml`, `api/Cargo.toml` (`node scripts/check-version.mjs` checks).
2. Write `docs/releases/vX.Y.Z.md` in plain Dari for the partners (what changed for them,
   not how), with the x64/arm64 download table.
3. Commit `vX.Y.Z: <summary>`, tag `vX.Y.Z`, push. Only when Zakir asks.

## Style

- Comments in short, plain English that say why; the UI and release notes in Dari
  (Afghan terms: «بل» for bill, «تذکره», «کمره», AFN).
- Commit subjects describe the change in user terms (see `git log`).
- Not built yet: the PEC section (`pec_*` tables exist, menu item marked «به‌زودی»; waits for a
  talk with the partners), installer signing (SignPath).
