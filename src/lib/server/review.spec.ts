import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';
import { afterEach } from 'vitest';

import { ApprovalIntegrationService } from './approval-integration';
import { AuditRepository } from './audit';
import { ClassificationService } from './classification';
import { ClassificationRepository } from './classification-repository';
import { ensureManagedDirectories, loadRuntimeConfig } from './config';
import { makeDatabaseLayer } from './database';
import { DocumentRepository } from './documents';
import { ExpenseRepository, type ExpenseDraftInput } from './expenses';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { JobRepository, JobService } from './jobs';
import { OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';
import { ReviewService, validateDraft } from './review';
import { VendorRuleService } from './rules';
import { TemplateService } from './templates';

const temporaryRoots: Array<string> = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeReviewLayer() {
	const dataRoot = mkdtempSync(join(tmpdir(), 'expensifier-review-'));
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
		AuditRepository.layerWithoutDependencies,
		TemplateService.layerWithoutDependencies
	).pipe(Layer.provideMerge(makeDatabaseLayer(':memory:')));
	const classificationPersistence = Layer.merge(
		ClassificationRepository.layerWithoutDependencies,
		VendorRuleService.layerWithoutDependencies
	).pipe(Layer.provideMerge(persistence));
	const dependencies = Layer.mergeAll(
		persistence,
		classificationPersistence,
		FileLifecycleService.layerFor(config),
		ApprovalIntegrationService.layer,
		OcrService.fakeLayer,
		ClassificationService.fakeLayer()
	);
	const services = Layer.mergeAll(
		JobService.layerWithoutDependencies,
		IntakeService.layerFor(config),
		ReviewService.layerWithoutDependencies
	).pipe(Layer.provideMerge(dependencies));
	return { config, layer: services };
}

const pdfFixture = '%PDF-1.4\nreview fixture';

const actor = { id: 'user-1', label: 'Reviewer One' };

function draftInput(overrides: Partial<ExpenseDraftInput> = {}): ExpenseDraftInput {
	return {
		vendor: 'Fixture Merchant',
		transactionDate: '2026-08-19',
		total: '23.45',
		currency: 'CAD',
		notes: 'team lunch',
		billable: false,
		clientId: null,
		paymentAccountId: null,
		lineItems: [],
		taxComponents: [],
		...overrides
	};
}

const intakeOneReceipt = (inboxPath: string) =>
	Effect.gen(function* () {
		const intake = yield* IntakeService;
		const jobs = yield* JobService;
		const documents = yield* DocumentRepository;
		const expenses = yield* ExpenseRepository;

		writeFileSync(join(inboxPath, 'receipt.pdf'), pdfFixture);
		yield* intake.reconcile;
		yield* jobs.processAvailable;

		const queue = yield* documents.queue;
		expect(queue).toHaveLength(1);
		const documentId = queue[0]!.document.id;

		yield* expenses.reconcileSettled;
		const expense = yield* expenses.findByDocumentId(documentId);
		expect(expense?.status).toBe('needs_review');

		return { documentId, expenseId: expense!.id };
	});

