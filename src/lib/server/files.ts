import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat, unlink, link } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Context, Effect, Layer, Schema } from 'effect';
import * as yauzl from 'yauzl';

import type { RuntimeConfig } from './config';
import { runtimeConfig } from './config';
import type { Document } from './documents';

export interface FileCandidate {
	readonly kind: 'document';
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly originalFilename: string;
	readonly extension: string;
	readonly mimeType: string;
	readonly byteSize: number;
	readonly modifiedAtMilliseconds: number;
	readonly sourceIdentity: string;
}

export interface ArchiveCandidate {
	readonly kind: 'archive';
	readonly absolutePath: string;
	readonly originalFilename: string;
	readonly byteSize: number;
	readonly modifiedAtMilliseconds: number;
	readonly sourceIdentity: string;
}

export type IntakeCandidate = FileCandidate | ArchiveCandidate;

export class FileLifecycleError extends Schema.TaggedError<FileLifecycleError>()(
	'FileLifecycleError',
	{
		code: Schema.Literals([
			'missing_source',
			'invalid_source',
			'collision',
			'move_failed',
			'archive_invalid',
			'archive_limits'
		]),
		retryable: Schema.Boolean
	}
) {}

const supportedTypes = {
	'.pdf': 'application/pdf',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png'
} as const;

const maxArchiveBytes = 100_000_000;
const maxArchiveEntries = 1000;
const maxExpandedBytes = 200_000_000;
const maxCompressionRatio = 100;

function containedPath(root: string, path: string): boolean {
	const child = relative(root, path);
	return child === '' || (!isAbsolute(child) && child !== '..' && !child.startsWith('../'));
}

export function resolveWithin(root: string, relativePath: string): string {
	const path = resolve(root, relativePath);
	if (!containedPath(root, path)) throw new Error('Path resolves outside the managed data root');
	return path;
}

async function matchesSignature(path: string, mimeType: string): Promise<boolean> {
	const file = await open(path, 'r');
	try {
		const buffer = Buffer.alloc(8);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (mimeType === 'application/pdf') return buffer.subarray(0, 5).toString() === '%PDF-';
		if (mimeType === 'image/jpeg') {
			return bytesRead >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
		}
		return (
			bytesRead >= 8 && buffer.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
		);
	} finally {
		await file.close();
	}
}

async function hashPath(path: string): Promise<string> {
	const metadata = await lstat(path);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('invalid_source');
	return new Promise<string>((resolveHash, reject) => {
		const hash = createHash('sha256');
		const stream = createReadStream(path);
		stream.on('error', reject);
		stream.on('data', (chunk) => hash.update(chunk));
		stream.on('end', () => resolveHash(hash.digest('hex')));
	});
}

function safeArchiveEntryName(name: string): boolean {
	const containsControlCharacter = [...name].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		name.length === 0 ||
		name.includes('\\') ||
		name.startsWith('/') ||
		/^[a-zA-Z]:/.test(name) ||
		containsControlCharacter
	) {
		return false;
	}
	return name.split('/').every((part) => part !== '..' && part !== '.');
}

function sanitizeArchiveName(value: string, fallback: string): string {
	return (
		value
			.replace(/[^a-zA-Z0-9._-]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 80) || fallback
	);
}

function regularArchiveEntry(entry: yauzl.Entry): boolean {
	const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
	const type = mode & 0o170000;
	return type === 0 || type === 0o100000;
}

function flattenedArchiveName(
	archiveFilename: string,
	entryName: string,
	archiveHash: string
): string {
	const extension = extname(entryName).toLowerCase();
	const archive = sanitizeArchiveName(
		basename(archiveFilename, extname(archiveFilename)),
		'archive'
	);
	const leaf = sanitizeArchiveName(basename(entryName, extname(entryName)), 'file');
	const pathHash = createHash('sha256').update(entryName).digest('hex').slice(0, 10);
	return `${archive}--${leaf}--${archiveHash.slice(0, 10)}-${pathHash}${extension}`;
}

