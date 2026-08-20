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
