# Expensifier Project Specification

Status: Approved for implementation planning  
Date: 2026-08-20

## 1. Purpose

Expensifier is a self-hosted expense intake and review application packaged as a Docker image for an Unraid server. It watches an Unraid folder for receipts and invoices, extracts structured data, suggests classifications, requires human review, and moves approved documents into a configurable processed file tree.

The implementation is a clean rebuild. `Legacy/` is behavioral reference material only and must not constrain the new architecture or be modified as part of this project.

## 2. Goals

- Run as one application container on Unraid.
- Detect and ingest PDF, JPEG, and PNG documents automatically.
- Keep document processing reliable across restarts and filesystem event loss.
- Place provider-specific OCR behavior behind an Effect v4 service.
- Use Taggun as the initial OCR implementation without exposing Taggun types to the domain.
- Retain complete OCR, correction, processing, and audit history.
- Require human approval for every expense.
- Support deterministic rules followed by replaceable AI classification suggestions.
- Provide a responsive SvelteKit review and administration interface.
- Persist application data in SQLite on an Unraid volume.
- Move approved files into a configurable `processed` tree using configurable filenames.
- Support discovery and optional normalization of legacy files already in the processed tree.
- Preserve extension points for a future QuickBooks Online integration.

## 3. Initial Scale

- Fewer than 100 documents per month.
- One active application container.
- One initial admin user.
- Future accountant access through role-based authorization.
- Network exposure through Tailscale, with application authentication still required.

## 4. Scope

### 4.1 Included in the first release

- Watched-folder intake from an Unraid bind mount.
- PDF, JPG, JPEG, and PNG input.
- Automatic ingestion and OCR after a file is stable.
- SHA-256 duplicate detection and duplicate review.
- Durable background jobs and controlled retries.
- Taggun OCR through a provider-neutral Effect v4 service.
- Manual correction of all extracted expense data.
- Canadian tax details, including GST, HST, PST, and QST.
- CAD, USD, and EUR receipt currencies.
- Original-currency values only; no exchange-rate conversion.
- Separate payment-account and expense-category concepts.
- Editable, categorized line items with total validation.
- Client tracking; project tracking is deferred.
- Billable status with a required client when billable.
- Vendor rules followed by AI suggestions.
- AI access to structured OCR data only.
- Human approval before all processing completion.
- Configurable destination-path and filename templates.
- Approval, rejection, reopening, and full audit history.
- Settings management for reference data and templates.
- Better Auth email/password authentication.
- Admin and accountant roles.
- Admin-created, expiring, one-time invitation links.
- Responsive desktop and mobile interfaces.
- Multipage PDF viewing and image zoom/pan.
- Single-item review with keyboard shortcuts.
- Legacy processed-tree discovery and optional import.
- Consistent SQLite backup snapshots.
- Docker Compose and Unraid XML template packaging.

### 4.2 Explicitly deferred

- Browser upload, email intake, and Dropbox API intake.
- QuickBooks Online synchronization.
- Automatic approval or exception-only review.
- Project tracking.
- Foreign-exchange conversion or CAD-equivalent amounts.
- HEIC and TIFF input.
- Image rotation and cropping.
- Bulk expense editing.
- Public user registration.
- Passkeys, TOTP, and Tailscale identity-header authentication.
- Full migration of Appwrite data, OCR sidecars, or historical database records.

## 5. Technology Decisions

- Runtime: Bun.
- Web application: SvelteKit.
- Styling: Tailwind CSS.
- Code quality: Oxlint and Oxfmt.
- Workflow and domain services: Effect v4.
- Authentication: Better Auth.
- Database: SQLite.
- Deployment: one Docker application container.
- Storage: one Unraid root bind mount at `/data`.
- OCR provider: Taggun initially, behind an Effect v4 service.
- AI provider: to be selected through an evaluation spike.
- Secrets: environment variables.

All Effect code and dependencies must use Effect v4 APIs and compatible package versions. The implementation must not mix Effect v3 and v4 packages or patterns.

The SvelteKit interface must use Tailwind CSS for application styling. The application must bundle all required frontend assets. Runtime behavior must not depend on public JavaScript or CSS CDNs.