describe('review flows', () => {
	it.live('flags missing and malformed fields when validating a strict draft', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			yield* intakeOneReceipt(config.directories.inbox);
			const refs = yield* expenses.referenceData;
			const outcome = yield* Effect.result(
				validateDraft(
					draftInput({
						vendor: '',
						transactionDate: 'not-a-date',
						total: '',
						currency: 'GBP',
						lineItems: [
							{
								description: 'Lunch',
								quantity: '',
								unitPrice: '',
								netAmount: '',
								taxAmount: '',
								grossAmount: '',
								categoryId: ''
							}
						]
					}),
					refs,
					true
				)
			);
			expect(Result.isFailure(outcome)).toBe(true);
			if (Result.isFailure(outcome)) {
				const fieldErrors = outcome.failure.fieldErrors;
				for (const key of [
					'vendor',
					'transactionDate',
					'total',
					'currency',
					'paymentAccount',
					'lineItems.0.categoryId',
					'lineItems.0.grossAmount'
				]) {
					expect(fieldErrors).toHaveProperty(key);
				}
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('approves, reopens, and rejects a receipt end to end', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const review = yield* ReviewService;
			const expenses = yield* ExpenseRepository;
			const audit = yield* AuditRepository;
			const intake = yield* intakeOneReceipt(config.directories.inbox);

			const refs = yield* expenses.referenceData;
			const accountName = refs.paymentAccounts[0]!.name;
			const targetPath = yield* review.approve(
				intake.expenseId,
				draftInput({
					paymentAccountId: refs.paymentAccounts[0]!.id,
					lineItems: [
						{
							description: 'Team lunch',
							quantity: '1',
							unitPrice: '23.45',
							netAmount: '23.45',
							taxAmount: '',
							grossAmount: '23.45',
							categoryId: refs.categories[0]!.id
						}
					]
				}),
				actor
			);

			expect(targetPath).toBe(
				`processed/2026-08-19 Fixture Merchant 23.45 ${accountName} team lunch.pdf`
			);
			expect(existsSync(join(config.dataRoot, targetPath))).toBe(true);

			const approvedExpense = yield* expenses.findById(intake.expenseId);
			expect(approvedExpense?.status).toBe('approved');
			expect(approvedExpense?.pendingMoveJson).toBeNull();

			const approvalEvents = yield* audit.listForEntity('expense', intake.expenseId);
			const actions = approvalEvents.map((event) => event.action);
			expect(actions).toContain('approval_started');
			expect(actions).toContain('approved');

			yield* review.reopen(intake.expenseId, actor);
			const reopenedExpense = yield* expenses.findById(intake.expenseId);
			expect(reopenedExpense?.status).toBe('needs_review');
			expect(reopenedExpense?.reopenedAt).not.toBeNull();

			const rejectedPath = yield* review.reject(intake.expenseId, 'Duplicate submission', actor);
			expect(rejectedPath).toBe('rejected/receipt.pdf');
			expect(existsSync(join(config.dataRoot, rejectedPath))).toBe(true);
			expect(existsSync(join(config.dataRoot, targetPath))).toBe(false);

			const rejectedExpense = yield* expenses.findById(intake.expenseId);
			expect(rejectedExpense?.status).toBe('rejected');
			expect(rejectedExpense?.rejectionReason).toBe('Duplicate submission');

			const rejectedReopen = yield* Effect.result(review.reopen(intake.expenseId, actor));
			expect(Result.isFailure(rejectedReopen)).toBe(true);
			if (Result.isFailure(rejectedReopen)) {
				expect(rejectedReopen.failure.message).toBe('Expense is not approved');
			}
			const stillRejected = yield* expenses.findById(intake.expenseId);
			expect(stillRejected?.status).toBe('rejected');
		}).pipe(Effect.provide(layer));
	});

	it.live('rejects drafts whose line items do not balance with the total', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			yield* intakeOneReceipt(config.directories.inbox);
			const refs = yield* expenses.referenceData;
			const outcome = yield* Effect.result(
				validateDraft(
					draftInput({
						paymentAccountId: refs.paymentAccounts[0]!.id,
						total: '20.00',
						lineItems: [
							{
								description: 'Mismatched',
								quantity: '1',
								unitPrice: '10.00',
								netAmount: '10.00',
								taxAmount: '',
								grossAmount: '10.00',
								categoryId: refs.categories[0]!.id
							}
						]
					}),
					refs,
					true
				)
			);
			expect(Result.isFailure(outcome)).toBe(true);
			if (Result.isFailure(outcome)) {
				expect(outcome.failure.fieldErrors.lineItems).toContain(
					'Line items total 10.00 but expense total is 20.00'
				);
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('blocks approval when the destination already exists', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const intake = yield* IntakeService;
			const jobs = yield* JobService;
			const documents = yield* DocumentRepository;
			const expenses = yield* ExpenseRepository;
			const review = yield* ReviewService;
			const first = yield* intakeOneReceipt(config.directories.inbox);

			writeFileSync(join(config.directories.inbox, 'receipt-copy.pdf'), pdfFixture);
			yield* intake.reconcile;
			yield* jobs.processAvailable;
			yield* expenses.reconcileSettled;
			const queue = yield* documents.queue;
			const secondDocument = queue.find((item) => item.document.id !== first.documentId);
			expect(secondDocument).toBeDefined();
			const secondExpense = yield* expenses.findByDocumentId(secondDocument!.document.id);
			expect(secondExpense).not.toBeNull();

			const refs = yield* expenses.referenceData;
			const input = draftInput({
				paymentAccountId: refs.paymentAccounts[0]!.id,
				lineItems: [
					{
						description: 'Team lunch',
						quantity: '1',
						unitPrice: '23.45',
						netAmount: '23.45',
						taxAmount: '',
						grossAmount: '23.45',
						categoryId: refs.categories[0]!.id
					}
				]
			});
			yield* review.approve(first.expenseId, input, actor);

			const collision = yield* Effect.result(review.approve(secondExpense!.id, input, actor));
			expect(Result.isFailure(collision)).toBe(true);
			if (Result.isFailure(collision) && 'message' in collision.failure) {
				expect(collision.failure.message).toContain('Destination already exists');
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('recovers an interrupted approval move on startup', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const review = yield* ReviewService;
			const expenses = yield* ExpenseRepository;
			const audit = yield* AuditRepository;
			const documents = yield* DocumentRepository;
			const intake = yield* intakeOneReceipt(config.directories.inbox);
			const detail = yield* expenses.detailFor(intake.expenseId);
			const document = yield* documents.findById(detail!.expense.documentId);
			expect(document).not.toBeNull();

			const refs = yield* expenses.referenceData;
			const accountName = refs.paymentAccounts[0]!.name;
			const targetRelativePath = `processed/2026-08-19 Fixture Merchant 23.45 ${accountName} team lunch.pdf`;
			yield* expenses.recordMoveIntent(intake.expenseId, {
				kind: 'approve',
				targetRelativePath
			});

			renameSync(
				join(config.dataRoot, document!.currentRelativePath),
				join(config.dataRoot, targetRelativePath)
			);

			yield* review.recoverInterrupted;

			const recovered = yield* expenses.findById(intake.expenseId);
			expect(recovered?.status).toBe('approved');
			expect(recovered?.pendingMoveJson).toBeNull();

			const events = yield* audit.listForEntity('expense', intake.expenseId);
			const recoveredEvent = events.find((event) => event.action === 'approved');
			expect(recoveredEvent?.actorLabel).toBe('system-recovery');
		}).pipe(Effect.provide(layer));
	});
});
