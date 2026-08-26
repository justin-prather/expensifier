import {
	createWriteStream,
	mkdtempSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach } from 'vitest';
import * as yazl from 'yazl';

import { AuditRepository } from './audit';
import { ClassificationService } from './classification';
import { ClassificationRepository } from './classification-repository';
import { ensureManagedDirectories, loadRuntimeConfig, type RuntimeConfig } from './config';
import { makeDatabaseLayer } from './database';
import { DocumentRepository } from './documents';
import { ExpenseRepository } from './expenses';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { JobRepository, JobService } from './jobs';
import { OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';
import { VendorRuleService } from './rules';

const temporaryRoots: Array<string> = [];
const pdfFixture = Buffer.from('%PDF-1.4\n% Expensifier sanitized fixture\n');

function writeZip(
	path: string,
	entries: ReadonlyArray<{ name: string; content: Buffer }>
): Promise<void> {
	return new Promise((resolveZip, reject) => {
		const zip = new yazl.ZipFile();
		for (const entry of entries) zip.addBuffer(entry.content, entry.name);
		zip.outputStream.pipe(createWriteStream(path)).on('close', resolveZip).on('error', reject);
		zip.outputStream.on('error', reject);
		zip.end();
	});
}

function replaceAllBytes(buffer: Buffer, from: string, to: string): Buffer {
	if (Buffer.byteLength(from) !== Buffer.byteLength(to))
		throw new Error('Replacement lengths differ');
	const result = Buffer.from(buffer);
	const source = Buffer.from(from);
	const replacement = Buffer.from(to);
	let offset = 0;
	while ((offset = result.indexOf(source, offset)) !== -1) {
		replacement.copy(result, offset);
		offset += replacement.length;
	}
	return result;
}

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) {
		rmSync(root, { recursive: true, force: true });
	}
});

function makeConfig(): RuntimeConfig {
	const dataRoot = mkdtempSync(join(tmpdir(), 'expensifier-intake-'));
	temporaryRoots.push(dataRoot);
	const config = loadRuntimeConfig({
		APP_DATA_ROOT: dataRoot,
		INTAKE_STABLE_MILLISECONDS: '0',
		INTAKE_SCAN_INTERVAL_MILLISECONDS: '60000',
		JOB_POLL_INTERVAL_MILLISECONDS: '60000'
	});
	ensureManagedDirectories(config);
	return config;
}

function makeStableConfig(milliseconds: number): RuntimeConfig {
	const dataRoot = mkdtempSync(join(tmpdir(), 'expensifier-stable-intake-'));
	temporaryRoots.push(dataRoot);
	const config = loadRuntimeConfig({
		APP_DATA_ROOT: dataRoot,
		INTAKE_STABLE_MILLISECONDS: String(milliseconds),
		INTAKE_SCAN_INTERVAL_MILLISECONDS: '60000',
		JOB_POLL_INTERVAL_MILLISECONDS: '60000'
	});
	ensureManagedDirectories(config);
	return config;
}

function makeTestLayer(config: RuntimeConfig) {
	const persistence = Layer.mergeAll(
		JobRepository.layerWithoutDependencies,
		DocumentRepository.layerWithoutDependencies,
		OcrRunRepository.layerWithoutDependencies,
		ExpenseRepository.layerWithoutDependencies,
		AuditRepository.layerWithoutDependencies
	).pipe(Layer.provideMerge(makeDatabaseLayer(':memory:')));
	const classificationPersistence = Layer.merge(
		ClassificationRepository.layerWithoutDependencies,
		VendorRuleService.layerWithoutDependencies
	).pipe(Layer.provideMerge(persistence));
	const dependencies = Layer.merge(
		Layer.mergeAll(
			persistence,
			classificationPersistence,
			FileLifecycleService.layerFor(config),
			ClassificationService.fakeLayer()
		),
		OcrService.fakeLayer
	);
	return Layer.merge(JobService.layerWithoutDependencies, IntakeService.layerFor(config)).pipe(
		Layer.provideMerge(dependencies)
	);
}

