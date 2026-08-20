import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
	ensureManagedDirectories,
	loadRuntimeConfig,
	managedDirectoriesAreWritable
} from './config';

const temporaryRoots: Array<string> = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

describe('runtime configuration', () => {
	it('creates the complete managed directory tree beneath the data root', () => {
		const dataRoot = mkdtempSync(join(tmpdir(), 'expensifier-config-'));
		temporaryRoots.push(dataRoot);
		const config = loadRuntimeConfig({ APP_DATA_ROOT: dataRoot });

		ensureManagedDirectories(config);

		expect(managedDirectoriesAreWritable(config)).toBe(true);
		expect(Object.values(config.directories)).toHaveLength(6);
		expect(Object.values(config.directories).every((path) => path.startsWith(dataRoot))).toBe(true);
	});

	it('rejects managed paths that escape the data root', () => {
		expect(() =>
			loadRuntimeConfig({ APP_DATA_ROOT: '/data', APP_INBOX_PATH: '../outside' })
		).toThrow('APP_INBOX_PATH must resolve beneath APP_DATA_ROOT');
	});

	it('requires a strong authentication secret in production', () => {
		expect(() =>
			loadRuntimeConfig({
				NODE_ENV: 'production',
				BETTER_AUTH_URL: 'https://expenses.example.test',
				BETTER_AUTH_SECRET: 'too-short'
			})
		).toThrow('BETTER_AUTH_SECRET must contain at least 32 characters in production');
	});
});