## 6. Deployment Layout

The container receives one writable root mount:

```text
/data
  /app
    expensifier.sqlite
  /backups
  /inbox
  /processing
  /processed
    /billable
  /rejected
```

Folder names and relative paths are configurable, but all managed locations must resolve beneath `/data`.

A single root mount is required so lifecycle transitions can use atomic filesystem moves when supported by the underlying Unraid filesystem.

## 7. System Architecture

```text
Unraid watched folder
        |
        v
Stable-file reconciler
        |
        v
Hash and durable intake record
        |
        v
Atomic move to processing
        |
        v
Taggun OcrService Layer
        |
        v
Rules, then ClassificationService Layer
        |
        v
Human review in SvelteKit
        |
        +---- approve ----> processed
        |
        +---- reject -----> rejected
```

The application process runs:

- The SvelteKit web server.
- A filesystem event listener.
- A periodic reconciliation scan.
- A durable job runner.
- Effect v4 runtimes and Layers shared by HTTP requests and background jobs.

SQLite stores the job queue so process or container restarts do not lose pending work.

## 8. Effect v4 Service Boundaries

### 8.1 `OcrService`

Responsibilities:

- Accept an application document reference.
- Extract structured receipt data.
- Return provider-neutral normalized values and confidence information.
- Return enough metadata to retain the complete provider response separately.
- Classify provider failures as retryable or permanent.

Initial implementation:

- `TaggunOcrLayer`.
- Taggun credentials come from environment variables.
- Taggun request and response types remain inside this Layer.

### 8.2 `ClassificationService`

Responsibilities:

- Suggest payment account, expense categories, client, and billable status.
- Accept structured OCR fields, configured choices, and relevant rule context.
- Never receive the original file or unrestricted raw OCR text when using an external provider.
- Return structured suggestions with rationale and confidence where available.

The initial provider is selected only after evaluating candidate providers against sanitized fixtures.

### 8.3 `RuleService`

Responsibilities:

- Normalize vendor identity.
- Apply active vendor rules before AI classification.
- Suggest payment account, categories, client, and billable status.
- Identify the exact rule responsible for each suggestion.
- Preserve whether a reviewer accepted or replaced the suggestion.

### 8.4 `FileLifecycleService`

Responsibilities:

- Detect when an intake file is stable enough to process.
- Validate supported extensions and file signatures where practical.
- Calculate content hashes.
- Move files between lifecycle folders.
- Resolve all paths beneath the configured data root.
- Render and sanitize path and filename templates.
- Prevent path traversal and silent overwrites.
- Coordinate collision and recovery behavior.

### 8.5 `ExpenseRepository`

Responsibilities:

- Persist expenses, documents, jobs, reference data, and audit events.
- Provide transaction boundaries for workflow transitions.
- Support migrations and schema-version validation.
- Expose Effect v4 domain failures instead of leaking driver errors.

### 8.6 `JobService`

Responsibilities:

- Enqueue durable work.
- Claim jobs safely within the single process.
- Track attempts, timing, status, and sanitized errors.
- Apply bounded automatic retries with backoff.
- Permit authorized manual retries.
- Recover interrupted work after startup.

### 8.7 `TemplateService`

Responsibilities:

- Validate destination and filename templates before activation.
- Render templates using finalized expense data.
- Represent optional values without stray separators or whitespace.
- Produce a preview in Settings and during review.

### 8.8 `ApprovalIntegrationService`

Responsibilities:

- Receive a finalized expense after local approval succeeds.
- Use a no-op implementation in the first release.
- Allow a future QuickBooks Online Layer without changing approval-domain logic.

External-integration failure must not corrupt local approval state. A future implementation will define its own synchronization status and retry policy.

### 8.9 `AuditService`

Responsibilities:

- Append immutable events for automated and user actions.
- Record actor, timestamp, action, entity, and structured before/after changes where applicable.
- Avoid copying secret material into events.

## 9. Domain Model

### 9.1 Expense

An expense includes:

