import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer, Result } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { AuditRepository } from './audit';
import {
	ClassificationService,
	projectStructuredOcr,
	type ClassificationFetch,
	type ClassificationRequest
} from './classification';
import { ClassificationRepository } from './classification-repository';
import { loadRuntimeConfig } from './config';
import { makeDatabaseLayer } from './database';

const request: ClassificationRequest = {
	ocr: {
		merchantName: { value: 'Fixture Market', confidence: 0.91 },
		transactionDate: { value: '2026-08-20', confidence: 0.9 },
		totalAmount: { value: '37.45', confidence: 0.99 },
		taxAmount: { value: '4.31', confidence: 0.88 },
		currencyCode: { value: 'CAD', confidence: 0.93 },
		lineItems: []
	},
	choices: {
		paymentAccounts: [{ id: 'account-1', name: 'Fixture Card' }],
		categories: [{ id: 'category-1', name: 'Office Supplies' }],
		clients: []
	},
	ruleContext: { matched: false }
};

const invalidIdFetch: ClassificationFetch = async () =>
	new Response(
		JSON.stringify({
			choices: [
				{
					message: {
						content: JSON.stringify({
							paymentAccountId: 'invented-account',
							categoryId: null,
							clientId: null,
							billable: null,
							rationale: 'Invalid fixture',
							confidence: 0.2
						})
					}
				}
			]
		})
	);

const oversizedFetch: ClassificationFetch = async () =>
	new Response(JSON.stringify({ output_text: 'response exceeds eight bytes' }));

describe('AI classification boundary', () => {
	it('projects only allow-listed normalized OCR fields', () => {
		const projected = projectStructuredOcr({
			provider: 'taggun',
			merchantName: {
				value: 'Fixture Market',
				confidence: 0.91,
				source: 'merchantName.data'
			},
			lineItems: [],
			rawResponseJson: '{"secret":"raw OCR"}',
			originalFilename: 'private-receipt.pdf',
			absolutePath: '/data/processing/private-receipt.pdf'
		});
		const serialized = JSON.stringify(projected);

		expect(projected.merchantName.value).toBe('Fixture Market');
		expect(serialized).not.toContain('source');
		expect(serialized).not.toContain('raw OCR');
		expect(serialized).not.toContain('private-receipt');
		expect(serialized).not.toContain('/data/');
	});

	it.live('uses strict structured output and sends only the classification request', () => {
		let outbound: Record<string, unknown> | null = null;
		const config = loadRuntimeConfig({
			CLASSIFICATION_API_KEY: 'fixture-key',
			CLASSIFICATION_ENDPOINT: 'https://classification.example.test/v1/chat/completions'
		});
		const fetchImplementation: ClassificationFetch = async (_input, init) => {
			outbound = JSON.parse(String(init?.body));
			return new Response(
				JSON.stringify({
					choices: [
						{
							message: {
								content: JSON.stringify({
									paymentAccountId: 'account-1',
									categoryId: 'category-1',
									clientId: null,
									billable: false,
									rationale: 'The normalized line-item evidence indicates office supplies.',
									confidence: 0.87
								})
							}
						}
					]
				}),
				{ status: 200 }
			);
		};
		return Effect.gen(function* () {
			const classifier = yield* ClassificationService;
			const suggestion = yield* classifier.classify(request);
			const messages = outbound?.messages as ReadonlyArray<{ readonly content: string }>;
			const providerInput = JSON.parse(messages[1]!.content);

			expect(suggestion.categoryId).toBe('category-1');
			expect(outbound?.model).toBe('deepseek-v4-flash');
			expect(outbound?.response_format).toEqual({ type: 'json_object' });
			expect(outbound?.thinking).toEqual({ type: 'disabled' });
			expect(outbound?.max_tokens).toBe(1000);
			expect(messages[0]?.content).toContain('Return only JSON matching this schema');
			expect(providerInput).toEqual(request);
			expect(JSON.stringify(outbound)).not.toContain('filename');
			expect(JSON.stringify(outbound)).not.toContain('rawResponse');
		}).pipe(Effect.provide(ClassificationService.layerFor(config, fetchImplementation)));
	});

	it.live('rejects provider IDs that were not supplied as candidates', () => {
		const config = loadRuntimeConfig({
			CLASSIFICATION_API_KEY: 'fixture-key',
			CLASSIFICATION_ENDPOINT: 'https://classification.example.test/v1/chat/completions'
		});
		return Effect.gen(function* () {
			const classifier = yield* ClassificationService;
			const result = yield* Effect.result(classifier.classify(request));

			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) {
				expect(result.failure.code).toBe('invalid_response');
				expect(result.failure.retryable).toBe(true);
			}
		}).pipe(Effect.provide(ClassificationService.layerFor(config, invalidIdFetch)));
	});

	it.live('stops reading provider responses at the configured byte limit', () => {
		const config = loadRuntimeConfig({
			CLASSIFICATION_API_KEY: 'fixture-key',
			CLASSIFICATION_ENDPOINT: 'https://classification.example.test/v1/chat/completions',
			CLASSIFICATION_MAX_RESPONSE_BYTES: '8'
		});
		return Effect.gen(function* () {
			const classifier = yield* ClassificationService;
			const result = yield* Effect.result(classifier.classify(request));

			expect(Result.isFailure(result)).toBe(true);
			if (Result.isFailure(result)) expect(result.failure.code).toBe('invalid_response');
		}).pipe(Effect.provide(ClassificationService.layerFor(config, oversizedFetch)));
	});
});

