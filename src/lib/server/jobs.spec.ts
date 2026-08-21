import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { afterEach } from 'vitest';

import { AuditRepository } from './audit';
import { ClassificationService } from './classification';
import { ClassificationRepository } from './classification-repository';
import { ensureManagedDirectories, loadRuntimeConfig } from './config';
import { makeDatabaseLayer } from './database';
import { DocumentRepository } from './documents';
import { ExpenseRepository } from './expenses';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { JobRepository, JobService } from './jobs';
import { OcrError, OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';
import { VendorRuleService } from './rules';

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
		OcrRunRepository.layerWithoutDependencies,
		ExpenseRepository.layerWithoutDependencies,
		AuditRepository.layerWithoutDependencies
	).pipe(Layer.provideMerge(makeDatabaseLayer(':memory:')));
	const classificationPersistence = Layer.merge(
		ClassificationRepository.layerWithoutDependencies,
		VendorRuleService.layerWithoutDependencies
	).pipe(Layer.provideMerge(persistence));
	const dependencies = Layer.mergeAll(
		persistence,
		classificationPersistence,
		FileLifecycleService.layerFor(config),
		ocrLayer,
		ClassificationService.fakeLayer()
	);
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
			const expenses = yield* ExpenseRepository;
			const classifications = yield* ClassificationRepository;
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
				const expense = yield* expenses.findByDocumentId(item.document.id);
				expect(expense).not.toBeNull();
				const classification = yield* classifications.latestForExpense(expense!.id);
				expect(classification.run?.status).toBe('succeeded');
				expect(classification.suggestion?.provider).toBe('fake');
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('backfills classification after startup settles an OCR-complete expense', () => {
		const { config, layer } = makeWorkflowLayer();
		writeFileSync(join(config.directories.inbox, 'settled-on-startup.pdf'), '%PDF-1.4\nfixture');

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const service = yield* JobService;
			const documents = yield* DocumentRepository;
			const expenses = yield* ExpenseRepository;
			const classifications = yield* ClassificationRepository;
			const sql = yield* SqlClient.SqlClient;
			yield* intake.reconcile;
			yield* service.processAvailable;
			const document = (yield* documents.queue)[0]!.document;
			const expense = (yield* expenses.findByDocumentId(document.id))!;
			yield* sql`DELETE FROM classification_suggestions WHERE expense_id = ${expense.id}`;
			yield* sql`DELETE FROM classification_runs WHERE expense_id = ${expense.id}`;
			yield* sql`DELETE FROM jobs WHERE type = 'classify_expense' AND related_entity_id = ${expense.id}`;
			yield* sql`UPDATE expenses SET status = 'processing' WHERE id = ${expense.id}`;

			yield* service.recoverAndProcess;
			const recoveredExpense = yield* expenses.findById(expense.id);
			const state = yield* classifications.latestForExpense(expense.id);

			expect(recoveredExpense?.status).toBe('needs_review');
			expect(state.run?.status).toBe('succeeded');
			expect(state.suggestion?.provider).toBe('fake');
		}).pipe(Effect.provide(layer));
	});

	it.live('skips AI classification when an active deterministic rule matches', () => {
		const { config, layer } = makeWorkflowLayer();
		writeFileSync(join(config.directories.inbox, 'rule-match.pdf'), '%PDF-1.4\nfixture');

		return Effect.gen(function* () {
			const rules = yield* VendorRuleService;
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;
			const expenses = yield* ExpenseRepository;
			const classifications = yield* ClassificationRepository;
			yield* rules.create(
				{
					alias: 'sanitized fixture merchant',
					vendorName: 'Fixture Merchant',
					paymentAccountId: null,
					categoryId: null,
					clientId: null
				},
				{ id: 'admin-1', label: 'Admin One' }
			);
			yield* intake.reconcile;
			yield* jobs.processAvailable;

			const item = (yield* documents.queue)[0]!;
			const expense = yield* expenses.findByDocumentId(item.document.id);
			const state = yield* classifications.latestForExpense(expense!.id);
			const classificationJob = (yield* jobs.list).find((job) => job.type === 'classify_expense');

			expect(state.run).toBeNull();
			expect(classificationJob?.status).toBe('succeeded');
			expect(classificationJob?.resultJson).toContain('deterministic_rule');
		}).pipe(Effect.provide(layer));
	});

	it.live('marks interrupted external classification outcomes failed on recovery', () => {
		const { config, layer } = makeWorkflowLayer();
		writeFileSync(
			join(config.directories.inbox, 'interrupted-classification.pdf'),
			'%PDF-1.4\nfixture'
		);

		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const service = yield* JobService;
			const jobs = yield* JobRepository;
			const documents = yield* DocumentRepository;
			const expenses = yield* ExpenseRepository;
			yield* intake.reconcile;
			yield* service.processAvailable;
			const document = (yield* documents.queue)[0]!.document;
			const expense = (yield* expenses.findByDocumentId(document.id))!;
			const pending = yield* jobs.createClassification(expense.id);
			const claimed = yield* jobs.claimNext;
			expect(claimed?.id).toBe(pending.id);

			yield* service.recoverAndProcess;
			const classifications = yield* ClassificationRepository;
			const state = yield* classifications.latestForExpense(expense.id);
			const recoveredJob = (yield* jobs.list).find((job) => job.id === pending.id);

			expect(recoveredJob?.status).toBe('failed');
			expect(recoveredJob?.errorCode).toBe('outcome_unknown');
			expect(state.run?.status).toBe('failed');
			expect(state.run?.errorCode).toBe('outcome_unknown');
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