- Stable application ID.
- Workflow status.
- Vendor.
- Transaction date.
- Total amount represented as a decimal-safe value.
- Currency: CAD, USD, or EUR.
- Notes.
- Billable flag.
- Optional client, required when billable.
- Payment account.
- One or more categorized line items or allocations.
- Canadian tax components.
- Original filename and current managed path.
- Content hash.
- Duplicate relationship when applicable.
- Created, updated, approved, rejected, and reopened metadata.

Money must never use binary floating-point arithmetic. Values must be stored and validated using integer minor units or an equivalent exact decimal representation.

### 9.2 Document

A document includes:

- Stable document ID.
- Expense relationship when imported.
- Original filename.
- Current relative path.
- MIME type and extension.
- Byte size.
- SHA-256 hash.
- Intake source.
- Lifecycle timestamps.
- Legacy-discovery metadata when relevant.

### 9.3 OCR run

Each OCR attempt includes:

- Provider name and implementation version.
- Attempt number and timing.
- Success or failure status.
- Sanitized failure classification.
- Complete raw provider response when available.
- Normalized extracted fields.
- Field-level confidence and provenance where available.

Raw OCR history is retained after approval.

### 9.4 Line item

A line item includes:

- Description.
- Quantity when available.
- Unit price when available.
- Net, tax, and gross amounts when available.
- Expense category.
- Reviewer-edited state.
- OCR or manual provenance.

Reviewers can add, remove, and edit line items. Approval requires the configured line-item or allocation total to balance to the expense total.

### 9.5 Tax component

Tax is represented as one or more components rather than one hardcoded total. Initial supported labels are:

- GST.
- HST.
- PST.
- QST.
- Other Canadian tax.

Each component stores its label, amount, and optional rate. Vendor tax identifiers may be retained when OCR provides them or a reviewer enters them.

### 9.6 Reference data

SQLite stores:

- Payment accounts.
- Expense categories.
- Clients.
- Vendor aliases and classification rules.
- Filename templates.
- Destination-path templates.

Reference records should be deactivated rather than deleted when historical expenses use them.

The legacy payment-account list is imported as an editable initial seed:

- `11190-WISE-USD`.
- `11200-WISE-EUR`.
- `8113-CIBC-USD`.
- `11180-WISE-CAD`.
- `0740-CIBC-USD-VISA`.
- `1408-CIBC-CAD-OWNER-COMP`.
- `1300-CIBC-CAD-PROFIT`.
- `9211-CIBC-CAD-OPEX`.
- `6442-CIBC-CAD-VISA`.

Categories and clients are configured manually in Settings.

### 9.7 Jobs

Durable jobs include:

- Job type.
- Related entity ID.
- Pending, running, succeeded, or failed status.
- Attempt count.
- Earliest next-attempt time.
- Start and completion timestamps.
- Sanitized error code and summary.

### 9.8 Audit events

Audit events cover at least:

- Intake and file moves.
- OCR attempts and retries.
- Duplicate detection decisions.
- Rule and AI suggestions.
- Reviewer edits.
- Approval, rejection, and reopening.
- Template and reference-data changes.
- User, role, and invitation changes.

## 10. Workflow State Model

The primary expense status is intentionally small:

- `processing`: automated work is pending or running.
- `needs_review`: the expense is available for human review.
- `approved`: local review is complete and the file is in the processed tree.
- `rejected`: the document was rejected and moved to the rejected tree.

OCR status, duplicate status, and job status are separate fields. This avoids an unmanageable number of combined workflow states.

Reopening an approved expense transitions it back to `needs_review` and records a reopen audit event. Its prior approval and values remain in history.

## 11. Intake Workflow

1. Detect a supported file in the watched inbox.
2. Wait until size and modification time are stable across configurable checks.
3. Validate that the path remains beneath the inbox and is a regular file.
4. Determine MIME type and supported format.
5. Calculate a SHA-256 content hash.
6. Create the intake and durable processing records.
7. Detect an existing document with the same content hash.
8. Move the file atomically into an application-managed processing location.
9. Queue OCR and classification work.
10. Reconcile partial steps safely after any crash.

Filesystem events are an optimization, not the source of truth. A periodic scanner must discover missed events and recover orphaned processing files.

## 12. Duplicate Workflow

