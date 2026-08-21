import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { AuditRepository } from './audit';
import type { ClassificationSuggestion } from './classification';
import type { NormalizedDraft } from './expenses';
import type { Actor } from './review';

const RunStatus = Schema.Literals(['running', 'succeeded', 'failed']);
const SuggestionOutcome = Schema.Literals(['pending', 'accepted', 'rejected', 'replaced']);

export type ClassificationOutcome = typeof SuggestionOutcome.Type;

export class ClassificationRun extends Schema.Class<ClassificationRun>('ClassificationRun')({
	id: Schema.String,
	expenseId: Schema.String,
	jobId: Schema.String,
	provider: Schema.String,
	model: Schema.String,
	status: RunStatus,
	inputJson: Schema.String,
	outputJson: Schema.NullOr(Schema.String),
	errorCode: Schema.NullOr(Schema.String),
	errorSummary: Schema.NullOr(Schema.String),
	startedAt: Schema.String,
	completedAt: Schema.NullOr(Schema.String)
}) {}

export interface AiSuggestionView {
	readonly id: string;
	readonly runId: string;
	readonly expenseId: string;
	readonly provider: string;
	readonly model: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly billable: boolean | null;
	readonly rationale: string;
	readonly confidence: number | null;
	readonly outcome: ClassificationOutcome;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
	readonly createdAt: string;
}

export interface ClassificationState {
	readonly run: ClassificationRun | null;
	readonly suggestion: AiSuggestionView | null;
}

export class ClassificationStateError extends Schema.TaggedError<ClassificationStateError>()(
	'ClassificationStateError',
	{ message: Schema.String }
) {}

interface SuggestionRow {
	readonly id: string;
	readonly runId: string;
	readonly expenseId: string;
	readonly provider: string;
	readonly model: string;
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly billable: number | null;
	readonly rationale: string;
	readonly confidence: number | null;
	readonly outcome: ClassificationOutcome;
	readonly paymentAccountName: string | null;
	readonly categoryName: string | null;
	readonly clientName: string | null;
	readonly createdAt: string;
}

const runColumns = `
	id, expense_id AS expenseId, job_id AS jobId, provider, model, status,
	input_json AS inputJson, output_json AS outputJson, error_code AS errorCode,
	error_summary AS errorSummary, started_at AS startedAt, completed_at AS completedAt
`;

function suggestionView(row: SuggestionRow): AiSuggestionView {
	return {
		...row,
		billable: row.billable === null ? null : row.billable === 1
	};
}

export class ClassificationRepository extends Context.Service<
	ClassificationRepository,
	{
		readonly start: (
			expenseId: string,
			jobId: string,
			provider: string,
			model: string,
			inputJson: string
		) => Effect.Effect<ClassificationRun>;
		readonly succeed: (
			runId: string,
			suggestion: ClassificationSuggestion
		) => Effect.Effect<AiSuggestionView>;
		readonly fail: (runId: string, code: string, summary: string) => Effect.Effect<void>;
		readonly recoverInterrupted: Effect.Effect<void>;
		readonly latestForExpense: (expenseId: string) => Effect.Effect<ClassificationState>;
		readonly recordOutcome: (
			expenseId: string,
			suggestionId: string,
			outcome: Exclude<ClassificationOutcome, 'pending'>,
			actor: Actor
		) => Effect.Effect<void, ClassificationStateError>;
		readonly requirePendingSuggestion: (
			expenseId: string,
			suggestionId: string
		) => Effect.Effect<void, ClassificationStateError>;
		readonly recordSubmittedOutcome: (
			expenseId: string,
			suggestionId: string,
			draft: NormalizedDraft,
			actor: Actor
		) => Effect.Effect<void, ClassificationStateError>;
	}