describe('classification persistence', () => {
	it.live('stores suggestions and records idempotent reviewer outcomes', () => {
		const persistence = AuditRepository.layerWithoutDependencies.pipe(
			Layer.provideMerge(makeDatabaseLayer(':memory:'))
		);
		const layer = ClassificationRepository.layerWithoutDependencies.pipe(
			Layer.provideMerge(persistence)
		);
		return Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const classifications = yield* ClassificationRepository;
			const audit = yield* AuditRepository;
			const now = new Date().toISOString();
			yield* sql`
				INSERT INTO documents (
					id, status, original_filename, current_relative_path, mime_type, extension,
					byte_size, content_hash, source_identity, created_at, updated_at
				) VALUES (
					'document-1', 'processing', 'fixture.pdf', 'processing/fixture.pdf',
					'application/pdf', 'pdf', 1, 'hash', 'fixture-source', ${now}, ${now}
				)
			`;
			yield* sql`
				INSERT INTO expenses (id, document_id, status, created_at, updated_at)
				VALUES ('expense-1', 'document-1', 'needs_review', ${now}, ${now})
			`;
			yield* sql`
				INSERT INTO jobs (id, type, status, attempt_count, max_attempts, created_at, updated_at)
				VALUES ('job-1', 'classify_expense', 'running', 1, 3, ${now}, ${now})
			`;
			const category = (yield* sql<{ readonly id: string }>`
					SELECT id FROM expense_categories WHERE name = 'Office Supplies'
				`)[0]!;
			const run = yield* classifications.start(
				'expense-1',
				'job-1',
				'fake',
				'fixture-v1',
				JSON.stringify(request)
			);
			const suggestion = yield* classifications.succeed(run.id, {
				paymentAccountId: null,
				categoryId: category.id,
				clientId: null,
				billable: false,
				rationale: 'Fixture rationale',
				confidence: 0.8
			});

			yield* classifications.recordSubmittedOutcome(
				'expense-1',
				suggestion.id,
				{
					vendor: 'Fixture Market',
					transactionDate: '2026-08-20',
					totalMinor: 3745,
					currency: 'CAD',
					notes: '',
					billable: false,
					clientAssignmentMode: 'expense',
					clientIds: [],
					paymentAccountId: null,
					lineItems: [
						{
							description: 'Notebooks',
							quantity: '1',
							unitPriceMinor: 3745,
							netMinor: 3745,
							taxMinor: 0,
							grossMinor: 3745,
							categoryId: category.id,
							clientId: null,
							provenance: 'manual'
						}
					],
					taxComponents: []
				},
				{ id: 'reviewer-1', label: 'Reviewer One' }
			);
			const state = yield* classifications.latestForExpense('expense-1');
			const events = yield* audit.listForEntity('expense', 'expense-1');

			expect(state.suggestion?.categoryName).toBe('Office Supplies');
			expect(state.suggestion?.outcome).toBe('accepted');
			expect(events.filter((event) => event.action === 'classification_accepted')).toHaveLength(1);
			expect(events.some((event) => event.action === 'classification_suggested')).toBe(true);
			const conflicting = yield* Effect.result(
				classifications.recordOutcome('expense-1', suggestion.id, 'rejected', {
					id: 'reviewer-1',
					label: 'Reviewer One'
				})
			);
			expect(Result.isFailure(conflicting)).toBe(true);

			yield* sql`
				INSERT INTO jobs (id, type, status, attempt_count, max_attempts, created_at, updated_at)
				VALUES ('job-2', 'classify_expense', 'failed', 1, 3, ${now}, ${now})
			`;
			const interrupted = yield* classifications.start(
				'expense-1',
				'job-2',
				'fake',
				'fixture-v1',
				JSON.stringify(request)
			);
			yield* sql`
				UPDATE classification_runs SET started_at = '2099-01-01T00:00:00.000Z'
				WHERE id = ${interrupted.id}
			`;
			yield* classifications.recoverInterrupted;
			const recovered = yield* classifications.latestForExpense('expense-1');
			expect(recovered.run?.status).toBe('failed');
			expect(recovered.run?.errorCode).toBe('outcome_unknown');
		}).pipe(Effect.provide(layer));
	});
});