- Identical content is detected by SHA-256, not filename.
- A duplicate remains safely managed in the processing tree.
- The review queue flags the existing matching document or expense.
- No duplicate is silently deleted or automatically approved.
- An authorized reviewer decides whether it is a legitimate separate expense or should be rejected.
- The decision and related expense IDs are audited.

## 13. OCR And Retry Workflow

- OCR starts automatically after successful intake.
- Successful results are normalized and stored with the raw response.
- Missing fields do not prevent manual review.
- Retryable failures use bounded automatic retries and backoff.
- A failed item remains visible in the review queue.
- Authorized users can retry OCR manually or complete all fields manually.
- Retrying OCR creates another OCR-run record and never destroys earlier results or corrections.

## 14. Classification Workflow

Classification order:

1. Apply deterministic active vendor rules.
2. Accept high-specificity rule suggestions as suggestions, never as approval.
3. When no adequate rule exists, invoke the configured AI classification Layer.
4. Show suggestion source and confidence in review.
5. Require the reviewer to confirm or replace all required values.
6. Record accepted and rejected suggestions for audit and future rule maintenance.

External AI providers may receive only normalized structured OCR data, configured candidate values, and relevant rule context. They may not receive the receipt file or unrestricted raw OCR text.

## 15. Review And Approval

Every expense requires explicit human approval.

### 15.1 Required approval fields

- Vendor.
- Transaction date.
- Total amount.
- CAD, USD, or EUR currency.
- Payment account.
- Balanced expense categorization.
- Client when billable.

### 15.2 Review capabilities

- Correct OCR-derived values.
- Edit Canadian tax components.
- Add, remove, edit, and categorize line items.
- Select payment account and client.
- Mark the expense billable.
- Add notes.
- Inspect OCR confidence and provenance.
- Retry OCR after a failure.
- Review duplicate warnings.
- Preview the destination path and filename.

### 15.3 Approval transaction

Approval must:

1. Validate all required and balancing rules.
2. Render and validate the configured destination and filename.
3. Detect destination collisions without overwriting.
4. Move the document into the processed tree.
5. Persist finalized values and approved state.
6. Append an audit event.
7. Invoke the no-op approval integration boundary.

Filesystem and database transitions must be recoverable if the process stops between steps. The UI must never report success while the file move or state transition has failed.

## 16. Filename And Destination Templates

The default filename follows the legacy convention:

```text
DATE VENDOR AMOUNT PAYMENT_ACCOUNT [NOTES] [billable].EXT
```

The default destination behavior follows the legacy layout:

```text
processed/
processed/billable/
```

Templates are editable in Settings and support previews. At minimum, available values include:

- Date.
- Vendor.
- Total amount.
- Currency.
- Payment account.
- Notes.
- Billable status.
- Client.
- Original extension.
- Expense ID.

Template rendering must:

- Remove or replace path separators and control characters from values.
- Normalize optional whitespace and separators.
- Enforce platform-safe segment and path lengths.
- Reject absolute paths and traversal segments.
- Keep the final path beneath the configured processed root.
- Never overwrite an existing file silently.

## 17. Rejection And Reopening

### 17.1 Rejection

- A reviewer supplies a rejection reason.
- The document moves to the configurable rejected tree.
- The expense becomes `rejected`.
- The record, OCR data, and audit history remain available.

### 17.2 Reopening

- Admins and accountants may reopen an approved expense.
- The expense returns to `needs_review`.
- Prior approved values and paths remain in audit history.
- Reapproval applies the current finalized values and templates.
- The processed file is renamed or relocated safely when required.

## 18. Legacy File Discovery

The application scans the configured legacy processed tree for supported files that do not have a matching document record.

Discovery behavior:

- Discovery does not automatically import or alter files.
- A separate UI lists discovered files and filename-validation results.
- The legacy filename parser attempts to derive date, vendor, amount, payment account, notes, and billable status.
- Parse failures and ambiguous values are visible.
- The user can explicitly choose a file for import.

Import behavior:

1. Create a managed review record.
2. Run OCR through the normal service.
3. Compare filename-derived and OCR-derived values.
4. Flag disagreements for review.
5. Require normal strict approval.
6. Normalize the existing file in place according to current templates.
7. Preserve its original path and filename in audit history.

No bulk historical migration is included.

