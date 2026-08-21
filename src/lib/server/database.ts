import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-bun';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { appDatabasePath, ensureDatabaseDirectory, runtimeConfig } from './config';

const migrations = SqliteMigrator.fromRecord({
	'0001_create_jobs': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE jobs (
				id TEXT PRIMARY KEY,
				type TEXT NOT NULL,
				status TEXT NOT NULL,
				result_json TEXT,
				error_code TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX jobs_status_created_at ON jobs (status, created_at)`;
	}),
	'0002_create_invitations': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE invitations (
				id TEXT PRIMARY KEY,
				email TEXT NOT NULL,
				role TEXT NOT NULL CHECK (role IN ('admin', 'accountant')),
				token_hash TEXT NOT NULL UNIQUE,
				invited_by_user_id TEXT NOT NULL,
				expires_at TEXT NOT NULL,
				accepted_at TEXT,
				accepted_by_user_id TEXT,
				revoked_at TEXT,
				created_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX invitations_email_created_at ON invitations (email, created_at)`;
		yield* sql`CREATE INDEX invitations_status_expires_at ON invitations (accepted_at, revoked_at, expires_at)`;
	}),
	'0003_create_documents_and_durable_jobs': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE documents (
				id TEXT PRIMARY KEY,
				status TEXT NOT NULL CHECK (status IN ('intake_pending', 'processing', 'failed')),
				original_filename TEXT NOT NULL,
				current_relative_path TEXT NOT NULL UNIQUE,
				mime_type TEXT NOT NULL,
				extension TEXT NOT NULL,
				byte_size INTEGER NOT NULL,
				content_hash TEXT NOT NULL,
				source_identity TEXT NOT NULL UNIQUE,
				intake_source TEXT NOT NULL DEFAULT 'watched_folder',
				duplicate_of_document_id TEXT REFERENCES documents(id),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				managed_at TEXT
			)
		`;
		yield* sql`CREATE INDEX documents_status_created_at ON documents (status, created_at)`;
		yield* sql`CREATE INDEX documents_content_hash ON documents (content_hash, created_at)`;
		yield* sql`ALTER TABLE jobs ADD COLUMN related_entity_id TEXT`;
		yield* sql`ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0`;
		yield* sql`ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3`;
		yield* sql`ALTER TABLE jobs ADD COLUMN next_attempt_at TEXT`;
		yield* sql`ALTER TABLE jobs ADD COLUMN started_at TEXT`;
		yield* sql`ALTER TABLE jobs ADD COLUMN completed_at TEXT`;
		yield* sql`ALTER TABLE jobs ADD COLUMN error_summary TEXT`;
		yield* sql`
			CREATE UNIQUE INDEX jobs_intake_entity
			ON jobs (related_entity_id, type)
			WHERE related_entity_id IS NOT NULL AND type = 'intake_document'
		`;
		yield* sql`CREATE INDEX jobs_eligible ON jobs (status, next_attempt_at, created_at)`;
	}),
	'0004_create_ocr_runs': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`ALTER TABLE documents ADD COLUMN ocr_enqueued_at TEXT`;
		yield* sql`
			CREATE TABLE ocr_runs (
				id TEXT PRIMARY KEY,
				document_id TEXT NOT NULL REFERENCES documents(id),
				job_id TEXT NOT NULL REFERENCES jobs(id),
				provider TEXT NOT NULL,
				provider_version TEXT NOT NULL,
				attempt_number INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
				raw_response_json TEXT,
				normalized_result_json TEXT,
				error_code TEXT,
				error_summary TEXT,
				started_at TEXT NOT NULL,
				completed_at TEXT
			)
		`;
		yield* sql`CREATE INDEX ocr_runs_document_started ON ocr_runs (document_id, started_at)`;
		yield* sql`CREATE UNIQUE INDEX ocr_runs_job_attempt ON ocr_runs (job_id, started_at)`;
		yield* sql`CREATE UNIQUE INDEX ocr_runs_document_attempt ON ocr_runs (document_id, attempt_number)`;

		const now = new Date().toISOString();
		const existing = yield* sql<{ readonly id: string }>`
			SELECT id FROM documents WHERE status = 'processing' AND ocr_enqueued_at IS NULL
		`;
		for (const document of existing) {
			yield* sql`
				INSERT INTO jobs (
					id, type, status, related_entity_id, attempt_count, max_attempts,
					next_attempt_at, created_at, updated_at
				) VALUES (
					${crypto.randomUUID()}, 'ocr_document', 'pending', ${document.id},
					0, ${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now}
				)
			`;
			yield* sql`UPDATE documents SET ocr_enqueued_at = ${now}, updated_at = ${now} WHERE id = ${document.id}`;
		}
	}),
	'0005_create_review_and_audit': Effect.gen(function* () {
		const sql = yield* SqlClient.SqlClient;
		yield* sql`
			CREATE TABLE payment_accounts (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
				created_at TEXT NOT NULL
			)
		`;
		yield* sql`
			CREATE TABLE expense_categories (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
				created_at TEXT NOT NULL
			)
		`;
		yield* sql`
			CREATE TABLE clients (
				id TEXT PRIMARY KEY,
				name TEXT NOT NULL UNIQUE,
				active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
				created_at TEXT NOT NULL
			)
		`;
		yield* sql`
			CREATE TABLE expenses (
				id TEXT PRIMARY KEY,
				document_id TEXT NOT NULL UNIQUE REFERENCES documents(id),
				status TEXT NOT NULL CHECK (status IN ('processing', 'needs_review', 'approved', 'rejected')),
				vendor TEXT,
				transaction_date TEXT,
				total_minor INTEGER,
				currency TEXT CHECK (currency IN ('CAD', 'USD', 'EUR')),
				notes TEXT,
				billable INTEGER NOT NULL DEFAULT 0 CHECK (billable IN (0, 1)),
				client_id TEXT REFERENCES clients(id),
				payment_account_id TEXT REFERENCES payment_accounts(id),
				rejection_reason TEXT,
				pending_move_json TEXT,
				approved_at TEXT,
				approved_by TEXT,
				rejected_at TEXT,
				rejected_by TEXT,
				reopened_at TEXT,
				reopened_by TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX expenses_status_updated ON expenses (status, updated_at)`;
		yield* sql`
			CREATE TABLE expense_line_items (
				id TEXT PRIMARY KEY,
				expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
				position INTEGER NOT NULL,
				description TEXT NOT NULL,
				quantity TEXT,
				unit_price_minor INTEGER,
				net_minor INTEGER,
				tax_minor INTEGER,
				gross_minor INTEGER,
				category_id TEXT REFERENCES expense_categories(id),
				provenance TEXT NOT NULL CHECK (provenance IN ('ocr', 'manual')),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX expense_line_items_expense_position ON expense_line_items (expense_id, position)`;
		yield* sql`
			CREATE TABLE expense_tax_components (
				id TEXT PRIMARY KEY,
				expense_id TEXT NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
				label TEXT NOT NULL CHECK (label IN ('GST', 'HST', 'PST', 'QST', 'OTHER')),
				amount_minor INTEGER NOT NULL,
				rate_percent TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX expense_tax_components_expense ON expense_tax_components (expense_id)`;
		yield* sql`
			CREATE TABLE audit_events (
				id TEXT PRIMARY KEY,
				actor_user_id TEXT,
				actor_label TEXT NOT NULL,
				action TEXT NOT NULL,
				entity_type TEXT NOT NULL,
				entity_id TEXT NOT NULL,
				data_json TEXT,
				created_at TEXT NOT NULL
			)
		`;
		yield* sql`CREATE INDEX audit_events_entity_created ON audit_events (entity_type, entity_id, created_at)`;
		yield* sql`CREATE INDEX audit_events_created ON audit_events (created_at)`;
		yield* sql`
			CREATE TABLE app_settings (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at TEXT NOT NULL
			)
		`;

		const now = new Date().toISOString();
		const accounts = [
			'11190-WISE-USD',
			'11200-WISE-EUR',
			'8113-CIBC-USD',
			'11180-WISE-CAD',
			'0740-CIBC-USD-VISA',
			'1408-CIBC-CAD-OWNER-COMP',
			'1300-CIBC-CAD-PROFIT',
			'9211-CIBC-CAD-OPEX',
			'6442-CIBC-CAD-VISA'
		];
		for (const name of accounts) {
			yield* sql`
				INSERT INTO payment_accounts (id, name, active, created_at)
				VALUES (${crypto.randomUUID()}, ${name}, 1, ${now})
			`;
		}
		const categories = [
			'Meals & Entertainment',
			'Office Supplies',
			'Software & Subscriptions',
			'Travel',
			'Professional Services',
			'Hardware & Equipment',
			'Other'
		];
		for (const name of categories) {
			yield* sql`
				INSERT INTO expense_categories (id, name, active, created_at)
				VALUES (${crypto.randomUUID()}, ${name}, 1, ${now})
			`;
		}
	})
});

export function makeDatabaseLayer(filename: string) {
	ensureDatabaseDirectory(filename);

	const client = SqliteClient.layer({
		filename,
		create: true,
		busyTimeout: '5 seconds'
	});

	return SqliteMigrator.layer({ loader: migrations }).pipe(Layer.provideMerge(client));
}

export const DatabaseLive = makeDatabaseLayer(appDatabasePath);
