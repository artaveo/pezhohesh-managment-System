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
  in `access.rs` (the menu hiding in `App.tsx` is only cosmetic). Menu items with a `hub`
  («اعضا», «دستگاه انگشت») are one menu entry with tabs. A new section must be added
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

## Money facts that explain odd-looking numbers

- Excel member fees have no payment day. `date_excel_fees` dates each cell inside its own Solar
  month from the member's period starts (the device's dates): exact when a period starts in that
  month, else 30-day steps from the nearest one (the device keeps only the last dates), else the
  1st. It runs on every import and after «تاریخ از دستگاه». Monthly totals never change.
- The book's two loan sheets are added by `store_loans`, not replaced: rows the app has stay, and
  their fees are not income (the statement's «امانت دهی کتاب» line counts them).
- The dashboard's month view compares the same first N days; the finance report's other months are whole.
- A bill counts on the day it was paid (`paid_on`, default today), not the period's start; only
  the later months of a multi-month payment count on their own start day.
- The import skips a member's month cell when the app has a bill for that member, line and month.
  An expense or withdrawal typed in the app skips the book's line of the same kind, day and
  amount; a day with meals typed in the app skips that day's book meals (split or whole). A book
  expense cell equal to the sum of some of that day's other app lines (any line, e.g. «مصارف
  جانبی 720» typed as 100 + 500 + 120) is skipped too (`subset_sum`, at most 16 lines a day).
  Other income: a dated cell skips an app bill of the same line, day and amount; a statement
  month figure (books, «طلبات») loses the app's bills of that line in that month. Hotspot: the
  sheet's day count loses the cards the app counted that day (per card size, profit with them);
  a supplier bill is skipped when the app has the same bill number (or same day and cards).
- The book's meals cell («20صبحانه+چاشت60+شام80») is split into the expense lines «صبحانه»,
  «چاشت», «شام»/«شب» (`meals()`), only when all three lines exist and the parts add up to the cell.
- A re-import writes only what changed: one batch per year is reused, and money rows are compared
  by their content (`xl_rx` etc. in `import_excel.rs`); bulk work sets `pezhohesh.bulk` so
  `write_audit` skips it and writes one summary line. The audit log keeps only changed fields.
- «یادداشت‌ها» (`notes`, `notes.rs`) are side reckonings: no report, total or import reads them.
- The dashboard's month card «موجودی ماه» is that month alone (net − partners' withdrawals); the
  whole till (`inTill`) is on «امسال».
- «موجودی از ماه قبل» is never typed: `reports.rs` works out the till at a range's start from
  `TILL_START` (1 Hamal 1405, empty): income − expenses + estimates − partners' withdrawals.
  It is added only to «موجودی» (`inTill`). The old manual category `carryover` stays excluded from
  income. Book guarantees are shown apart, never as income.
- A debt («باقی», `debts.rs`) paid late gets a bill dated today (`billed_on`), but its money counts
  on the day it was owed (`issued_on`). Overdue home loans are debts too, settled by returning the book.

## Files (photos and scans)

Not on the hub. Each computer keeps its files under `%APPDATA%\Pezhohesh\files` and the window
sends them to the file server (Supabase project `pezhohesh-files`, edge function `files`, private
bucket `documents`, header `x-pz-key`; setting `files_store`, set by a partner on the backup
page). Another computer fetches a missing file from there (`file_missing` 404 carries its name)
and keeps a copy (`/documents/:id/copy`).

## Sync (see `api/src/sync.rs`, `0018_sync.sql`)

Neon is the hub. An office PC ("node") keeps a local Postgres; triggers write every change
to `sync_log`, the API pushes then pulls when online. Once a day a node tidies the hub:
`sync_prune(3)` drops older states of a row (the newest stays), and `shrink` rewrites
`sync_log`/`audit_log` with VACUUM FULL when they are mostly empty space. An online device's
backup leaves out the rows of those two tables (a restore never uses them). A partner laptop ("online device")
has no own database and works on the hub directly, naming itself per connection via
`app.device_id`. Files in `%APPDATA%\Pezhohesh\`: `database-url.txt` (local DB),
`online-url.txt` (hub), `online-device.txt` / `online-device-paused.txt`. These hold
passwords: never print them. The K50 device is driven from the office PC only.

## The fingerprint device (ZKTeco K50, `api/src/k50.rs` + `K50Helper.cs`)

The K50 stops answering the network (until power-cycled) when talks are cut off half way or
it is kept busy. Keep these when changing device code:
- Every helper request carries a `budget`; the helper stops new work and long reads when it
  is spent and always unlocks and disconnects. The app kills a helper only after `GRACE`.
- Writes lock the device with `DisableDeviceWithTimeOut` (falls back to `EnableDevice`).
- One helper at a time per computer (system mutex `PezhoheshK50Device`), one talk per API
  (`DEVICE` lock). Before the API stops, `k50::quiesce` waits for a talk under way; the
  desktop calls `POST /api/v1/k50/quiesce` before closing the API.
- Punches: the device keeps every punch (capacity ~80,000). Read only when the count changed
  (`k50_logs_count`), from `k50_logs_since` with `ReadTimeGLogData` where it works.
- A device that does not answer is retried with backoff (2 min up to 30 min); `diagnose`
  tells other network / no answer / IP taken by another device / device busy.
- ZKAccess open on the same PC is detected (`zk_program_open`); punches are then read every
  30 min and the device page warns.
- The office laptop needs its Wi-Fi and the Windows hotspot (phone uploads): never talk to the
  device while the network changes. The desktop calls `POST /api/v1/k50/hold` before turning
  the hotspot on or off, and rounds wait `SETTLE_SECS` after any change of this PC's addresses.
- The K50 gives dates back without leading zeros ("2026-11-3 0:0:0"): parse dates by their
  parts (`device_day`, the helper's `Day`), never by "the first eight digits".
- Device talks, failures with an ARP/ping check of the device and its neighbours, and changes
  of this PC's network are all in `api.log`: read it before guessing at a device problem.
- The office Wi-Fi «Pezhohesh_Library» itself vanishes for about 1.5 minutes many times a day
  (proven 2026-11-04: two laptops lost it in the same second, Windows saying "no connectable
  Access Point was visible"); Windows then joined another saved Wi-Fi ("Amir Artin") and stayed
  there, so the device was out of reach (`other_network`). Every network change logs Windows'
  Wi-Fi state and last WLAN events (`wifi_story`); after a good round the Wi-Fi the device is
  reached through is kept (`k50_wifi`) and `rejoin_wifi` sends the laptop back to it.
- ZKAccess still renews some members. With `keep_zk` (on by default) the helper's `set_user`
  reads the device's days first: a user it lets in today or later on days the app never wrote
  (`pushed_end`), ending more than `ZK_MARGIN_DAYS` (3) from the app's end (ZKAccess's typed
  end is often a day or two off; within that the app's day counts), is not closed or cut; the app's days are joined to them (`kept_open`, shown on
  the member page). «تاریخ از دستگاه» (also offered after an Excel import) extends app periods
  to the device's later end while it still runs.
- `clear_monthly` (off by default) takes the punches off the device once a Solar month, only
  after a whole read; the app keeps them in `attendance`.

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
