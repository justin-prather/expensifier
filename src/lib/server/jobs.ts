import { Context, Effect, Layer, Result, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { runtimeConfig } from './config';
import { DatabaseLive } from './database';
import { DocumentRepository } from './documents';
import { ExpenseRepository } from './expenses';
import { FileLifecycleService } from './files';
import { logOperationalEvent } from './logger';
import { OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';
import { VendorRuleService } from './rules';

const JobStatus = Schema.Literals(['pending', 'running', 'succeeded', 'failed']);
const JobType = Schema.Literals([
	'fake_ocr',
	'intake_document',
	'ocr_document',
	'classify_expense'
]);

export class Job extends Schema.Class<Job>('Job')({
	id: Schema.String,
	type: JobType,
	status: JobStatus,
	relatedEntityId: Schema.NullOr(Schema.String),
	resultJson: Schema.NullOr(Schema.String),
	errorCode: Schema.NullOr(Schema.String),
	errorSummary: Schema.NullOr(Schema.String),
	attemptCount: Schema.Number,
	maxAttempts: Schema.Number,
	nextAttemptAt: Schema.NullOr(Schema.String),
	startedAt: Schema.NullOr(Schema.String),
	completedAt: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String
}) {}

const jobColumns = `
	id, type, status, related_entity_id AS relatedEntityId,
	result_json AS resultJson, error_code AS errorCode, error_summary AS errorSummary,
	attempt_count AS attemptCount, max_attempts AS maxAttempts,
	next_attempt_at AS nextAttemptAt, started_at AS startedAt,
	completed_at AS completedAt, created_at AS createdAt, updated_at AS updatedAt
`;

export class JobRepository extends Context.Service<
	JobRepository,
	{
		readonly createFakeOcr: Effect.Effect<Job>;
		readonly createOcr: (documentId: string) => Effect.Effect<Job>;
		readonly createClassification: (expenseId: string) => Effect.Effect<Job>;
		readonly enqueueMissingClassifications: Effect.Effect<void>;
		readonly list: Effect.Effect<ReadonlyArray<Job>>;
		readonly claimNext: Effect.Effect<Job | null>;
		readonly complete: (id: string, resultJson?: string) => Effect.Effect<Job>;
		readonly fail: (
			job: Job,
			errorCode: string,
			errorSummary: string,
			retryable: boolean
		) => Effect.Effect<Job>;
		readonly recoverInterrupted: Effect.Effect<void>;
		readonly count: Effect.Effect<number>;
	}
>()('expensifier/JobRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		JobRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const findById = Effect.fn('JobRepository.findById')(function* (id: string) {
				const rows = yield* sql<Job>`SELECT ${sql.unsafe(jobColumns)} FROM jobs WHERE id = ${id}`;
				const row = rows[0];
				if (!row) return yield* Effect.die(new Error('Job not found after update'));
				return new Job(row);
			}, Effect.orDie);

			const createFakeOcr = Effect.gen(function* () {
				const now = new Date().toISOString();
				const id = crypto.randomUUID();
				yield* sql`
					INSERT INTO jobs (
						id, type, status, attempt_count, max_attempts, next_attempt_at, created_at, updated_at
					) VALUES (${id}, 'fake_ocr', 'pending', 0, ${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now})
				`;
				return yield* findById(id);
			}).pipe(Effect.orDie, Effect.withSpan('JobRepository.createFakeOcr'));

			const createOcr = Effect.fn('JobRepository.createOcr')(function* (documentId: string) {
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const active = yield* sql<{ readonly id: string }>`
							SELECT id FROM jobs WHERE related_entity_id = ${documentId}
								AND type = 'ocr_document' AND status IN ('pending', 'running') LIMIT 1
						`;
						if (active[0]) return yield* Effect.die(new Error('OCR is already pending'));
						const now = new Date().toISOString();
						const id = crypto.randomUUID();
						yield* sql`
							INSERT INTO jobs (
								id, type, status, related_entity_id, attempt_count, max_attempts,
								next_attempt_at, created_at, updated_at
							) VALUES (
								${id}, 'ocr_document', 'pending', ${documentId}, 0,
								${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now}
							)
						`;
						return yield* findById(id);
					})
				);
			}, Effect.orDie);

			const createClassification = Effect.fn('JobRepository.createClassification')(function* (
				expenseId: string
			) {
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const active = yield* sql<{ readonly id: string }>`
							SELECT id FROM jobs WHERE related_entity_id = ${expenseId}
								AND type = 'classify_expense' AND status IN ('pending', 'running') LIMIT 1
						`;
						if (active[0]) return yield* findById(active[0].id);
						const now = new Date().toISOString();
						const id = crypto.randomUUID();
						yield* sql`
							INSERT INTO jobs (
								id, type, status, related_entity_id, attempt_count, max_attempts,
								next_attempt_at, created_at, updated_at
							) VALUES (
								${id}, 'classify_expense', 'pending', ${expenseId}, 0,
								${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now}
							)
						`;
						return yield* findById(id);
					})
				);
			}, Effect.orDie);

			const enqueueMissingClassifications = Effect.gen(function* () {
				const now = new Date().toISOString();
				const expenses = yield* sql<{ readonly id: string }>`
					SELECT e.id FROM expenses e
					WHERE e.status = 'needs_review'
						AND EXISTS (
							SELECT 1 FROM ocr_runs o
							JOIN documents d ON d.id = o.document_id
							WHERE d.id = e.document_id AND o.status = 'succeeded'
						)
						AND NOT EXISTS (
							SELECT 1 FROM jobs j
							WHERE j.related_entity_id = e.id AND j.type = 'classify_expense'
						)
				`;
				for (const expense of expenses) {
					yield* sql`
						INSERT INTO jobs (
							id, type, status, related_entity_id, attempt_count, max_attempts,
							next_attempt_at, created_at, updated_at
						) VALUES (
							${crypto.randomUUID()}, 'classify_expense', 'pending', ${expense.id}, 0,
							${runtimeConfig.jobMaxAttempts}, ${now}, ${now}, ${now}
						)
					`;
				}
			}).pipe(Effect.orDie);

			const list = sql<Job>`
				SELECT ${sql.unsafe(jobColumns)} FROM jobs ORDER BY created_at DESC
			`.pipe(
				Effect.map((rows) => rows.map((row) => new Job(row))),
				Effect.orDie
			);

			const claimNext = Effect.gen(function* () {
				const now = new Date().toISOString();
				const rows = yield* sql<Job>`
					UPDATE jobs
					SET status = 'running', attempt_count = attempt_count + 1,
						started_at = ${now}, updated_at = ${now}, error_code = NULL, error_summary = NULL
					WHERE id = (
						SELECT id FROM jobs
						WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
						ORDER BY created_at LIMIT 1
					)
					RETURNING ${sql.unsafe(jobColumns)}
				`;
				return rows[0] ? new Job(rows[0]) : null;
			}).pipe(Effect.orDie, Effect.withSpan('JobRepository.claimNext'));

			const complete = Effect.fn('JobRepository.complete')(function* (
				id: string,
				resultJson?: string
			) {
				const now = new Date().toISOString();
				yield* sql`
					UPDATE jobs SET status = 'succeeded', result_json = ${resultJson ?? null},
						next_attempt_at = NULL, completed_at = ${now}, updated_at = ${now}
					WHERE id = ${id}
				`;
				return yield* findById(id);
			}, Effect.orDie);

			const fail = Effect.fn('JobRepository.fail')(function* (
				job: Job,
				errorCode: string,
				errorSummary: string,
				retryable: boolean
			) {
				const now = new Date();
				const willRetry = retryable && job.attemptCount < job.maxAttempts;
				const nextAttemptAt = willRetry
					? new Date(
							now.getTime() + Math.min(60_000, 1000 * 2 ** (job.attemptCount - 1))
						).toISOString()
					: null;
				yield* sql`
					UPDATE jobs SET status = ${willRetry ? 'pending' : 'failed'},
						error_code = ${errorCode}, error_summary = ${errorSummary},
						next_attempt_at = ${nextAttemptAt}, completed_at = ${willRetry ? null : now.toISOString()},
						updated_at = ${now.toISOString()}
					WHERE id = ${job.id}
				`;
				return yield* findById(job.id);
			}, Effect.orDie);

			const recoverInterrupted = Effect.gen(function* () {
				const now = new Date().toISOString();
				yield* sql`
					UPDATE jobs SET status = 'pending', error_code = 'interrupted',
						error_summary = 'Work was interrupted and will resume', next_attempt_at = ${now},
						updated_at = ${now}
					WHERE status = 'running' AND type NOT IN ('ocr_document', 'classify_expense')
						AND attempt_count < max_attempts
				`;
				yield* sql`
					UPDATE jobs SET status = 'failed',
							error_code = CASE WHEN type IN ('ocr_document', 'classify_expense') THEN 'outcome_unknown' ELSE 'interrupted' END,
						error_summary = CASE
								WHEN type = 'ocr_document' THEN 'OCR was interrupted with an unknown provider outcome'
								WHEN type = 'classify_expense' THEN 'Classification was interrupted with an unknown provider outcome'
							ELSE 'Work was interrupted at the attempt limit'
						END,
						next_attempt_at = NULL,
						completed_at = ${now}, updated_at = ${now}
					WHERE status = 'running'
						AND (type IN ('ocr_document', 'classify_expense') OR attempt_count >= max_attempts)
				`;
			}).pipe(Effect.orDie, Effect.withSpan('JobRepository.recoverInterrupted'));

			const count = sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM jobs`.pipe(
				Effect.map((rows) => rows[0]?.count ?? 0),
				Effect.orDie
			);

			return JobRepository.of({
				createFakeOcr,
				createOcr,
				createClassification,
				enqueueMissingClassifications,
				list,
				claimNext,
				complete,
				fail,
				recoverInterrupted,
				count
			});
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(DatabaseLive));
}

export class JobService extends Context.Service<
	JobService,
	{
		readonly start: Effect.Effect<void>;
		readonly enqueueFakeOcr: Effect.Effect<Job>;
		readonly retryOcr: (documentId: string) => Effect.Effect<Job>;
		readonly retryClassification: (expenseId: string) => Effect.Effect<Job>;
		readonly recoverAndProcess: Effect.Effect<void>;
		readonly processAvailable: Effect.Effect<void>;
		readonly list: Effect.Effect<ReadonlyArray<Job>>;
		readonly health: Effect.Effect<{ readonly jobCount: number; readonly started: boolean }>;
	}
>()('expensifier/JobService') {
	static readonly layerWithoutDependencies = Layer.effect(
		JobService,
		Effect.gen(function* () {
			const jobs = yield* JobRepository;
			const documents = yield* DocumentRepository;
			const files = yield* FileLifecycleService;
			const ocr = yield* OcrService;
			const ocrRuns = yield* OcrRunRepository;
			const expenses = yield* ExpenseRepository;
			const rules = yield* VendorRuleService;
			const classifier = yield* ClassificationService;
			const classifications = yield* ClassificationRepository;
			const sql = yield* SqlClient.SqlClient;
			let timer: ReturnType<typeof setInterval> | undefined;
			let processing = false;

			const processJob = Effect.fn('JobService.processJob')(function* (job: Job) {
				const startedAt = performance.now();
				logOperationalEvent('info', 'job_started', {
					component: 'jobs',
					recordId: job.id,
					jobType: job.type,
					status: 'running',
					attemptCount: job.attemptCount
				});

				if (job.type === 'intake_document') {
					const document = job.relatedEntityId
						? yield* documents.findById(job.relatedEntityId)
						: null;
					if (!document) {
						const updated = yield* jobs.fail(
							job,
							'document_missing',
							'Related document was not found',
							false
						);
						logOperationalEvent('warn', 'job_failed', {
							component: 'jobs',
							recordId: job.id,
							jobType: job.type,
							status: updated.status,
							attemptCount: job.attemptCount,
							errorCode: 'document_missing'
						});
						return;
					}
					const moved = yield* Effect.result(files.moveToProcessing(document));
					if (Result.isFailure(moved)) {
						const updated = yield* jobs.fail(
							job,
							moved.failure.code,
							'Managed file move did not complete',
							moved.failure.retryable
						);
						if (updated.status === 'failed') yield* documents.markFailed(document.id);
						logOperationalEvent('warn', 'job_failed', {
							component: 'jobs',
							recordId: job.id,
							jobType: job.type,
							status: updated.status,
							attemptCount: job.attemptCount,
							errorCode: moved.failure.code
						});
						return;
					}
					yield* documents.markManaged(document.id, moved.success);
					yield* expenses.ensureForDocument(document.id);
					yield* jobs.complete(job.id);
				} else if (job.type === 'ocr_document') {
					const document = job.relatedEntityId
						? yield* documents.findById(job.relatedEntityId)
						: null;
					if (!document) {
						yield* jobs.fail(job, 'document_missing', 'Related document was not found', false);
						return;
					}
					const run = yield* ocrRuns.start(document.id, job.id, ocr.provider, ocr.providerVersion);
					const outcome = yield* Effect.result(
						ocr.process({
							id: document.id,
							absolutePath: files.absolutePath(document),
							mimeType: document.mimeType,
							originalFilename: document.originalFilename,
							byteSize: document.byteSize,
							contentHash: document.contentHash
						})
					);
					if (Result.isFailure(outcome)) {
						const updatedStatus = yield* ocrRuns.fail(
							run.id,
							job,
							outcome.failure.code,
							outcome.failure.summary,
							outcome.failure.rawResponseJson,
							outcome.failure.retryable
						);
						yield* expenses.reconcileSettled;
						logOperationalEvent('warn', 'job_failed', {
							component: 'jobs',
							recordId: job.id,
							jobType: job.type,
							status: updatedStatus,
							attemptCount: job.attemptCount,
							errorCode: outcome.failure.code
						});
						return;
					}
					const normalizedJson = JSON.stringify(outcome.success.normalized);
					yield* ocrRuns.succeed(run.id, job.id, outcome.success.rawResponseJson, normalizedJson);
					yield* expenses.reconcileSettled;
					const expense = yield* expenses.findByDocumentId(document.id);
					if (expense) yield* jobs.createClassification(expense.id);
				} else if (job.type === 'classify_expense') {
					const expense = job.relatedEntityId
						? yield* expenses.findById(job.relatedEntityId)
						: null;
					if (!expense) {
						yield* jobs.fail(job, 'expense_missing', 'Related expense was not found', false);
						return;
					}
					if (expense.status !== 'needs_review') {
						yield* jobs.complete(job.id, JSON.stringify({ skipped: 'expense_finalized' }));
						return;
					}
					const runs = yield* ocrRuns.listForDocument(expense.documentId);
					const latest = runs
						.filter((run) => run.status === 'succeeded' && run.normalizedResultJson)
						.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
					if (!latest?.normalizedResultJson) {
						yield* jobs.fail(job, 'ocr_missing', 'Structured OCR data was not found', false);
						return;
					}
					let normalized: unknown;
					try {
						normalized = JSON.parse(latest.normalizedResultJson);
					} catch {
						yield* jobs.fail(job, 'ocr_invalid', 'Structured OCR data was invalid', false);
						return;
					}
					const structuredOcr = projectStructuredOcr(normalized);
					const rule = yield* rules.suggestForVendor(structuredOcr.merchantName.value);
					if (rule) {
						yield* jobs.complete(job.id, JSON.stringify({ skipped: 'deterministic_rule' }));
						return;
					}
					const refs = yield* expenses.referenceData;
					const request: ClassificationRequest = {
						ocr: structuredOcr,
						choices: {
							paymentAccounts: refs.paymentAccounts
								.filter((choice) => choice.active)
								.map(({ id, name }) => ({ id, name })),
							categories: refs.categories
								.filter((choice) => choice.active)
								.map(({ id, name }) => ({ id, name })),
							clients: refs.clients
								.filter((choice) => choice.active)
								.map(({ id, name }) => ({ id, name }))
						},
						ruleContext: { matched: false }
					};
					const classificationRun = yield* classifications.start(
						expense.id,
						job.id,
						classifier.provider,
						classifier.model,
						JSON.stringify(request)
					);
					const result = yield* Effect.result(classifier.classify(request));
					if (Result.isFailure(result)) {
						yield* sql
							.withTransaction(
								Effect.gen(function* () {
									yield* classifications.fail(
										classificationRun.id,
										result.failure.code,
										result.failure.summary
									);
									yield* jobs.fail(
										job,
										result.failure.code,
										result.failure.summary,
										result.failure.retryable
									);
								})
							)
							.pipe(Effect.orDie);
						return;
					}
					yield* sql
						.withTransaction(
							Effect.gen(function* () {
								const current = yield* expenses.findById(expense.id);
								if (current?.status !== 'needs_review') {
									yield* classifications.fail(
										classificationRun.id,
										'expense_finalized',
										'Expense review finished before classification completed'
									);
									yield* jobs.complete(job.id, JSON.stringify({ skipped: 'expense_finalized' }));
									return;
								}
								const suggestion = yield* classifications.succeed(
									classificationRun.id,
									result.success
								);
								yield* jobs.complete(job.id, JSON.stringify({ suggestionId: suggestion.id }));
							})
						)
						.pipe(Effect.orDie);
				} else {
					yield* jobs.complete(job.id);
				}

				logOperationalEvent('info', 'job_succeeded', {
					component: 'jobs',
					recordId: job.id,
					jobType: job.type,
					status: 'succeeded',
					attemptCount: job.attemptCount,
					durationMs: Math.round(performance.now() - startedAt)
				});
			});

			const processAvailable = Effect.gen(function* () {
				if (processing) return;
				processing = true;
				try {
					let job = yield* jobs.claimNext;
					while (job) {
						yield* processJob(job);
						job = yield* jobs.claimNext;
					}
				} finally {
					processing = false;
				}
			}).pipe(Effect.withSpan('JobService.processAvailable'));

			const start = Effect.sync(() => {
				if (timer) return;
				timer = setInterval(
					() => Effect.runFork(processAvailable),
					runtimeConfig.jobPollIntervalMilliseconds
				);
			});

			yield* Effect.addFinalizer(() =>
				Effect.sync(() => {
					if (timer) clearInterval(timer);
					timer = undefined;
				})
			);

			return JobService.of({
				start,
				enqueueFakeOcr: Effect.gen(function* () {
					const job = yield* jobs.createFakeOcr;
					yield* processAvailable;
					return (yield* jobs.list).find((candidate) => candidate.id === job.id) ?? job;
				}),
				retryOcr: (documentId) =>
					Effect.gen(function* () {
						const document = yield* documents.findById(documentId);
						if (!document || document.status !== 'processing') {
							return yield* Effect.die(new Error('Document is not available for OCR'));
						}
						const job = yield* jobs.createOcr(documentId);
						yield* processAvailable;
						return job;
					}),
				retryClassification: (expenseId) =>
					Effect.gen(function* () {
						const expense = yield* expenses.findById(expenseId);
						if (!expense || expense.status !== 'needs_review') {
							return yield* Effect.die(new Error('Expense is not available for classification'));
						}
						const state = yield* classifications.latestForExpense(expenseId);
						if (state.run?.status !== 'failed') {
							return yield* Effect.die(
								new Error('Expense does not have a failed classification to retry')
							);
						}
						const job = yield* jobs.createClassification(expenseId);
						yield* processAvailable;
						return job;
					}),
				recoverAndProcess: Effect.gen(function* () {
					yield* ocrRuns.recoverInterrupted;
					yield* jobs.recoverInterrupted;
					yield* classifications.recoverInterrupted;
					yield* expenses.reconcileSettled;
					yield* jobs.enqueueMissingClassifications;
					yield* processAvailable;
				}),
				processAvailable,
				list: jobs.list,
				health: jobs.count.pipe(Effect.map((jobCount) => ({ jobCount, started: !!timer })))
			});
		})
	);
}
import {
	ClassificationService,
	projectStructuredOcr,
	type ClassificationRequest
} from './classification';
import { ClassificationRepository } from './classification-repository';
