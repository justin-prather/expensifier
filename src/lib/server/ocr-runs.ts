import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { DatabaseLive } from './database';

const OcrRunStatus = Schema.Literals(['running', 'succeeded', 'failed']);

export class OcrRun extends Schema.Class<OcrRun>('OcrRun')({
	id: Schema.String,
	documentId: Schema.String,
	jobId: Schema.String,
	provider: Schema.String,
	providerVersion: Schema.String,
	attemptNumber: Schema.Number,
	status: OcrRunStatus,
	rawResponseJson: Schema.NullOr(Schema.String),
	normalizedResultJson: Schema.NullOr(Schema.String),
	errorCode: Schema.NullOr(Schema.String),
	errorSummary: Schema.NullOr(Schema.String),
	startedAt: Schema.String,
	completedAt: Schema.NullOr(Schema.String)
}) {}

const columns = `
	id, document_id AS documentId, job_id AS jobId, provider,
	provider_version AS providerVersion, attempt_number AS attemptNumber, status,
	raw_response_json AS rawResponseJson, normalized_result_json AS normalizedResultJson,
	error_code AS errorCode, error_summary AS errorSummary,
	started_at AS startedAt, completed_at AS completedAt
`;

export class OcrRunRepository extends Context.Service<
	OcrRunRepository,
	{
		readonly start: (
			documentId: string,
			jobId: string,
			provider: string,
			providerVersion: string
		) => Effect.Effect<OcrRun>;
		readonly succeed: (
			id: string,
			jobId: string,
			rawResponseJson: string,
			normalizedResultJson: string
		) => Effect.Effect<void>;
		readonly fail: (
			id: string,
			job: { readonly id: string; readonly attemptCount: number; readonly maxAttempts: number },
			errorCode: string,
			errorSummary: string,
			rawResponseJson: string | null,
			retryable: boolean
		) => Effect.Effect<'pending' | 'failed'>;
		readonly recoverInterrupted: Effect.Effect<void>;
		readonly listForDocument: (documentId: string) => Effect.Effect<ReadonlyArray<OcrRun>>;
	}
>()('expensifier/OcrRunRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		OcrRunRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const start = Effect.fn('OcrRunRepository.start')(function* (
				documentId: string,
				jobId: string,
				provider: string,
				providerVersion: string
			) {
				return yield* sql.withTransaction(
					Effect.gen(function* () {
						const prior = yield* sql<{ readonly attemptNumber: number }>`
							SELECT COALESCE(MAX(attempt_number), 0) AS attemptNumber
							FROM ocr_runs WHERE document_id = ${documentId}
						`;
						const run = new OcrRun({
							id: crypto.randomUUID(),
							documentId,
							jobId,
							provider,
							providerVersion,
							attemptNumber: (prior[0]?.attemptNumber ?? 0) + 1,
							status: 'running',
							rawResponseJson: null,
							normalizedResultJson: null,
							errorCode: null,
							errorSummary: null,
							startedAt: new Date().toISOString(),
							completedAt: null
						});
						yield* sql`
							INSERT INTO ocr_runs (
								id, document_id, job_id, provider, provider_version,
								attempt_number, status, started_at
							) VALUES (
								${run.id}, ${run.documentId}, ${run.jobId}, ${run.provider},
								${run.providerVersion}, ${run.attemptNumber}, ${run.status}, ${run.startedAt}
							)
						`;
						return run;
					})
				);
			}, Effect.orDie);

			const succeed = Effect.fn('OcrRunRepository.succeed')(function* (
				id: string,
				jobId: string,
				rawResponseJson: string,
				normalizedResultJson: string
			) {
				const now = new Date().toISOString();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE ocr_runs SET status = 'succeeded', raw_response_json = ${rawResponseJson},
								normalized_result_json = ${normalizedResultJson}, completed_at = ${now}
							WHERE id = ${id}
						`;
						yield* sql`
							UPDATE jobs SET status = 'succeeded', result_json = ${normalizedResultJson},
								next_attempt_at = NULL, completed_at = ${now}, updated_at = ${now}
							WHERE id = ${jobId}
						`;
					})
				);
			}, Effect.orDie);

			const fail = Effect.fn('OcrRunRepository.fail')(function* (
				id: string,
				job: { readonly id: string; readonly attemptCount: number; readonly maxAttempts: number },
				errorCode: string,
				errorSummary: string,
				rawResponseJson: string | null,
				retryable: boolean
			) {
				const now = new Date();
				const willRetry = retryable && job.attemptCount < job.maxAttempts;
				const nextAttemptAt = willRetry
					? new Date(
							now.getTime() + Math.min(60_000, 1000 * 2 ** (job.attemptCount - 1))
						).toISOString()
					: null;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE ocr_runs SET status = 'failed', raw_response_json = ${rawResponseJson},
								error_code = ${errorCode}, error_summary = ${errorSummary},
								completed_at = ${now.toISOString()}
							WHERE id = ${id}
						`;
						yield* sql`
							UPDATE jobs SET status = ${willRetry ? 'pending' : 'failed'},
								error_code = ${errorCode}, error_summary = ${errorSummary},
								next_attempt_at = ${nextAttemptAt}, completed_at = ${willRetry ? null : now.toISOString()},
								updated_at = ${now.toISOString()}
							WHERE id = ${job.id}
						`;
					})
				);
				return willRetry ? 'pending' : 'failed';
			}, Effect.orDie);

			const listForDocument = Effect.fn('OcrRunRepository.listForDocument')(function* (
				documentId: string
			) {
				const rows = yield* sql<OcrRun>`
					SELECT ${sql.unsafe(columns)} FROM ocr_runs
					WHERE document_id = ${documentId} ORDER BY started_at
				`;
				return rows.map((row) => new OcrRun(row));
			}, Effect.orDie);

			const recoverInterrupted = Effect.gen(function* () {
				yield* sql`
					UPDATE ocr_runs SET status = 'failed', error_code = 'outcome_unknown',
						error_summary = 'OCR was interrupted with an unknown provider outcome',
						completed_at = ${new Date().toISOString()}
					WHERE status = 'running'
				`;
			}).pipe(Effect.orDie);

			return OcrRunRepository.of({ start, succeed, fail, recoverInterrupted, listForDocument });
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(DatabaseLive));
}