## 19. Authentication And Authorization

### 19.1 Authentication

- Better Auth provides email/password authentication.
- Public registration is disabled.
- The deployment supports a secure first-admin bootstrap flow.
- Admins generate expiring, one-time invitation links from Settings.
- Invitation links are copied and shared manually; SMTP is not required.
- Sessions use secure cookie settings appropriate to the configured application origin.

### 19.2 Roles

`admin` permissions include:

- All expense review actions.
- User and invitation management.
- Reference data, rule, and template management.
- Backup and integration management.
- System settings.

`accountant` permissions include:

- View expenses and documents.
- Edit and review expenses.
- Retry OCR.
- Approve, reject, and reopen expenses.
- View audit history relevant to expenses.

Accountants cannot manage users, authentication, system settings, secrets, or integrations.

Authorization must be enforced server-side. Hiding UI controls is not sufficient.

## 20. User Interface

### 20.1 Queue

The queue supports filtering or grouping by:

- Processing.
- Needs review.
- OCR failure.
- Duplicate warning.
- Approved.
- Rejected.
- Reopened.

### 20.2 Review screen

Desktop uses a split document-and-form layout. Mobile uses a practical stacked layout.

Document support includes:

- Multipage PDF navigation and zoom.
- JPEG and PNG zoom and pan.

The initial review flow is one item at a time. Keyboard shortcuts cover at least:

- Save draft.
- Approve.
- Retry OCR.
- Reject.
- Previous and next review item.

Shortcuts must not fire while typing in a conflicting field and must have discoverable labels.

### 20.3 Settings

Authenticated admin screens manage:

- Payment accounts.
- Expense categories.
- Clients.
- Vendor aliases and rules.
- Filename and destination templates.
- Users, roles, and invitation links.
- Backup settings.
- Future integration settings, excluding secret values.

## 21. Privacy And Logging

Container logs may include:

- Application record IDs.
- Job types and statuses.
- Durations and attempt counts.
- Sanitized error codes and summaries.

Container logs must not include:

- Original or processed filenames.
- Vendor names.
- Amounts or tax details.
- OCR text or raw OCR responses.
- Document paths beyond generic configured-root diagnostics.
- Credentials, cookies, tokens, or invitation values.

Sensitive expense data remains accessible through authenticated application views and the protected SQLite volume.

## 22. Secrets And Configuration

Secrets are supplied through environment variables and are never stored in source control, application logs, audit events, or general settings tables.

Required secret categories include:

- Better Auth secret.
- Taggun API credentials.
- Future AI provider credentials.
- Future QuickBooks Online credentials.

Non-secret operational configuration may use environment variables for initial boot and authenticated Settings for runtime-managed values.

Legacy credentials found in source or logs must not be reused. They should be considered compromised and rotated independently of this implementation.

## 23. Backups

The application provides consistent SQLite snapshots rather than copying a live database file blindly.

A backup contains:

- A transactionally consistent SQLite snapshot.
- Application and schema versions.
- A non-secret configuration manifest.
- Snapshot timestamp and integrity metadata.

Snapshots are written beneath `/data/backups` for Unraid backup tooling. Document-file backup remains the responsibility of the Unraid share backup policy, which should include the managed `/data` tree.

Backup creation must not place environment-variable secrets into the snapshot manifest.

## 24. Health And Recovery

The container exposes liveness and readiness checks.

Readiness requires at least:

- Successful database access and schema validation.
- Writable application and managed data directories.
- Started job runner and reconciliation loop.

Provider outages should not make the web application unready. They should produce visible retryable job failures.

At startup, the application must:

- Release or recover interrupted jobs.
- Reconcile processing files and database state.
- Resume eligible pending work.
- Avoid submitting duplicate OCR requests solely because of a restart.

## 25. Docker And Unraid Packaging

Deliverables:

- Multi-stage Dockerfile using Bun.
- Non-root runtime user where compatible with configured Unraid UID/GID handling.
- Bundled SvelteKit application and assets.
- Health check configuration.
- Docker Compose example.
- Environment-variable example without real credentials.
- Persistent `/data` mount.
- Unraid Community Applications-compatible XML template.
- Documentation for permissions, Tailscale exposure, startup, backup, restore, and upgrades.