function openZip(path: string): Promise<yauzl.ZipFile> {
	return new Promise((resolveZip, reject) => {
		yauzl.open(
			path,
			{ lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, zip) => {
				if (error || !zip) reject(error ?? new Error('archive_invalid'));
				else resolveZip(zip);
			}
		);
	});
}

function openZipEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
	return new Promise<Readable>((resolveStream, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error || !stream) reject(error ?? new Error('archive_invalid'));
			else resolveStream(stream);
		});
	});
}

async function candidateForPath(
	config: RuntimeConfig,
	path: string
): Promise<FileCandidate | null> {
	const extension = extname(path).toLowerCase();
	const mimeType = supportedTypes[extension as keyof typeof supportedTypes];
	if (!mimeType || !(await matchesSignature(path, mimeType))) return null;
	const metadata = await stat(path);
	if (!metadata.isFile()) return null;
	return {
		kind: 'document',
		absolutePath: path,
		relativePath: relative(config.dataRoot, path),
		originalFilename: basename(path),
		extension: extension.slice(1),
		mimeType,
		byteSize: metadata.size,
		modifiedAtMilliseconds: metadata.mtimeMs,
		sourceIdentity: `${relative(config.directories.inbox, path)}:${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}:${metadata.ctimeMs}`
	};
}

async function expandZipArchive(
	config: RuntimeConfig,
	candidate: ArchiveCandidate
): Promise<ReadonlyArray<FileCandidate>> {
	const metadata = await lstat(candidate.absolutePath);
	if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('archive_invalid');
	if (
		metadata.size !== candidate.byteSize ||
		metadata.mtimeMs !== candidate.modifiedAtMilliseconds
	) {
		throw new Error('archive_invalid');
	}
	if (metadata.size > maxArchiveBytes) throw new Error('archive_limits');

	const archiveHash = await hashPath(candidate.absolutePath);
	const zip = await openZip(candidate.absolutePath);
	const extracted: FileCandidate[] = [];
	let entryCount = 0;
	let expandedBytes = 0;

	const processEntry = async (entry: yauzl.Entry) => {
		entryCount += 1;
		if (entryCount > maxArchiveEntries) throw new Error('archive_limits');
		if (!safeArchiveEntryName(entry.fileName)) throw new Error('archive_invalid');
		if (entry.fileName.endsWith('/')) return;
		if (!regularArchiveEntry(entry) || (entry.generalPurposeBitFlag & 1) !== 0) {
			throw new Error('archive_invalid');
		}

		const extension = extname(entry.fileName).toLowerCase();
		const mimeType = supportedTypes[extension as keyof typeof supportedTypes];
		if (!mimeType) return;
		if (entry.uncompressedSize > config.ocrMaxFileBytes) throw new Error('archive_limits');
		expandedBytes += entry.uncompressedSize;
		if (expandedBytes > maxExpandedBytes) throw new Error('archive_limits');
		if (
			entry.uncompressedSize > 0 &&
			(entry.compressedSize === 0 ||
				entry.uncompressedSize / entry.compressedSize > maxCompressionRatio)
		) {
			throw new Error('archive_limits');
		}

		const target = join(
			config.directories.inbox,
			flattenedArchiveName(candidate.originalFilename, entry.fileName, archiveHash)
		);
		const temporary = join(config.directories.inbox, `.extract-${randomUUID()}.tmp`);
		try {
			await pipeline(await openZipEntry(zip, entry), createWriteStream(temporary, { flags: 'wx' }));
			const temporaryMetadata = await stat(temporary);
			if (temporaryMetadata.size !== entry.uncompressedSize) throw new Error('archive_invalid');
			if (!(await matchesSignature(temporary, mimeType))) return;
			await publishWithoutOverwrite(temporary, target);
			const published = await candidateForPath(config, target);
			if (published) extracted.push({ ...published, originalFilename: basename(entry.fileName) });
		} finally {
			await unlink(temporary).catch(() => undefined);
		}
	};

	await new Promise<void>((resolveArchive, reject) => {
		let settled = false;
		const fail = (cause: unknown) => {
			if (settled) return;
			settled = true;
			zip.close();
			reject(cause);
		};
		zip.on('error', fail);
		zip.on('end', () => {
			if (settled) return;
			settled = true;
			resolveArchive();
		});
		zip.on('entry', (entry) => {
			void processEntry(entry).then(() => zip.readEntry(), fail);
		});
		zip.readEntry();
	});

	if (extracted.length === 0) throw new Error('archive_invalid');
	await unlink(candidate.absolutePath);
	return extracted;
}

