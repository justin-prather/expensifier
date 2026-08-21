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
	readonly intakeStableMilliseconds: number;
	readonly intakeScanIntervalMilliseconds: number;
	readonly jobPollIntervalMilliseconds: number;
	readonly jobMaxAttempts: number;
	readonly taggunApiKey: string | null;
	readonly taggunEndpoint: string;
	readonly ocrTimeoutMilliseconds: number;
	readonly ocrMaxFileBytes: number;
	readonly ocrMaxResponseBytes: number;
	readonly classificationApiKey: string | null;
	readonly classificationEndpoint: string;
	readonly classificationModel: string;
	readonly classificationTimeoutMilliseconds: number;
	readonly classificationMaxResponseBytes: number;
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

function validHttpsUrl(value: string, name: string): string {
	const url = validHttpUrl(value, name);
	if (!url.startsWith('https://')) throw new Error(`${name} must use https`);
	return url;
}

function integerSetting(
	value: string | undefined,
	fallback: number,
	name: string,
	minimum: number
): number {
	const parsed = value === undefined ? fallback : Number(value);
	if (!Number.isInteger(parsed) || parsed < minimum) {
		throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
	}
	return parsed;
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
		betterAuthSecret,
		intakeStableMilliseconds: integerSetting(
			environment.INTAKE_STABLE_MILLISECONDS,
			2000,
			'INTAKE_STABLE_MILLISECONDS',
			0
		),
		intakeScanIntervalMilliseconds: integerSetting(
			environment.INTAKE_SCAN_INTERVAL_MILLISECONDS,
			10_000,
			'INTAKE_SCAN_INTERVAL_MILLISECONDS',
			250
		),
		jobPollIntervalMilliseconds: integerSetting(
			environment.JOB_POLL_INTERVAL_MILLISECONDS,
			500,
			'JOB_POLL_INTERVAL_MILLISECONDS',
			100
		),
		jobMaxAttempts: integerSetting(environment.JOB_MAX_ATTEMPTS, 3, 'JOB_MAX_ATTEMPTS', 1),
		taggunApiKey: environment.TAGGUN_API_KEY?.trim() || null,
		taggunEndpoint: validHttpsUrl(
			environment.TAGGUN_ENDPOINT ?? 'https://api.taggun.io/api/receipt/v1/verbose/file',
			'TAGGUN_ENDPOINT'
		),
		ocrTimeoutMilliseconds: integerSetting(
			environment.OCR_TIMEOUT_MILLISECONDS,
			30_000,
			'OCR_TIMEOUT_MILLISECONDS',
			1000
		),
		ocrMaxFileBytes: integerSetting(
			environment.OCR_MAX_FILE_BYTES,
			20_000_000,
			'OCR_MAX_FILE_BYTES',
			1
		),
		ocrMaxResponseBytes: integerSetting(
			environment.OCR_MAX_RESPONSE_BYTES,
			5_000_000,
			'OCR_MAX_RESPONSE_BYTES',
			1
		),
		classificationApiKey: environment.CLASSIFICATION_API_KEY?.trim() || null,
		classificationEndpoint: validHttpsUrl(
			environment.CLASSIFICATION_ENDPOINT ?? 'https://api.openai.com/v1/responses',
			'CLASSIFICATION_ENDPOINT'
		),
		classificationModel: environment.CLASSIFICATION_MODEL?.trim() || 'gpt-4.1-mini',
		classificationTimeoutMilliseconds: integerSetting(
			environment.CLASSIFICATION_TIMEOUT_MILLISECONDS,
			20_000,
			'CLASSIFICATION_TIMEOUT_MILLISECONDS',
			1000
		),
		classificationMaxResponseBytes: integerSetting(
			environment.CLASSIFICATION_MAX_RESPONSE_BYTES,
			1_000_000,
			'CLASSIFICATION_MAX_RESPONSE_BYTES',
			1
		)
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