The image must not require access to the Docker socket or privileged mode.

## 26. Testing Strategy

### 26.1 Unit tests

- Domain validation and state transitions.
- Exact money calculations and balancing.
- Canadian tax components.
- Filename and path rendering.
- Path traversal and sanitization.
- Rule precedence.
- Provider-response normalization using sanitized fixtures.
- Role permissions.

Effect v4 services should have deterministic test Layers for clock, IDs, OCR, classification, filesystem operations, and repositories where useful.

### 26.2 Integration tests

- SQLite migrations and transactions.
- Better Auth and authorization boundaries.
- Inbox-to-processing-to-processed lifecycle.
- Rejection and reopening.
- Duplicate hashing and decisions.
- OCR retry and manual retry behavior.
- Destination collisions.
- Crash and restart reconciliation.
- Consistent backup creation and restore validation.
- Legacy discovery, filename parsing, and normalization.

### 26.3 Browser tests

- First-admin setup and login.
- Invitation acceptance.
- Desktop and mobile queue navigation.
- Multipage PDF and image review.
- Manual correction and line-item categorization.
- Keyboard shortcuts.
- Strict approval validation.
- Settings and template previews.

### 26.4 Container tests

- Image build.
- Health checks.
- Read-only image filesystem assumptions where practical.
- UID/GID and mounted-volume permissions.
- Restart with pending work.
- Compose startup from an empty data root.

## 27. Acceptance Criteria

The first release is acceptable when:

1. Dropping a supported stable file into `/data/inbox` creates exactly one managed review item.
2. The source moves to `/data/processing` without silent data loss.
3. Taggun runs behind `OcrService`, and no provider type appears in domain or UI contracts.
4. Raw and normalized OCR results remain available after correction and approval.
5. OCR failure leaves an editable review item with visible retry controls.
6. Identical content is flagged for review and never silently deleted or approved.
7. Every expense requires explicit approval.
8. Approval enforces all required fields and balanced categorization.
9. Approved files use safe, configurable destination and filename templates; billable files are
   first held in the top-level processed billable folder before month/year filing.
10. No approval can silently overwrite an existing destination file.
11. Rejection moves the file to the rejected tree and retains its history.
12. Reopening and reapproving preserves history and safely normalizes the processed file.
13. Legacy files can be discovered without alteration, explicitly imported, compared with OCR, and normalized in place.
14. Admin and accountant permissions are enforced server-side.
15. Public registration is unavailable, and one-time invitation links expire after use or timeout.
16. The review workflow is usable on desktop and mobile.
17. Container logs contain IDs and statuses but no filenames, OCR content, or financial values.
18. A consistent SQLite snapshot can be created and integrity-checked.
19. The container recovers pending work after restart without creating duplicate expense records.
20. Docker Compose and the Unraid XML template launch the same image and persistent layout.

## 28. Implementation Backlog

### Phase 0: Technical proof

- Verify SvelteKit production serving on Bun.
- Verify Tailwind CSS compilation and production asset generation in SvelteKit.
- Verify Effect v4 runtime sharing between SvelteKit requests and background fibers.
- Verify Better Auth email/password with SQLite on Bun.
- Verify the selected SQLite access approach and migration tooling.
- Verify reliable PDF rendering and image zoom/pan without runtime CDNs.
- Exercise Taggun with sanitized PDF, JPEG, and PNG fixtures.
- Confirm which normalized fields and line-item details Taggun can provide.

Exit condition: a minimal authenticated page can enqueue an Effect v4 job, persist it in SQLite, process a fixture through a fake OCR Layer, and survive a container restart.

### Phase 1: Foundation

- Create the Bun and SvelteKit application structure.
- Configure Tailwind CSS and the base application design tokens.
- Define Effect v4 service interfaces and Layer composition.
- Add configuration validation.
- Establish SQLite schema and migrations.
- Add privacy-safe structured logging.
- Add liveness and readiness endpoints.
- Add base Dockerfile and Compose development deployment.

Exit condition: the empty application starts from a clean volume, migrates safely, reports healthy, and shuts down cleanly.

### Phase 2: Authentication and authorization

