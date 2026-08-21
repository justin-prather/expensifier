import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { afterEach } from 'vitest';

import { ensureManagedDirectories, loadRuntimeConfig } from './config';
import { makeDatabaseLayer } from './database';
import { DocumentRepository } from './documents';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { JobRepository, JobService } from './jobs';
import { OcrError, OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';

const temporaryRoots: Array<string> = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeWorkflowLayer(ocrLayer = OcrService.fakeLayer) {
	const dataRoot = mkdtempSync(join(tmpdir(), 'expensifier-ocr-workflow-'));
	temporaryRoots.push(dataRoot);
	const config = loadRuntimeConfig({
		APP_DATA_ROOT: dataRoot,
		INTAKE_STABLE_MILLISECONDS: '0',
		INTAKE_SCAN_INTERVAL_MILLISECONDS: '60000',
		JOB_POLL_INTERVAL_MILLISECONDS: '60000'
	});
	ensureManagedDirectories(config);
	const persistence = Layer.mergeAll(
		JobRepository.layerWithoutDependencies,
		DocumentRepository.layerWithoutDependencies,
		OcrRunRepository.layerWithoutDependencies
	).pipe(Layer.provide(makeDatabaseLayer(':memory:')));
	const dependencies = Layer.mergeAll(persistence, FileLifecycleService.layerFor(config), ocrLayer);
	const services = Layer.merge(
		JobService.layerWithoutDependencies,
		IntakeService.layerFor(config)
	).pipe(Layer.provideMerge(dependencies));
	return { config, layer: services };
}

describe('OCR workflow', () => {
	it.live('retains normalized OCR runs for PDF, JPEG, and PNG documents', () => {
		const { config, layer } = makeWorkflowLayer();
		writeFileSync(join(config.directories.inbox, 'receipt.pdf'), '%PDF-1.4\nfixture');
		writeFileSync(
			join(config.directories.inbox, 'receipt.jpg'),
			Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00])
		);
		writeFileSync(
			join(config.directories.inbox, 'receipt.png'),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
		);

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;
			const runs = yield* OcrRunRepository;
			yield* intake.reconcile;
			yield* jobs.processAvailable;

			const queue = yield* documents.queue;
			expect(queue).toHaveLength(3);
			expect(queue.every((item) => item.ocrStatus === 'succeeded')).toBe(true);
			expect(
				queue.every((item) => item.normalizedOcrJson?.includes('Sanitized Fixture Merchant'))
			).toBe(true);
			for (const item of queue) {
				const history = yield* runs.listForDocument(item.document.id);
				expect(history).toHaveLength(1);
				expect(history[0]?.providerVersion).toBe('fixture-v1');
				expect(history[0]?.attemptNumber).toBe(1);
				expect(history[0]?.rawResponseJson).toContain(item.document.mimeType);
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('keeps failed OCR visible and retains every manual retry', () => {
		const failedOcr = Layer.succeed(
			OcrService,
			OcrService.of({
				provider: 'fixture-failure',
				providerVersion: 'fixture-v1',
				process: () =>
					Effect.fail(
						new OcrError({
							code: 'rejected_document',
							summary: 'OCR provider could not read the document',
							retryable: false,
							rawResponseJson: '{"error":"unreadable"}'
						})
					)
			})
		);
		const { config, layer } = makeWorkflowLayer(failedOcr);
		writeFileSync(join(config.directories.inbox, 'failed.pdf'), '%PDF-1.4\nfixture');

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;
			const runs = yield* OcrRunRepository;
			yield* intake.reconcile;
			yield* jobs.processAvailable;

			const first = (yield* documents.queue)[0]!;
			expect(first.ocrStatus).toBe('failed');
			expect(first.ocrErrorCode).toBe('rejected_document');
			yield* jobs.retryOcr(first.document.id);
			const history = yield* runs.listForDocument(first.document.id);
			expect(history).toHaveLength(2);
			expect(history.map((run) => run.attemptNumber)).toEqual([1, 2]);
			expect(history.every((run) => run.rawResponseJson === '{"error":"unreadable"}')).toBe(true);
		}).pipe(Effect.provide(layer));
	});
});
