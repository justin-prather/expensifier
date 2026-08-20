# Expensifier

Expensifier is a self-hosted expense intake and review system for Unraid. Phase 1, the application foundation defined in `PROJECT_SPEC.md`, is complete.

## Current Foundation

- Bun-hosted SvelteKit application.
- Tailwind CSS interface.
- Oxlint and Oxfmt code-quality tooling.
- Effect v4 RC services, Layers, and `ManagedRuntime`.
- Effect SQL with Bun SQLite migrations.
- Replaceable `OcrService` with a fake implementation.
- Durable fake OCR jobs that persist across restarts.
- Better Auth email/password authentication.
- One-time first-admin setup with public registration blocked afterward.
- Bun-native production build and Docker Compose deployment.
- Validated managed paths constrained beneath one data root.
- Automatic creation and permission checks for the application, backup, inbox, processing, processed, and rejected directories.
- Privacy-safe JSON operational logs containing IDs and statuses, not document or financial data.
- Separate liveness and readiness endpoints with database, runtime, and storage checks.
- Signal-driven Effect runtime disposal for clean container shutdown.

`Legacy/` remains ignored reference material and is not part of the application build.

## Local Development

Requirements:

- Bun 1.3.14 or newer.

Create local configuration:

```sh
cp .env.example .env
```

Replace `BETTER_AUTH_SECRET` with at least 32 random characters, then install and start:

```sh
bun install
bun run dev
```

Open `http://localhost:5173`. The first visit redirects to `/setup`; after the first account is created, public registration is unavailable.

Local SQLite files are created under `./data/app/` and are ignored by Git.

## Verification

```sh
bun run check
bun run lint
bun run test
bun run build
```

Vitest is forced to run through Bun because the application uses the native `bun:sqlite` module.

## Docker Compose

Create `.env` from `.env.example`, set the externally reachable `BETTER_AUTH_URL` and `ORIGIN`, then run:

```sh
docker compose up --build
```

The Compose configuration mounts `./data` at `/data`. For Unraid, this will become a bind mount to the selected app-data and document share.

The service exposes:

- Application: `http://localhost:3000`
- Liveness: `http://localhost:3000/api/health/live`
- Readiness: `http://localhost:3000/api/health/ready`

`/api/health` remains a readiness alias. The image health check uses `/api/health/ready`.

## Data Files

```text
data/
  app/
    auth.sqlite
    expensifier.sqlite
  backups/
  inbox/
  processing/
  processed/
  rejected/
```

Better Auth and the expense domain intentionally use separate SQLite databases. Authentication remains at the web boundary; domain records use stable Better Auth user IDs when user ownership is introduced.

Managed folder overrides are relative to `APP_DATA_ROOT`; startup rejects absolute paths and traversal outside that root. See `.env.example` for the supported variables.

## Effect Version

Effect is pinned to `4.0.0-rc.111`, including `@effect/sql-sqlite-bun` and `@effect/vitest`. Do not mix Effect v3 packages or patterns into the application.