async function publishWithoutOverwrite(temporaryPath: string, targetPath: string): Promise<void> {
	try {
		await link(temporaryPath, targetPath);
		await unlink(temporaryPath);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
		const [temporaryHash, targetMetadata] = await Promise.all([
			hashPath(temporaryPath),
			lstat(targetPath).catch(() => null)
		]);
		if (!targetMetadata?.isFile() || targetMetadata.isSymbolicLink()) {
			throw new Error('collision', { cause });
		}
		if ((await hashPath(targetPath)) !== temporaryHash) {
			throw new Error('collision', { cause });
		}
		await unlink(temporaryPath);
	}
}

export function hashFile(path: string): Effect.Effect<string, FileLifecycleError> {
	return Effect.tryPromise({
		try: () => hashPath(path),
		catch: (cause) =>
			cause instanceof Error && cause.message === 'invalid_source'
				? new FileLifecycleError({ code: 'invalid_source', retryable: false })
				: new FileLifecycleError({ code: 'missing_source', retryable: true })
	});
}

export class FileLifecycleService extends Context.Service<
	FileLifecycleService,
	{
		readonly discover: Effect.Effect<ReadonlyArray<IntakeCandidate>, FileLifecycleError>;
		readonly expandArchive: (
			candidate: ArchiveCandidate
		) => Effect.Effect<ReadonlyArray<FileCandidate>, FileLifecycleError>;
		readonly hash: (path: string) => Effect.Effect<string, FileLifecycleError>;
		readonly moveToProcessing: (document: Document) => Effect.Effect<string, FileLifecycleError>;
		readonly moveToManagedDestination: (
			currentRelativePath: string,
			targetRelativePath: string,
			expectedContentHash: string
		) => Effect.Effect<string, FileLifecycleError>;
		readonly absolutePath: (document: Document) => string;
		readonly managedFileExists: (
			relativePath: string
		) => Effect.Effect<boolean, FileLifecycleError>;
	}
