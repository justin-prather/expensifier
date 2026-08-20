import { Context, DateTime, Effect, Layer, Result, Schema } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';

import { DatabaseLive } from './database';
import { logOperationalEvent } from './logger';
import { OcrService } from './ocr';

const JobStatus = Schema.Literals(['pending', 'running', 'succeeded', 'failed']);

export class Job extends Schema.Class<Job>('Job')({
	id: Schema.String,
	type: Schema.Literals(['fake_ocr']),
	status: JobStatus,
	resultJson: Schema.NullOr(Schema.String),
	errorCode: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String
}) {}

export class JobRepository extends Context.Service<
	JobRepository,
	{
		readonly create: Effect.Effect<Job>;
		readonly list: Effect.Effect<ReadonlyArray<Job>>;
		readonly listPending: Effect.Effect<ReadonlyArray<Job>>;
		readonly markRunning: (id: string) => Effect.Effect<Job>;
		readonly complete: (id: string, resultJson: string) => Effect.Effect<Job>;
		readonly fail: (id: string, errorCode: string) => Effect.Effect<Job>;
		readonly recoverInterrupted: Effect.Effect<void>;
		readonly count: Effect.Effect<number>;
	}
>()('expensifier/JobRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		JobRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const listAll = SqlSchema.findAll({
				Request: Schema.Void,
				Result: Job,
				execute: () => sql`
					SELECT
						id,
						type,
						status,
						result_json AS resultJson,
						error_code AS errorCode,
						created_at AS createdAt,
						updated_at AS updatedAt
					FROM jobs
					ORDER BY created_at DESC
				`
			});

			const listByStatus = SqlSchema.findAll({
				Request: JobStatus,
				Result: Job,
				execute: (status) => sql`
					SELECT
						id,
						type,
						status,
						result_json AS resultJson,
						error_code AS errorCode,
						created_at AS createdAt,
						updated_at AS updatedAt
					FROM jobs
					WHERE status = ${status}
					ORDER BY created_at
				`
			});

			const findById = SqlSchema.findOne({
				Request: Schema.String,
				Result: Job,
				execute: (id) => sql`
					SELECT
						id,
						type,
						status,
						result_json AS resultJson,
						error_code AS errorCode,
						created_at AS createdAt,
						updated_at AS updatedAt
					FROM jobs
					WHERE id = ${id}
				`
			});

			const timestamp = DateTime.now.pipe(Effect.map(DateTime.formatIso));

			const create = Effect.gen(function* () {
				const now = yield* timestamp;
				const job = new Job({
					id: crypto.randomUUID(),
					type: 'fake_ocr',
					status: 'pending',
					resultJson: null,
					errorCode: null,
					createdAt: now,
					updatedAt: now
				});

				yield* sql`
					INSERT INTO jobs (id, type, status, result_json, error_code, created_at, updated_at)
					VALUES (${job.id}, ${job.type}, ${job.status}, NULL, NULL, ${job.createdAt}, ${job.updatedAt})
				`;

				return job;
			}).pipe(Effect.orDie, Effect.withSpan('JobRepository.create'));

			const updateStatus = Effect.fn('JobRepository.updateStatus')(function* (
				id: string,
				status: typeof JobStatus.Type,
				resultJson: string | null,
				errorCode: string | null
			) {
				const now = yield* timestamp;
				yield* sql`
					UPDATE jobs
					SET status = ${status}, result_json = ${resultJson}, error_code = ${errorCode}, updated_at = ${now}
					WHERE id = ${id}
				`;
				return yield* findById(id);
			}, Effect.orDie);

			const recoverInterrupted = sql`
				UPDATE jobs
				SET status = 'pending', error_code = 'interrupted', updated_at = CURRENT_TIMESTAMP
				WHERE status = 'running'
			`.pipe(Effect.asVoid, Effect.orDie, Effect.withSpan('JobRepository.recoverInterrupted'));

			const count = sql<{ readonly count: number }>`SELECT COUNT(*) AS count FROM jobs`.pipe(
				Effect.map((rows) => rows[0]?.count ?? 0),
				Effect.orDie,
				Effect.withSpan('JobRepository.count')
			);

			return JobRepository.of({
				create,
				list: listAll().pipe(Effect.orDie, Effect.withSpan('JobRepository.list')),
				listPending: listByStatus('pending').pipe(
					Effect.orDie,
					Effect.withSpan('JobRepository.listPending')
				),
				markRunning: (id) => updateStatus(id, 'running', null, null),
				complete: (id, resultJson) => updateStatus(id, 'succeeded', resultJson, null),
				fail: (id, errorCode) => updateStatus(id, 'failed', null, errorCode),
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
		readonly enqueueFakeOcr: Effect.Effect<Job>;
		readonly recoverAndProcess: Effect.Effect<ReadonlyArray<Job>>;
		readonly list: Effect.Effect<ReadonlyArray<Job>>;
		readonly health: Effect.Effect<{ readonly jobCount: number }>;
	}
>()('expensifier/JobService') {
	static readonly layerWithoutDependencies = Layer.effect(
		JobService,
		Effect.gen(function* () {
			const jobs = yield* JobRepository;
			const ocr = yield* OcrService;

			const processJob = Effect.fn('JobService.processJob')(function* (job: Job) {
				const startedAt = performance.now();
				yield* jobs.markRunning(job.id);
				logOperationalEvent('info', 'job_started', {
					component: 'jobs',
					recordId: job.id,
					jobType: job.type,
					status: 'running'
				});
				const outcome = yield* Effect.result(ocr.process(job.id));

				if (Result.isFailure(outcome)) {
					logOperationalEvent('warn', 'job_failed', {
						component: 'jobs',
						recordId: job.id,
						jobType: job.type,
						status: 'failed',
						durationMs: Math.round(performance.now() - startedAt),
						errorCode: 'fake_ocr_failed'
					});
					return yield* jobs.fail(job.id, 'fake_ocr_failed');
				}

				logOperationalEvent('info', 'job_succeeded', {
					component: 'jobs',
					recordId: job.id,
					jobType: job.type,
					status: 'succeeded',
					durationMs: Math.round(performance.now() - startedAt)
				});
				return yield* jobs.complete(job.id, JSON.stringify(outcome.success));
			});

			const enqueueFakeOcr = Effect.gen(function* () {
				const job = yield* jobs.create;
				return yield* processJob(job);
			}).pipe(Effect.withSpan('JobService.enqueueFakeOcr'));

			const recoverAndProcess = Effect.gen(function* () {
				yield* jobs.recoverInterrupted;
				const pending = yield* jobs.listPending;
				return yield* Effect.forEach(pending, processJob, { concurrency: 1 });
			}).pipe(Effect.withSpan('JobService.recoverAndProcess'));

			return JobService.of({
				enqueueFakeOcr,
				recoverAndProcess,
				list: jobs.list,
				health: jobs.count.pipe(Effect.map((jobCount) => ({ jobCount })))
			});
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(
		Layer.provide(Layer.merge(JobRepository.layer, OcrService.fakeLayer))
	);
}
