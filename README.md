# Pezhohesh — سیستم مدیریت

Management system for Pezhohesh: the library and study hall, and the educational services department (PEC).
Offline-first desktop app; online backup and sync to Neon.

| Folder | What it is |
| --- | --- |
| `db/migrations` | PostgreSQL schema (26 tables, audit log, per-device bill numbers) |
| `api` | Core API in Rust (Axum + sqlx). Every client talks to it; runs migrations on start |
| `desktop` | Desktop app: Tauri 2 + React + TypeScript, Persian RTL |

## Run locally (Windows office laptop)

1. Install PostgreSQL 16, Rust, Node 22, and the Tauri prerequisites (WebView2 is already on Windows 10/11).
2. Create a database: `createdb pezhohesh`
3. API: `cd api` then `set DATABASE_URL=postgres://postgres:PASSWORD@localhost:5432/pezhohesh` and `cargo run`.
   Check http://127.0.0.1:8750/health
4. Desktop: `cd desktop`, `npm install`, then `npm run tauri dev` (or `npm run dev` for the browser preview).

## Design rules

- IDs are UUIDs created on the device, so three offline devices never clash.
- Nothing is hard-deleted; a wrong bill is voided. Every change goes to `audit_log` with user and device.
- Bill numbers carry the device prefix: `H-1405-000123`.
- Every amount has a currency column (AFN / USD). Dates are stored Gregorian and shown Solar Hijri.
- The official color is green `#76b82a`; each user can pick a personal accent from a full color wheel.
  Printed bills, receipts and cards always use the official colors.
