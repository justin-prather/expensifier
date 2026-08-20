import { accessSync, constants, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

const developmentSecret = 'development-only-secret-change-before-production';

export interface RuntimeConfig {
	readonly dataRoot: string;
	readonly directories: {
		readonly app: string;
		readonly backups: string;
		readonly inbox: string;
		readonly processing: string;
		readonly processed: string;
		readonly rejected: string;
	};
	readonly appDatabasePath: string;
	readonly authDatabasePath: string;
	readonly betterAuthUrl: string;
	readonly betterAuthSecret: string;
}

function isWithin(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'));
}

function managedPath(root: string, value: string, name: string): string {
	if (value.trim() === '') {
		throw new Error(`${name} must not be empty`);
	}

	const path = resolve(root, value);
	if (!isWithin(root, path)) {
		throw new Error(`${name} must resolve beneath APP_DATA_ROOT`);
	}

	return path;
}

function validHttpUrl(value: string, name: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error(`${name} must be a valid URL`);
	}

	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error(`${name} must use http or https`);
	}

	return url.toString().replace(/\/$/, '');
}

function parseRuntimeConfig(
	environment: Readonly<Record<string, string | undefined>>,
	validateProductionSecrets: boolean
): RuntimeConfig {
	const dataRoot = resolve(environment.APP_DATA_ROOT ?? './data');
	const directories = {
		app: managedPath(dataRoot, environment.APP_APP_PATH ?? 'app', 'APP_APP_PATH'),
		backups: managedPath(dataRoot, environment.APP_BACKUPS_PATH ?? 'backups', 'APP_BACKUPS_PATH'),
		inbox: managedPath(dataRoot, environment.APP_INBOX_PATH ?? 'inbox', 'APP_INBOX_PATH'),
		processing: managedPath(
			dataRoot,
			environment.APP_PROCESSING_PATH ?? 'processing',
			'APP_PROCESSING_PATH'
		),
		processed: managedPath(
			dataRoot,
			environment.APP_PROCESSED_PATH ?? 'processed',
			'APP_PROCESSED_PATH'
		),
		rejected: managedPath(
			dataRoot,
			environment.APP_REJECTED_PATH ?? 'rejected',
			'APP_REJECTED_PATH'
		)
	};
	const appDatabasePath = managedPath(
		dataRoot,
		environment.APP_DATABASE_PATH ?? 'app/expensifier.sqlite',
		'APP_DATABASE_PATH'
	);
	const authDatabasePath = managedPath(
		dataRoot,
		environment.AUTH_DATABASE_PATH ?? 'app/auth.sqlite',
		'AUTH_DATABASE_PATH'
	);
	const betterAuthSecret = environment.BETTER_AUTH_SECRET ?? developmentSecret;

	if (
		validateProductionSecrets &&
		environment.NODE_ENV === 'production' &&
		!environment.BETTER_AUTH_SECRET
	) {
		throw new Error('BETTER_AUTH_SECRET is required in production');
	}
	if (
		validateProductionSecrets &&
		environment.NODE_ENV === 'production' &&
		betterAuthSecret.length < 32
	) {
		throw new Error('BETTER_AUTH_SECRET must contain at least 32 characters in production');
	}
	if (
		validateProductionSecrets &&
		environment.NODE_ENV === 'production' &&
		!environment.BETTER_AUTH_URL
	) {
		throw new Error('BETTER_AUTH_URL is required in production');
	}

	return {
		dataRoot,
		directories,
		appDatabasePath,
		authDatabasePath,
		betterAuthUrl: validHttpUrl(
			environment.BETTER_AUTH_URL ?? 'http://localhost:5173',
			'BETTER_AUTH_URL'
		),
		betterAuthSecret
	};
}

export function loadRuntimeConfig(
	environment: Readonly<Record<string, string | undefined>> = process.env
): RuntimeConfig {
	return parseRuntimeConfig(environment, true);
}

// SvelteKit evaluates server modules while building. Secret enforcement happens in server init.
export const runtimeConfig = parseRuntimeConfig(process.env, false);
export const { appDatabasePath, authDatabasePath, betterAuthSecret, betterAuthUrl, dataRoot } =
	runtimeConfig;

export function ensureDatabaseDirectory(filename: string): void {
	if (filename !== ':memory:') {
		mkdirSync(dirname(filename), { recursive: true });
	}
}

export function ensureManagedDirectories(config: RuntimeConfig = runtimeConfig): void {
	for (const directory of [config.dataRoot, ...Object.values(config.directories)]) {
		mkdirSync(directory, { recursive: true });
		accessSync(directory, constants.R_OK | constants.W_OK);
	}

	ensureDatabaseDirectory(config.appDatabasePath);
	ensureDatabaseDirectory(config.authDatabasePath);
}

export function managedDirectoriesAreWritable(config: RuntimeConfig = runtimeConfig): boolean {
	try {
		for (const directory of [config.dataRoot, ...Object.values(config.directories)]) {
			accessSync(directory, constants.R_OK | constants.W_OK);
		}
		return true;
	} catch {
		return false;
	}
}

export function validateRuntimeConfig(): void {
	loadRuntimeConfig();
}
