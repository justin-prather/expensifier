import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, rename, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';

import { Context, Effect, Layer, Schema } from 'effect';

import type { RuntimeConfig } from './config';
import { runtimeConfig } from './config';
import type { Document } from './documents';

export interface FileCandidate {
	readonly absolutePath: string;
	readonly relativePath: string;
	readonly originalFilename: string;
	readonly extension: string;
	readonly mimeType: string;
	readonly byteSize: number;
	readonly modifiedAtMilliseconds: number;
	readonly sourceIdentity: string;
}

export class FileLifecycleError extends Schema.TaggedError<FileLifecycleError>()(
	'FileLifecycleError',
	{
		code: Schema.Literals(['missing_source', 'invalid_source', 'collision', 'move_failed']),
		retryable: Schema.Boolean
	}
) {}

const supportedTypes = {
	'.pdf': 'application/pdf',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.png': 'image/png'
} as const;

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
		readonly discover: Effect.Effect<ReadonlyArray<FileCandidate>, FileLifecycleError>;
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
						const walk = async (directory: string): Promise<ReadonlyArray<FileCandidate>> => {
							const entries = await readdir(directory, { withFileTypes: true });
							const discovered = await Promise.all(
								entries.map(async (entry): Promise<ReadonlyArray<FileCandidate>> => {
									const path = join(directory, entry.name);
									if (entry.isDirectory()) return walk(path);
									if (!entry.isFile()) return [];
									const extension = extname(entry.name).toLowerCase();
									const mimeType = supportedTypes[extension as keyof typeof supportedTypes];
									if (!mimeType || !(await matchesSignature(path, mimeType))) return [];
									const metadata = await stat(path);
									if (!metadata.isFile()) return [];
									return [
										{
											absolutePath: path,
											relativePath: relative(config.dataRoot, path),
											originalFilename: basename(path),
											extension: extension.slice(1),
											mimeType,
											byteSize: metadata.size,
											modifiedAtMilliseconds: metadata.mtimeMs,
											sourceIdentity: `${relative(config.directories.inbox, path)}:${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}:${metadata.ctimeMs}`
										}
									];
								})
							);
							return discovered.flat();
						};
						return walk(config.directories.inbox);
					},
					catch: () => new FileLifecycleError({ code: 'invalid_source', retryable: true })
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