>()('expensifier/FileLifecycleService') {
	static layerFor(config: RuntimeConfig) {
		return Layer.succeed(
			FileLifecycleService,
			FileLifecycleService.of({
				absolutePath: (document) => resolveWithin(config.dataRoot, document.currentRelativePath),
				managedFileExists: (relativePath) =>
					Effect.tryPromise({
						try: async () => {
							const path = resolveWithin(config.dataRoot, relativePath);
							const metadata = await lstat(path).catch(() => null);
							return metadata?.isFile() ?? false;
						},
						catch: () => new FileLifecycleError({ code: 'invalid_source', retryable: false })
					}),
				discover: Effect.tryPromise({
					try: async () => {
						const walk = async (directory: string): Promise<ReadonlyArray<IntakeCandidate>> => {
							const entries = await readdir(directory, { withFileTypes: true });
							const discovered = await Promise.all(
								entries.map(async (entry): Promise<ReadonlyArray<IntakeCandidate>> => {
									const path = join(directory, entry.name);
									if (entry.isDirectory()) return walk(path);
									if (!entry.isFile()) return [];
									const extension = extname(entry.name).toLowerCase();
									const metadata = await stat(path);
									if (!metadata.isFile()) return [];
									const sourceIdentity = `${relative(config.directories.inbox, path)}:${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}:${metadata.ctimeMs}`;
									if (extension === '.zip') {
										return [
											{
												kind: 'archive',
												absolutePath: path,
												originalFilename: basename(path),
												byteSize: metadata.size,
												modifiedAtMilliseconds: metadata.mtimeMs,
												sourceIdentity
											}
										];
									}
									const candidate = await candidateForPath(config, path);
									return candidate ? [candidate] : [];
								})
							);
							return discovered.flat();
						};
						return walk(config.directories.inbox);
					},
					catch: () => new FileLifecycleError({ code: 'invalid_source', retryable: true })
				}),
				expandArchive: (candidate) =>
					Effect.tryPromise({
						try: () => expandZipArchive(config, candidate),
						catch: (cause) => {
							const message = cause instanceof Error ? cause.message : '';
							return new FileLifecycleError({
								code: message === 'archive_limits' ? 'archive_limits' : 'archive_invalid',
								retryable: false
							});
						}
					}),
				hash: hashFile,
				moveToManagedDestination: (currentRelativePath, targetRelativePath, expectedContentHash) =>
					Effect.tryPromise({
						try: async () => {
							const source = resolveWithin(config.dataRoot, currentRelativePath);
							const target = resolveWithin(config.dataRoot, targetRelativePath);
							const targetBeneathLifecycle = [
								config.directories.processed,
								config.directories.rejected
							].some((root) => containedPath(root, target) && relative(root, target) !== '');
							if (!targetBeneathLifecycle) throw new Error('invalid_source');

							const [sourceMetadata, targetMetadata] = await Promise.all([
								lstat(source).catch(() => null),
								lstat(target).catch(() => null)
							]);

							if (targetMetadata?.isFile()) {
								if (!sourceMetadata && (await hashPath(target)) === expectedContentHash) {
									return relative(config.dataRoot, target);
								}
								throw new Error('collision');
							}
							if (!sourceMetadata) throw new Error('missing_source');
							if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
								throw new Error('invalid_source');
							}

							await mkdir(resolve(target, '..'), { recursive: true });
							await rename(source, target);
							return relative(config.dataRoot, target);
						},
						catch: (cause) => {
							const message = cause instanceof Error ? cause.message : '';
							if (message === 'missing_source') {
								return new FileLifecycleError({ code: 'missing_source', retryable: true });
							}
							if (message === 'invalid_source') {
								return new FileLifecycleError({ code: 'invalid_source', retryable: false });
							}
							if (message === 'collision') {
								return new FileLifecycleError({ code: 'collision', retryable: false });
							}
							return new FileLifecycleError({ code: 'move_failed', retryable: true });
						}
					}),
				moveToProcessing: (document) =>
					Effect.tryPromise({
						try: async () => {
							const source = resolveWithin(config.dataRoot, document.currentRelativePath);
							if (!containedPath(config.directories.inbox, source)) {
								throw new Error('invalid_source');
							}
							const destination = join(
								config.directories.processing,
								`${document.id}.${document.extension}`
							);
							const [sourceMetadata, destinationMetadata] = await Promise.all([
								lstat(source).catch(() => null),
								lstat(destination).catch(() => null)
							]);
							if (destinationMetadata?.isFile() && !sourceMetadata) {
								return relative(config.dataRoot, destination);
							}
							if (!sourceMetadata) throw new Error('missing_source');
							if (!sourceMetadata.isFile() || sourceMetadata.isSymbolicLink()) {
								throw new Error('invalid_source');
							}
							if (destinationMetadata) throw new Error('collision');
							await rename(source, destination);
							return relative(config.dataRoot, destination);
						},
						catch: (cause) => {
							const message = cause instanceof Error ? cause.message : '';
							if (message === 'missing_source') {
								return new FileLifecycleError({ code: 'missing_source', retryable: true });
							}
							if (message === 'invalid_source') {
								return new FileLifecycleError({ code: 'invalid_source', retryable: false });
							}
							if (message === 'collision') {
								return new FileLifecycleError({ code: 'collision', retryable: false });
							}
							return new FileLifecycleError({ code: 'move_failed', retryable: true });
						}
					})
			})
		);
	}

	static readonly layer = this.layerFor(runtimeConfig);
}