describe('durable intake', () => {
	it.live('waits for an unchanged observation before staging a file', () => {
		const config = makeStableConfig(20);
		writeFileSync(join(config.directories.inbox, 'stable.pdf'), pdfFixture);

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const documents = yield* DocumentRepository;
			yield* intake.reconcile;
			expect(yield* documents.queue).toHaveLength(0);
			yield* Effect.sleep('25 millis');
			yield* intake.reconcile;
			expect(yield* documents.queue).toHaveLength(1);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('ingests supported files exactly once and flags matching content', () => {
		const config = makeConfig();
		writeFileSync(join(config.directories.inbox, 'first.pdf'), pdfFixture);
		writeFileSync(join(config.directories.inbox, 'copy.pdf'), pdfFixture);
		writeFileSync(join(config.directories.inbox, 'invalid.pdf'), 'not a PDF');

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;

			yield* intake.reconcile;
			yield* jobs.processAvailable;
			const firstQueue = yield* documents.queue;
			expect(firstQueue).toHaveLength(2);
			expect(firstQueue.every((item) => item.document.status === 'processing')).toBe(true);
			expect(firstQueue.every((item) => item.jobStatus === 'succeeded')).toBe(true);
			expect(firstQueue.filter((item) => item.document.duplicateOfDocumentId)).toHaveLength(1);
			expect(readdirSync(config.directories.inbox)).toEqual(['invalid.pdf']);
			expect(readdirSync(config.directories.processing)).toHaveLength(2);

			yield* intake.reconcile;
			yield* jobs.processAvailable;
			expect(yield* documents.queue).toHaveLength(2);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('recursively ingests files from folders', () => {
		const config = makeConfig();
		const nested = join(config.directories.inbox, 'batch', 'receipts');
		mkdirSync(nested, { recursive: true });
		writeFileSync(join(nested, 'nested.pdf'), pdfFixture);

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const documents = yield* DocumentRepository;
			yield* intake.reconcile;
			const queue = yield* documents.queue;
			expect(queue).toHaveLength(1);
			expect(queue[0]?.document.originalFilename).toBe('nested.pdf');
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('extracts nested ZIP entries into flattened intake files', () => {
		const config = makeConfig();
		const archivePath = join(config.directories.inbox, 'receipt-batch.zip');

		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				writeZip(archivePath, [
					{ name: 'team-a/receipt.pdf', content: pdfFixture },
					{
						name: 'team-b/receipt.pdf',
						content: Buffer.concat([pdfFixture, Buffer.from('second')])
					},
					{ name: 'notes.txt', content: Buffer.from('ignored') }
				])
			);
			const intake = yield* IntakeService;
			const documents = yield* DocumentRepository;
			yield* intake.reconcile;

			const queue = yield* documents.queue;
			expect(queue).toHaveLength(2);
			expect(queue.map((item) => item.document.originalFilename)).toEqual([
				'receipt.pdf',
				'receipt.pdf'
			]);
			const inboxEntries = readdirSync(config.directories.inbox);
			expect(inboxEntries.some((name) => name.endsWith('.zip'))).toBe(false);
			expect(inboxEntries.filter((name) => name.endsWith('.pdf'))).toHaveLength(2);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('waits for a ZIP archive to become stable before extraction', () => {
		const config = makeStableConfig(20);
		const archivePath = join(config.directories.inbox, 'stable.zip');

		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				writeZip(archivePath, [{ name: 'receipt.pdf', content: pdfFixture }])
			);
			const intake = yield* IntakeService;
			const documents = yield* DocumentRepository;
			yield* intake.reconcile;
			expect(yield* documents.queue).toHaveLength(0);
			expect(readdirSync(config.directories.inbox)).toContain('stable.zip');

			yield* Effect.sleep('25 millis');
			yield* intake.reconcile;
			expect(yield* documents.queue).toHaveLength(1);
			expect(readdirSync(config.directories.inbox).some((name) => name.endsWith('.zip'))).toBe(
				false
			);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('rejects ZIP traversal entries without writing outside the inbox', () => {
		const config = makeConfig();
		const archivePath = join(config.directories.inbox, 'unsafe.zip');
		const escapedPath = join(config.dataRoot, 'a.pdf');

		return Effect.gen(function* () {
			yield* Effect.promise(async () => {
				await writeZip(archivePath, [{ name: 'evil.pdf', content: pdfFixture }]);
				const archive = await readFile(archivePath);
				await writeFile(archivePath, replaceAllBytes(archive, 'evil.pdf', '../a.pdf'));
			});
			const intake = yield* IntakeService;
			const documents = yield* DocumentRepository;
			yield* intake.reconcile;

			expect(yield* documents.queue).toHaveLength(0);
			expect(readdirSync(config.directories.inbox)).toContain('unsafe.zip');
			const escapedFileExists = yield* Effect.promise(() =>
				readFile(escapedPath).then(
					() => true,
					() => false
				)
			);
			expect(escapedFileExists).toBe(false);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('recovers an interrupted job after its atomic move completed', () => {
		const config = makeConfig();
		writeFileSync(join(config.directories.inbox, 'recover.pdf'), pdfFixture);

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const jobRepository = yield* JobRepository;
			const documents = yield* DocumentRepository;
			const files = yield* FileLifecycleService;

			yield* intake.reconcile;
			const document = (yield* documents.listPendingMoves)[0];
			expect(document).toBeDefined();
			const claimed = yield* jobRepository.claimNext;
			expect(claimed?.status).toBe('running');
			yield* files.moveToProcessing(document!);

			yield* jobs.recoverAndProcess;
			const queue = yield* documents.queue;
			expect(queue[0]?.document.status).toBe('processing');
			expect(queue[0]?.jobStatus).toBe('succeeded');
			expect(queue[0]?.attemptCount).toBe(2);
		}).pipe(Effect.provide(makeTestLayer(config)));
	});

	it.live('schedules bounded retries with sanitized failure metadata', () => {
		const config = makeConfig();

		return Effect.gen(function* () {
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;
			const staged = yield* documents.stage({
				originalFilename: 'missing.pdf',
				currentRelativePath: 'inbox/missing.pdf',
				mimeType: 'application/pdf',
				extension: 'pdf',
				byteSize: pdfFixture.byteLength,
				contentHash: 'missing-content-hash',
				sourceIdentity: 'missing-source-identity'
			});

			yield* jobs.processAvailable;
			const queue = yield* documents.queue;
			expect(staged.created).toBe(true);
			expect(queue[0]?.jobStatus).toBe('pending');
			expect(queue[0]?.attemptCount).toBe(1);
			expect(queue[0]?.errorCode).toBe('missing_source');
			expect(queue[0]?.nextAttemptAt).not.toBeNull();
		}).pipe(Effect.provide(makeTestLayer(config)));
	});
});