>()('expensifier/ClassificationRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		ClassificationRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;
			const audit = yield* AuditRepository;

			const findRun = Effect.fn('ClassificationRepository.findRun')(function* (id: string) {
				const rows = yield* sql<ClassificationRun>`
					SELECT ${sql.unsafe(runColumns)} FROM classification_runs WHERE id = ${id}
				`;
				return rows[0] ? new ClassificationRun(rows[0]) : null;
			}, Effect.orDie);

			const findSuggestion = Effect.fn('ClassificationRepository.findSuggestion')(function* (
				runId: string
			) {
				const rows = yield* sql<SuggestionRow>`
					SELECT s.id, s.run_id AS runId, s.expense_id AS expenseId,
						r.provider, r.model, s.payment_account_id AS paymentAccountId,
						s.category_id AS categoryId, s.client_id AS clientId, s.billable,
						s.rationale, s.confidence, s.outcome,
						p.name AS paymentAccountName, c.name AS categoryName, cl.name AS clientName,
						s.created_at AS createdAt
					FROM classification_suggestions s
					JOIN classification_runs r ON r.id = s.run_id
					LEFT JOIN payment_accounts p ON p.id = s.payment_account_id
					LEFT JOIN expense_categories c ON c.id = s.category_id
					LEFT JOIN clients cl ON cl.id = s.client_id
					WHERE s.run_id = ${runId}
				`;
				return rows[0] ? suggestionView(rows[0]) : null;
			}, Effect.orDie);

			const start = Effect.fn('ClassificationRepository.start')(function* (
				expenseId: string,
				jobId: string,
				provider: string,
				model: string,
				inputJson: string
			) {
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO classification_runs (
						id, expense_id, job_id, provider, model, status, input_json, started_at
					) VALUES (${id}, ${expenseId}, ${jobId}, ${provider}, ${model}, 'running', ${inputJson}, ${now})
				`;
				const run = yield* findRun(id);
				if (!run) return yield* Effect.die(new Error('Classification run was not created'));
				return run;
			}, Effect.orDie);

			const succeed = Effect.fn('ClassificationRepository.succeed')(function* (
				runId: string,
				suggestion: ClassificationSuggestion
			) {
				const run = yield* findRun(runId);
				if (!run) return yield* Effect.die(new Error('Classification run not found'));
				const id = crypto.randomUUID();
				const now = new Date().toISOString();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE classification_runs SET status = 'succeeded',
								output_json = ${JSON.stringify(suggestion)}, completed_at = ${now}
							WHERE id = ${runId}
						`;
						yield* sql`
							INSERT INTO classification_suggestions (
								id, run_id, expense_id, payment_account_id, category_id, client_id,
								billable, rationale, confidence, outcome, created_at, updated_at
							) VALUES (
								${id}, ${runId}, ${run.expenseId}, ${suggestion.paymentAccountId},
								${suggestion.categoryId}, ${suggestion.clientId},
								${suggestion.billable === null ? null : suggestion.billable ? 1 : 0},
								${suggestion.rationale}, ${suggestion.confidence}, 'pending', ${now}, ${now}
							)
							`;
						yield* audit.append({
							actorUserId: null,
							actorLabel: 'classification-system',
							action: 'classification_suggested',
							entityType: 'expense',
							entityId: run.expenseId,
							data: {
								suggestionId: id,
								provider: run.provider,
								model: run.model,
								confidence: suggestion.confidence
							}
						});
					})
				);
				const created = yield* findSuggestion(runId);
				if (!created)
					return yield* Effect.die(new Error('Classification suggestion was not created'));
				return created;
			}, Effect.orDie);

			const recoverInterrupted = Effect.gen(function* () {
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO classification_runs (
						id, expense_id, job_id, provider, model, status, input_json,
						error_code, error_summary, started_at, completed_at
					)
					SELECT 'recovered-' || j.id, j.related_entity_id, j.id, 'unknown', 'unknown',
						'failed', '{}', 'outcome_unknown',
						'Classification was interrupted before provider outcome tracking began',
						COALESCE(j.started_at, j.updated_at), ${now}
					FROM jobs j
					WHERE j.type = 'classify_expense' AND j.status = 'failed'
						AND j.error_code = 'outcome_unknown' AND j.related_entity_id IS NOT NULL
						AND NOT EXISTS (SELECT 1 FROM classification_runs r WHERE r.job_id = j.id)
				`;
				yield* sql`
					UPDATE classification_runs SET status = 'failed', error_code = 'outcome_unknown',
						error_summary = 'Classification was interrupted with an unknown provider outcome',
						completed_at = ${now}
					WHERE status = 'running' AND job_id IN (
						SELECT id FROM jobs WHERE type = 'classify_expense' AND status = 'failed'
					)
				`;
			}).pipe(Effect.orDie);

			const fail = Effect.fn('ClassificationRepository.fail')(function* (
				runId: string,
				code: string,
				summary: string
			) {
				const now = new Date().toISOString();
				yield* sql`
					UPDATE classification_runs SET status = 'failed', error_code = ${code},
						error_summary = ${summary}, completed_at = ${now} WHERE id = ${runId}
				`;
			}, Effect.orDie);

			const latestForExpense = Effect.fn('ClassificationRepository.latestForExpense')(function* (
				expenseId: string
			) {
				const rows = yield* sql<ClassificationRun>`
					SELECT ${sql.unsafe(runColumns)} FROM classification_runs
					WHERE expense_id = ${expenseId} ORDER BY started_at DESC, id DESC LIMIT 1
				`;
				const run = rows[0] ? new ClassificationRun(rows[0]) : null;
				return {
					run,
					suggestion: run?.status === 'succeeded' ? yield* findSuggestion(run.id) : null
				};
			}, Effect.orDie);

			const requirePendingSuggestion = Effect.fn(
				'ClassificationRepository.requirePendingSuggestion'
			)(function* (expenseId: string, suggestionId: string) {
				const rows = yield* sql<{ readonly outcome: ClassificationOutcome }>`
					SELECT s.outcome FROM classification_suggestions s
					JOIN classification_runs r ON r.id = s.run_id
					WHERE s.id = ${suggestionId} AND s.expense_id = ${expenseId}
						AND r.id = (
							SELECT id FROM classification_runs WHERE expense_id = ${expenseId}
							ORDER BY started_at DESC, id DESC LIMIT 1
						)
				`.pipe(Effect.orDie);
				if (rows[0]?.outcome !== 'pending') {
					return yield* Effect.fail(
						new ClassificationStateError({ message: 'Classification suggestion is not pending' })
					);
				}
			});

			const writeOutcome = Effect.fn('ClassificationRepository.writeOutcome')(function* (
				expenseId: string,
				suggestionId: string,
				outcome: Exclude<ClassificationOutcome, 'pending'>,
				actor: Actor
			) {
				const now = new Date().toISOString();
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							const updated = yield* sql<{ readonly outcome: ClassificationOutcome }>`
								UPDATE classification_suggestions SET outcome = ${outcome},
									reviewed_by = ${actor.id}, reviewed_at = ${now}, updated_at = ${now}
								WHERE id = ${suggestionId} AND expense_id = ${expenseId} AND outcome = 'pending'
									AND run_id = (
										SELECT id FROM classification_runs WHERE expense_id = ${expenseId}
										ORDER BY started_at DESC, id DESC LIMIT 1
									)
								RETURNING outcome
							`;
							if (!updated[0]) {
								const current = yield* sql<{
									readonly outcome: ClassificationOutcome;
									readonly isLatest: number;
								}>`
									SELECT s.outcome, s.run_id = (
										SELECT id FROM classification_runs WHERE expense_id = ${expenseId}
										ORDER BY started_at DESC, id DESC LIMIT 1
									) AS isLatest
									FROM classification_suggestions s
									WHERE s.id = ${suggestionId} AND s.expense_id = ${expenseId}
								`;
								if (current[0]?.isLatest === 1 && current[0].outcome === outcome) return;
								return yield* Effect.fail(
									new ClassificationStateError({
										message: !current[0]
											? 'Classification suggestion not found'
											: current[0].isLatest !== 1
												? 'Classification suggestion is no longer current'
												: 'Classification outcome is already final'
									})
								);
							}
							yield* audit.append({
								actorUserId: actor.id,
								actorLabel: actor.label,
								action: `classification_${outcome}`,
								entityType: 'expense',
								entityId: expenseId,
								data: { suggestionId, previousOutcome: 'pending' }
							});
						})
					)
					.pipe(Effect.orDie);
			});

			const recordOutcome = Effect.fn('ClassificationRepository.recordOutcome')(function* (
				expenseId: string,
				suggestionId: string,
				outcome: Exclude<ClassificationOutcome, 'pending'>,
				actor: Actor
			) {
				yield* requirePendingSuggestion(expenseId, suggestionId);
				yield* writeOutcome(expenseId, suggestionId, outcome, actor);
			});

			const recordSubmittedOutcome = Effect.fn('ClassificationRepository.recordSubmittedOutcome')(
				function* (expenseId: string, suggestionId: string, draft: NormalizedDraft, actor: Actor) {
					const rows = yield* sql<{
						readonly paymentAccountId: string | null;
						readonly categoryId: string | null;
						readonly clientId: string | null;
						readonly billable: number | null;
					}>`
					SELECT payment_account_id AS paymentAccountId, category_id AS categoryId,
						client_id AS clientId, billable
					FROM classification_suggestions s
					JOIN classification_runs r ON r.id = s.run_id
					WHERE s.id = ${suggestionId} AND s.expense_id = ${expenseId}
						AND r.id = (
							SELECT id FROM classification_runs WHERE expense_id = ${expenseId}
							ORDER BY started_at DESC, id DESC LIMIT 1
						)
				`.pipe(Effect.orDie);
					const suggestion = rows[0];
					if (!suggestion) {
						return yield* Effect.fail(
							new ClassificationStateError({ message: 'Classification suggestion not found' })
						);
					}
					const accepted =
						(suggestion.paymentAccountId === null ||
							suggestion.paymentAccountId === draft.paymentAccountId) &&
						(suggestion.clientId === null || suggestion.clientId === draft.clientId) &&
						(suggestion.billable === null || (suggestion.billable === 1) === draft.billable) &&
						(suggestion.categoryId === null ||
							(draft.lineItems.length > 0 &&
								draft.lineItems.every((item) => item.categoryId === suggestion.categoryId)));
					yield* writeOutcome(expenseId, suggestionId, accepted ? 'accepted' : 'replaced', actor);
				}
			);

			return ClassificationRepository.of({
				start,
				succeed,
				fail,
				recoverInterrupted,
				latestForExpense,
				recordOutcome,
				requirePendingSuggestion,
				recordSubmittedOutcome
			});
		})
	);
}
