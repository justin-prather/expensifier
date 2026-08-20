import { SqliteClient, SqliteMigrator } from '@effect/sql-sqlite-bun';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { appDatabasePath, ensureDatabaseDirectory } from './config';

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
