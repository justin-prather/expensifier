import { Database } from 'bun:sqlite';

import { getRequestEvent } from '$app/server';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { getMigrations } from 'better-auth/db/migration';
import { sveltekitCookies } from 'better-auth/svelte-kit';

import {
	authDatabasePath,
	betterAuthSecret,
	betterAuthUrl,
	ensureDatabaseDirectory
} from './config';

ensureDatabaseDirectory(authDatabasePath);

const authDatabase = new Database(authDatabasePath, { create: true, strict: true });
authDatabase.run('PRAGMA journal_mode = WAL');
authDatabase.run('PRAGMA foreign_keys = ON');
authDatabase.run('PRAGMA busy_timeout = 5000');

export const auth = betterAuth({
	appName: 'Expensifier',
	baseURL: betterAuthUrl,
	secret: betterAuthSecret,
	database: authDatabase,
	emailAndPassword: {
		enabled: true,
		minPasswordLength: 8,
		revokeSessionsOnPasswordReset: true
	},
	user: {
		additionalFields: {
			role: {
				type: ['admin', 'accountant'],
				required: true,
				defaultValue: 'accountant',
				input: false
			}
		}
	},
	databaseHooks: {
		user: {
			create: {
				before: async (user) => {
					if (hasUsers()) {
						throw new APIError('FORBIDDEN', {
							message: 'Public registration is disabled'
						});
					}

					return { data: { ...user, role: 'admin' } };
				}
			}
		}
	},
	advanced: {
		database: {
			joins: true
		}
	},
	onAPIError: {
		throw: true
	},
	telemetry: {
		enabled: false
	},
	plugins: [sveltekitCookies(getRequestEvent)]
});

export async function migrateAuthDatabase(): Promise<void> {
	const migrations = await getMigrations(auth.options);
	await migrations.runMigrations();
}

export function hasUsers(): boolean {
	const table = authDatabase
		.query<{ name: string }, []>(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'user'"
		)
		.get();

	if (!table) {
		return false;
	}

	const row = authDatabase.query<{ count: number }, []>('SELECT COUNT(*) AS count FROM user').get();
	return (row?.count ?? 0) > 0;
}