- Integrate Better Auth.
- Build first-admin bootstrap.
- Disable public registration.
- Add admin and accountant authorization policies.
- Implement one-time invitation links.
- Add user and invitation Settings screens.
- Add server-side authorization tests.

Exit condition: an admin can invite an accountant, both can authenticate, and restricted actions are denied server-side.

### Phase 3: Durable intake

- Implement the data-root abstraction.
- Add stable-file detection.
- Add filesystem event listening and periodic reconciliation.
- Add SHA-256 hashing and duplicate relationships.
- Add atomic processing-folder moves.
- Add durable jobs, retry metadata, and startup recovery.
- Build initial queue status views.

Exit condition: supported files are ingested exactly once, duplicates are flagged, and interrupted jobs resume after restart.

### Phase 4: OCR

- Implement normalized OCR domain schemas.
- Implement `TaggunOcrLayer`.
- Retain raw responses and field provenance.
- Classify provider failures.
- Add bounded retry and manual retry behavior.
- Add sanitized OCR fixtures and contract tests.

Exit condition: PDF, JPEG, and PNG fixtures produce retained normalized results or visible recoverable failures.

### Phase 5: Review and file completion

- Build responsive queue and review routes.
- Add multipage PDF viewer.
- Add image zoom and pan.
- Build expense, tax, and line-item editors.
- Add strict validation and balancing.
- Add keyboard shortcuts.
- Implement safe filename and destination templates.
- Implement approval, rejection, reopening, and collision handling.
- Add append-only audit history.

Exit condition: a reviewer can take any successful or failed-OCR item through approval or rejection without leaving inconsistent file and database state.

### Phase 6: Settings and deterministic rules

- Seed legacy payment accounts as editable records.
- Add category and client management.
- Add deactivation rules for referenced data.
- Add vendor aliases and deterministic classification rules.
- Add path and filename template management with previews.
- Display suggestion provenance during review.

Exit condition: an admin can configure all required reference data, and matching vendor rules produce reviewable suggestions.

### Phase 7: AI classification

- Build a sanitized evaluation fixture set.
- Compare candidate providers for accuracy, structured output, privacy, cost, and latency.
- Record the provider decision.
- Implement the chosen `ClassificationService` Layer.
- Enforce the structured-OCR-only data boundary.
- Store suggestions and reviewer outcomes.

Exit condition: unmatched expenses receive structured, auditable suggestions without sending the document or unrestricted OCR text to the provider.

### Phase 8: Legacy discovery

- Scan the configured processed tree without mutation.
- Parse and validate legacy filenames.
- Build the legacy discovery UI.
- Add explicit import.
- Compare filename-derived and OCR-derived values.
- Normalize imported files in place after approval.

Exit condition: legacy files remain untouched until explicitly imported, and imported files pass through normal review and audit behavior.

### Phase 9: Operations and release

- Implement consistent backup snapshots and manifests.
- Add backup integrity and restore tests.
- Complete restart and reconciliation hardening.
- Complete security and privacy review.
- Complete desktop and mobile browser tests.
- Finalize the production image and health checks.
- Add Docker Compose documentation.
- Add the Unraid XML template.
- Document Tailscale exposure, permissions, secrets, backup, restore, and upgrades.

Exit condition: the acceptance criteria pass against the production container using an Unraid-like mounted filesystem layout.

## 29. Required Spikes And Remaining Implementation Choices

The approved product behavior does not require these choices before specification approval, but implementation must resolve and document them:

- SQLite library, migration tool, and Better Auth adapter that work reliably on Bun.
- SvelteKit Bun production adapter and server integration pattern.
- Exact Effect v4 HTTP/RPC boundary used between UI and domain services.
- Bun, SvelteKit, SQLite, and test-library compatibility with the selected Effect v4 packages.
- PDF viewer and image pan/zoom libraries.
- Taggun's current field and line-item capabilities.
- AI provider selection.
- Automatic retry counts and backoff defaults.
- Filename-collision user experience and deterministic fallback naming.
- Backup schedule and retention defaults.
- Unraid UID/GID configuration mechanism.

Each choice should favor the smallest reliable implementation and preserve the service boundaries defined above.
