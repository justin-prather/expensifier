import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
import { ReferenceService } from './reference';
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
	const referencePersistence = ReferenceService.layerWithoutDependencies.pipe(
		Layer.provideMerge(persistence)
	);
	const dependencies = Layer.mergeAll(
		persistence,
		classificationPersistence,
		referencePersistence,
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
		clientAssignmentMode: 'expense',
		clientIds: [],
		paymentAccountId: null,
		lineItemsIncludeTax: true,
		approveWithoutLineItems: false,
		lineItems: [],
		taxComponents: [],
		...overrides
	};
}

const intakeOneReceipt = (inboxPath: string, filename = 'receipt.pdf') =>
	Effect.gen(function* () {
		const intake = yield* IntakeService;
		const jobs = yield* JobService;
		const documents = yield* DocumentRepository;
		const expenses = yield* ExpenseRepository;

		writeFileSync(join(inboxPath, filename), pdfFixture);
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
	it.live('increments rejected filenames without overwriting existing files', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const review = yield* ReviewService;
			const expenses = yield* ExpenseRepository;
			const documents = yield* DocumentRepository;
			const audit = yield* AuditRepository;
			const intake = yield* intakeOneReceipt(config.directories.inbox);
			for (const name of ['receipt.pdf', 'receipt (1).pdf', 'receipt (2).pdf']) {
				writeFileSync(join(config.directories.rejected, name), `existing ${name}`);
			}

			const targetPath = yield* review.reject(intake.expenseId, 'Duplicate receipt', actor);
			expect(targetPath).toBe('rejected/receipt (3).pdf');
			expect(readFileSync(join(config.dataRoot, targetPath), 'utf8')).toBe(pdfFixture);
			for (const name of ['receipt.pdf', 'receipt (1).pdf', 'receipt (2).pdf']) {
				expect(readFileSync(join(config.directories.rejected, name), 'utf8')).toBe(
					`existing ${name}`
				);
			}
			expect((yield* expenses.findById(intake.expenseId))?.status).toBe('rejected');
			expect((yield* documents.findById(intake.documentId))?.currentRelativePath).toBe(targetPath);
			const entries = yield* audit.listForEntity('expense', intake.expenseId);
			expect(entries.some((entry) => entry.action === 'rejected')).toBe(true);
		}).pipe(Effect.provide(layer));
	});

	it.live('continues an existing numeric suffix when the original filename conflicts', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const review = yield* ReviewService;
			const intake = yield* intakeOneReceipt(config.directories.inbox, 'receipt (4).pdf');
			writeFileSync(join(config.directories.rejected, 'receipt (4).pdf'), 'existing receipt');
			const targetPath = yield* review.reject(intake.expenseId, 'Duplicate receipt', actor);
			expect(targetPath).toBe('rejected/receipt (5).pdf');
			expect(readFileSync(join(config.dataRoot, targetPath), 'utf8')).toBe(pdfFixture);
			expect(readFileSync(join(config.directories.rejected, 'receipt (4).pdf'), 'utf8')).toBe(
				'existing receipt'
			);
		}).pipe(Effect.provide(layer));
	});

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
				`processed/2026/08 August/2026-08-19 Fixture Merchant 23.45 ${accountName} team lunch.pdf`
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
						approveWithoutLineItems: true,
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

	it.live('allows approval validation without line items only when explicitly overridden', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			yield* intakeOneReceipt(config.directories.inbox);
			const refs = yield* expenses.referenceData;
			const outcome = yield* Effect.result(
				validateDraft(
					draftInput({
						paymentAccountId: refs.paymentAccounts[0]!.id,
						approveWithoutLineItems: true
					}),
					refs,
					true
				)
			);

			expect(Result.isSuccess(outcome)).toBe(true);
			if (Result.isSuccess(outcome)) expect(outcome.success.lineItems).toEqual([]);
		}).pipe(Effect.provide(layer));
	});

	it.live('persists multiple expense-level clients in selection order', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			const references = yield* ReferenceService;
			const intake = yield* intakeOneReceipt(config.directories.inbox);
			const firstClient = yield* references.create('client', 'Alpha Client', actor);
			const secondClient = yield* references.create('client', 'Beta Client', actor);
			const refs = yield* expenses.referenceData;
			const draft = yield* validateDraft(
				draftInput({
					paymentAccountId: refs.paymentAccounts[0]!.id,
					billable: true,
					clientAssignmentMode: 'expense',
					clientIds: [secondClient.id, firstClient.id],
					lineItems: [
						{
							description: 'Consulting expense',
							quantity: '1',
							unitPrice: '23.45',
							netAmount: '23.45',
							taxAmount: '',
							grossAmount: '23.45',
							categoryId: refs.categories[0]!.id,
							clientId: null
						}
					]
				}),
				refs,
				true
			);
			yield* expenses.saveDraft(intake.expenseId, draft);

			const detail = yield* expenses.detailFor(intake.expenseId);
			expect(detail?.expense.clientAssignmentMode).toBe('expense');
			expect(detail?.expense.clientId).toBeNull();
			expect(detail?.clientIds).toEqual([secondClient.id, firstClient.id]);
			expect(detail?.lineItems[0]?.clientId).toBeNull();
		}).pipe(Effect.provide(layer));
	});

	it.live('allows optional per-line clients but requires at least one assignment', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			const references = yield* ReferenceService;
			const intake = yield* intakeOneReceipt(config.directories.inbox);
			const client = yield* references.create('client', 'Line Client', actor);
			const refs = yield* expenses.referenceData;
			const lineItems = [
				{
					description: 'Assigned item',
					quantity: '1',
					unitPrice: '10.00',
					netAmount: '10.00',
					taxAmount: '',
					grossAmount: '10.00',
					categoryId: refs.categories[0]!.id,
					clientId: client.id
				},
				{
					description: 'Unassigned item',
					quantity: '1',
					unitPrice: '13.45',
					netAmount: '13.45',
					taxAmount: '',
					grossAmount: '13.45',
					categoryId: refs.categories[0]!.id,
					clientId: null
				}
			];
			const valid = yield* Effect.result(
				validateDraft(
					draftInput({
						paymentAccountId: refs.paymentAccounts[0]!.id,
						billable: true,
						clientAssignmentMode: 'line_item',
						clientIds: [],
						lineItems
					}),
					refs,
					true
				)
			);
			expect(Result.isSuccess(valid)).toBe(true);
			if (Result.isSuccess(valid)) yield* expenses.saveDraft(intake.expenseId, valid.success);
			const detail = yield* expenses.detailFor(intake.expenseId);
			expect(detail?.expense.clientAssignmentMode).toBe('line_item');
			expect(detail?.clientIds).toEqual([]);
			expect(detail?.lineItems.map((item) => item.clientId)).toEqual([client.id, null]);

			const missing = yield* Effect.result(
				validateDraft(
					draftInput({
						paymentAccountId: refs.paymentAccounts[0]!.id,
						billable: true,
						clientAssignmentMode: 'line_item',
						clientIds: [client.id],
						lineItems: lineItems.map((item) => Object.assign({}, item, { clientId: null }))
					}),
					refs,
					true
				)
			);
			expect(Result.isFailure(missing)).toBe(true);
			if (Result.isFailure(missing)) {
				expect(missing.failure.fieldErrors.client).toBe(
					'Assign at least one line item to a client'
				);
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('balances net line items with separately itemized tax', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			yield* intakeOneReceipt(config.directories.inbox);
			const refs = yield* expenses.referenceData;
			const taxExclusiveDraft = draftInput({
				paymentAccountId: refs.paymentAccounts[0]!.id,
				total: '11.30',
				lineItemsIncludeTax: false,
				lineItems: [
					{
						description: 'Taxable item',
						quantity: '1',
						unitPrice: '10.00',
						netAmount: '10.00',
						taxAmount: '',
						grossAmount: '',
						categoryId: refs.categories[0]!.id
					}
				],
				taxComponents: [{ label: 'HST', amount: '1.30', ratePercent: '13' }]
			});
			const outcome = yield* Effect.result(validateDraft(taxExclusiveDraft, refs, true));

			expect(Result.isSuccess(outcome)).toBe(true);
			if (Result.isSuccess(outcome)) {
				expect(outcome.success.lineItems[0]?.grossMinor).toBe(1000);
				expect(outcome.success.taxComponents[0]?.amountMinor).toBe(130);
			}

			const wrongTreatment = yield* Effect.result(
				validateDraft({ ...taxExclusiveDraft, lineItemsIncludeTax: true }, refs, true)
			);
			expect(Result.isFailure(wrongTreatment)).toBe(true);
			if (Result.isFailure(wrongTreatment)) {
				expect(wrongTreatment.failure.fieldErrors.lineItems).toContain(
					'Line items total 10.00 but expense total is 11.30'
				);
			}
		}).pipe(Effect.provide(layer));
	});

	it.live('balances negative line items as discounts against positive items', () => {
		const { config, layer } = makeReviewLayer();
		return Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			yield* intakeOneReceipt(config.directories.inbox);
			const refs = yield* expenses.referenceData;
			const outcome = yield* Effect.result(
				validateDraft(
					draftInput({
						paymentAccountId: refs.paymentAccounts[0]!.id,
						total: '90.00',
						lineItems: [
							{
								description: 'Service',
								quantity: '1',
								unitPrice: '100.00',
								netAmount: '100.00',
								taxAmount: '',
								grossAmount: '100.00',
								categoryId: refs.categories[0]!.id
							},
							{
								description: 'Discount',
								quantity: '1',
								unitPrice: '-10.00',
								netAmount: '-10.00',
								taxAmount: '',
								grossAmount: '-10.00',
								categoryId: refs.categories[0]!.id
							}
						]
					}),
					refs,
					true
				)
			);

			expect(Result.isSuccess(outcome)).toBe(true);
			if (Result.isSuccess(outcome)) {
				expect(outcome.success.lineItems[1]?.grossMinor).toBe(-1000);
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
			const targetRelativePath = `processed/2026/08 August/2026-08-19 Fixture Merchant 23.45 ${accountName} team lunch.pdf`;
			yield* expenses.recordMoveIntent(intake.expenseId, {
				kind: 'approve',
				targetRelativePath
			});

			mkdirSync(dirname(join(config.dataRoot, targetRelativePath)), { recursive: true });
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
