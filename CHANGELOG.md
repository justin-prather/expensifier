# expensifier

## 0.1.2

### Patch Changes

- Remove deployment-specific account labels from new-installation seed data and template examples. Existing saved accounts remain unchanged.

- Refine receipt classification with specific categories, independent billable decisions, and shared-client safeguards. Keep deployment-specific preferences in optional runtime configuration instead of the shared prompt or container image. Update the OpenCode endpoint and model, explain expired API keys, and add a local-only container build override.

## 0.1.1

### Patch Changes

- File non-billable receipts by transaction year and month, with new year, month, and monthName template tokens and migration of legacy default destinations. Resolve rejected filename collisions using incrementing numeric suffixes while preserving existing files. Persist application data in a named Docker volume.

## 0.1.0

### Minor Changes

- Initial self-hosted release with durable receipt intake, OCR, classification, expense review, approval workflows, and container deployment.
