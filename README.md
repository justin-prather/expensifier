# Expensifier

Expensifier is a self-hosted expense intake and review system for Unraid. Phase 4, durable receipt OCR as defined in `PROJECT_SPEC.md`, is complete.

## Current Foundation

- Bun-hosted SvelteKit application.
- Tailwind CSS interface.
- Oxlint and Oxfmt code-quality tooling.
- Effect v4 RC services, Layers, and `ManagedRuntime`.
- Effect SQL with Bun SQLite migrations.
- Replaceable `OcrService` with production Taggun and test-fixture Layers.
- Durable OCR jobs and immutable provider-run history that persist across restarts.
- Better Auth email/password authentication.
- One-time first-admin setup with public registration blocked afterward.
- Bun-native production build and Docker Compose deployment.
- Validated managed paths constrained beneath one data root.
- Automatic creation and permission checks for the application, backup, inbox, processing, processed, and rejected directories.
- Privacy-safe JSON operational logs containing IDs and statuses, not document or financial data.
- Separate liveness and readiness endpoints with database, runtime, and storage checks.
- Signal-driven Effect runtime disposal for clean container shutdown.
- Better Auth admin and accountant roles backed by server-side permission checks.
- Admin-created, SHA-256-hashed invitation tokens that expire after 72 hours and work once.
- User, role, and invitation administration at `/settings/users`.
- Invitation acceptance with account creation and immediate authenticated access.
- Recursive PDF, JPEG, and PNG inbox discovery using filesystem events plus periodic reconciliation.
- Stable-file checks, signature validation, SHA-256 hashing, and content-based duplicate relationships.
- Database-first intake staging followed by recoverable atomic moves into the processing directory.
- Durable job claims with bounded backoff, sanitized failures, and interrupted-work recovery.
- Authenticated intake queue showing move, duplicate, failure, and awaiting-OCR states.
- Automatic Taggun OCR after intake with multipart PDF, JPEG, and PNG uploads.
- Provider-neutral normalized fields with confidence and source-path provenance.
- Raw provider-response retention, classified failures, bounded retries, and manual retry.
- Authenticated OCR queue showing active, retrying, successful, and recoverable failure states.

`Legacy/` remains ignored reference material and is not part of the application build.

## Local Development

Requirements:

- Bun 1.3.14 or newer.

Create local configuration:

```sh
cp .env.example .env
```

Replace `BETTER_AUTH_SECRET` with at least 32 random characters and set `TAGGUN_API_KEY`, then install and start:

```sh
bun install
bun run dev
```

Open `http://localhost:5173`. The first visit redirects to `/setup`; after the first account is created, public registration is unavailable.

Admins manage users and create invitation links at `/settings/users`. Invitation links are displayed once for manual sharing; no SMTP configuration is required. Accountants can review expenses and retry OCR but cannot access user or system settings.

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

## Watched-Folder Intake

Place supported PDF, JPG, JPEG, or PNG files beneath `data/inbox/`. A file must retain the same size and modification time for the configured stability interval before intake. The application then:

1. Validates the extension and file signature.
2. Calculates a SHA-256 content hash.
3. Creates the document and durable job records transactionally.
4. Flags an existing matching hash without deleting either document.
5. Atomically moves the file to a document-ID-based path beneath `data/processing/`.

Filesystem events reduce latency, while periodic scans remain the source of truth. Interrupted running jobs return to the pending queue at startup. See `.env.example` for stability, scan, polling, and retry settings.

## Receipt OCR

Successful intake automatically creates a durable Taggun OCR job. The integration uses Taggun's verbose file endpoint with line-item extraction enabled and `incognito=true`. Each provider attempt creates an immutable OCR-run record containing either the raw response plus normalized result or sanitized failure metadata. Normalized merchant, date, total, tax, currency, and line-item values retain confidence and provider source paths; missing fields remain null for later manual review.

Timeouts, rate limits, and provider outages use the bounded durable-job retry policy. Authentication, configuration, invalid-response, and rejected-document failures remain visible without automatic retry. Authorized users can request another OCR run from the queue; earlier runs and results are never overwritten. If `TAGGUN_API_KEY` is absent, intake still operates and OCR items show a configuration failure until credentials are added and the application is restarted.

Contract tests use sanitized Taggun response fixtures and do not consume live provider scans.

Billable expenses are held in `processed/billable` when approved, regardless of the configured
destination template, so they can be processed before month/year filing. The destination template
continues to control non-billable receipts.

## AI Classification

After successful OCR, a durable classification job first checks active deterministic vendor rules.
Only unmatched expenses invoke DeepSeek V4 Flash through OpenCode Zen's OpenAI-compatible Chat
Completions endpoint. The provider receives a new allow-listed object containing normalized OCR
values/confidence and active payment-account, category, and client candidates; it never receives the
document, filename, path, raw OCR response, or OCR source paths. JSON output is validated locally
against the required shape and supplied candidate IDs before a suggestion is stored.

Set `CLASSIFICATION_API_KEY` to an OpenCode Zen API key to enable the production Layer. Missing credentials or provider failures
do not change local expense status or block manual review. Admins can inspect non-secret provider
status at `/settings/integrations`; suggestions and explicit accepted, rejected, or replaced outcomes
are retained in SQLite and audit history. See `docs/ai-provider-decision.md` for the candidate
comparison, fixture method, selected model, and privacy boundary.

## Effect Version

Effect is pinned to `4.0.0-rc.111`, including `@effect/sql-sqlite-bun` and `@effect/vitest`. Do not mix Effect v3 packages or patterns into the application.
