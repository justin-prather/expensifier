# expensifier

## 0.1.1

### Patch Changes

- File non-billable receipts by transaction year and month, with new year, month, and monthName template tokens and migration of legacy default destinations. Resolve rejected filename collisions using incrementing numeric suffixes while preserving existing files. Persist application data in a named Docker volume.

## 0.1.0

### Minor Changes

- Initial self-hosted release with durable receipt intake, OCR, classification, expense review, approval workflows, and container deployment.
