import { Context, Effect, Layer, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { DatabaseLive } from './database';

const ExpenseStatus = Schema.Literals(['processing', 'needs_review', 'approved', 'rejected']);
const Currency = Schema.Literals(['CAD', 'USD', 'EUR']);
const TaxLabel = Schema.Literals(['GST', 'HST', 'PST', 'QST', 'OTHER']);

export class Expense extends Schema.Class<Expense>('Expense')({
	id: Schema.String,
	documentId: Schema.String,
	status: ExpenseStatus,
	vendor: Schema.NullOr(Schema.String),
	transactionDate: Schema.NullOr(Schema.String),
	totalMinor: Schema.NullOr(Schema.Number),
	currency: Schema.NullOr(Currency),
	notes: Schema.NullOr(Schema.String),
	billable: Schema.Boolean,
	clientId: Schema.NullOr(Schema.String),
	clientAssignmentMode: Schema.Literals(['expense', 'line_item']),
	paymentAccountId: Schema.NullOr(Schema.String),
	rejectionReason: Schema.NullOr(Schema.String),
	pendingMoveJson: Schema.NullOr(Schema.String),
	approvedAt: Schema.NullOr(Schema.String),
	approvedBy: Schema.NullOr(Schema.String),
	rejectedAt: Schema.NullOr(Schema.String),
	rejectedBy: Schema.NullOr(Schema.String),
	reopenedAt: Schema.NullOr(Schema.String),
	reopenedBy: Schema.NullOr(Schema.String),
	createdAt: Schema.String,
	updatedAt: Schema.String
}) {}

export class LineItem extends Schema.Class<LineItem>('LineItem')({
	id: Schema.String,
	expenseId: Schema.String,
	position: Schema.Number,
	description: Schema.String,
	quantity: Schema.NullOr(Schema.String),
	unitPriceMinor: Schema.NullOr(Schema.Number),
	netMinor: Schema.NullOr(Schema.Number),
	taxMinor: Schema.NullOr(Schema.Number),
	grossMinor: Schema.NullOr(Schema.Number),
	categoryId: Schema.NullOr(Schema.String),
	clientId: Schema.NullOr(Schema.String),
	provenance: Schema.Literals(['ocr', 'manual'])
}) {}

export class TaxComponent extends Schema.Class<TaxComponent>('TaxComponent')({
	id: Schema.String,
	expenseId: Schema.String,
	label: TaxLabel,
	amountMinor: Schema.Number,
	ratePercent: Schema.NullOr(Schema.String)
}) {}

export class ReferenceRecord extends Schema.Class<ReferenceRecord>('ReferenceRecord')({
	id: Schema.String,
	name: Schema.String,
	active: Schema.Boolean
}) {}

export interface ReferenceData {
	readonly paymentAccounts: ReadonlyArray<ReferenceRecord>;
	readonly categories: ReadonlyArray<ReferenceRecord>;
	readonly clients: ReadonlyArray<ReferenceRecord>;
}

export interface LineItemInput {
	readonly description: string;
	readonly quantity: string;
	readonly unitPrice: string;
	readonly netAmount: string;
	readonly taxAmount: string;
	readonly grossAmount: string;
	readonly categoryId: string;
	readonly clientId?: string | null;
	readonly provenance?: 'ocr' | 'manual';
}

export interface TaxComponentInput {
	readonly label: string;
	readonly amount: string;
	readonly ratePercent: string;
}

export interface ExpenseDraftInput {
	readonly vendor: string;
	readonly transactionDate: string;
	readonly total: string;
	readonly currency: string;
	readonly notes: string;
	readonly billable: boolean;
	readonly clientAssignmentMode: 'expense' | 'line_item';
	readonly clientIds: ReadonlyArray<string>;
	readonly paymentAccountId: string | null;
	readonly lineItemsIncludeTax: boolean;
	readonly approveWithoutLineItems: boolean;
	readonly lineItems: ReadonlyArray<LineItemInput>;
	readonly taxComponents: ReadonlyArray<TaxComponentInput>;
}

export interface NormalizedDraft {
	readonly vendor: string;
	readonly transactionDate: string;
	readonly totalMinor: number;
	readonly currency: 'CAD' | 'USD' | 'EUR';
	readonly notes: string;
	readonly billable: boolean;
	readonly clientAssignmentMode: 'expense' | 'line_item';
	readonly clientIds: ReadonlyArray<string>;
	readonly paymentAccountId: string | null;
	readonly lineItems: ReadonlyArray<{
		readonly description: string;
		readonly quantity: string | null;
		readonly unitPriceMinor: number | null;
		readonly netMinor: number | null;
		readonly taxMinor: number | null;
		readonly grossMinor: number | null;
		readonly categoryId: string;
		readonly clientId: string | null;
		readonly provenance: 'ocr' | 'manual';
	}>;
	readonly taxComponents: ReadonlyArray<{
		readonly label: 'GST' | 'HST' | 'PST' | 'QST' | 'OTHER';
		readonly amountMinor: number;
		readonly ratePercent: string | null;
	}>;
}

export class ReviewValidationError extends Schema.TaggedError<ReviewValidationError>()(
	'ReviewValidationError',
	{ fieldErrors: Schema.Record(Schema.String, Schema.String) }
) {}

export class ReviewStateError extends Schema.TaggedError<ReviewStateError>()('ReviewStateError', {
	message: Schema.String
}) {}

interface MoveIntent {
	readonly kind: 'approve' | 'reject';
	readonly targetRelativePath: string;
}

const expenseColumns = `
	id, document_id AS documentId, status, vendor, transaction_date AS transactionDate,
	total_minor AS totalMinor, currency, notes, billable, client_id AS clientId,
	client_assignment_mode AS clientAssignmentMode,
	payment_account_id AS paymentAccountId, rejection_reason AS rejectionReason,
	pending_move_json AS pendingMoveJson, approved_at AS approvedAt, approved_by AS approvedBy,
	rejected_at AS rejectedAt, rejected_by AS rejectedBy, reopened_at AS reopenedAt,
	reopened_by AS reopenedBy, created_at AS createdAt, updated_at AS updatedAt
`;

function parseMoveIntent(json: string): MoveIntent | null {
	try {
		const parsed: unknown = JSON.parse(json);
		if (
			typeof parsed === 'object' &&
			parsed !== null &&
			'kind' in parsed &&
			'targetRelativePath' in parsed &&
			typeof parsed.targetRelativePath === 'string' &&
			(parsed.kind === 'approve' || parsed.kind === 'reject')
		) {
			return {
				kind: parsed.kind,
				targetRelativePath: parsed.targetRelativePath
			};
		}
		return null;
	} catch {
		return null;
	}
}

export class ExpenseRepository extends Context.Service<
	ExpenseRepository,
	{
		readonly ensureForDocument: (documentId: string) => Effect.Effect<Expense>;
		readonly findById: (id: string) => Effect.Effect<Expense | null>;
		readonly findByDocumentId: (documentId: string) => Effect.Effect<Expense | null>;
		readonly detailFor: (expenseId: string) => Effect.Effect<{
			readonly expense: Expense;
			readonly clientIds: ReadonlyArray<string>;
			readonly lineItems: ReadonlyArray<LineItem>;
			readonly taxComponents: ReadonlyArray<TaxComponent>;
		} | null>;
		readonly referenceData: Effect.Effect<ReferenceData>;
		readonly saveDraft: (expenseId: string, draft: NormalizedDraft) => Effect.Effect<void>;
		readonly recordMoveIntent: (expenseId: string, intent: MoveIntent) => Effect.Effect<void>;
		readonly clearMoveIntent: (expenseId: string) => Effect.Effect<void>;
		readonly pendingIntents: Effect.Effect<
			ReadonlyArray<{ readonly expense: Expense; readonly intent: MoveIntent }>
		>;
		readonly finalizeApproval: (
			expenseId: string,
			input: { readonly targetRelativePath: string; readonly actorId: string }
		) => Effect.Effect<void>;
		readonly finalizeRejection: (
			expenseId: string,
			input: {
				readonly targetRelativePath: string;
				readonly actorId: string;
				readonly reason: string;
			}
		) => Effect.Effect<void>;
		readonly reopen: (expenseId: string, actorId: string) => Effect.Effect<void, ReviewStateError>;
		readonly listSummaries: Effect.Effect<
			ReadonlyArray<{
				readonly documentId: string;
				readonly status: string;
				readonly reopenedAt: string | null;
			}>
		>;
		readonly reviewQueue: Effect.Effect<
			ReadonlyArray<{
				readonly expenseId: string;
				readonly documentId: string;
				readonly originalFilename: string;
				readonly status: string;
				readonly reopenedAt: string | null;
				readonly duplicateOfDocumentId: string | null;
			}>
		>;
		readonly reconcileSettled: Effect.Effect<number>;
	}
>()('expensifier/ExpenseRepository') {
	static readonly layerWithoutDependencies = Layer.effect(
		ExpenseRepository,
		Effect.gen(function* () {
			const sql = yield* SqlClient.SqlClient;

			const rowToExpense = (row: Expense) => new Expense({ ...row, billable: !!row.billable });

			const findById = Effect.fn('ExpenseRepository.findById')(function* (id: string) {
				const rows =
					yield* sql<Expense>`SELECT ${sql.unsafe(expenseColumns)} FROM expenses WHERE id = ${id}`;
				return rows[0] ? rowToExpense(rows[0]) : null;
			}, Effect.orDie);

			const findByDocumentId = Effect.fn('ExpenseRepository.findByDocumentId')(function* (
				documentId: string
			) {
				const rows = yield* sql<Expense>`
					SELECT ${sql.unsafe(expenseColumns)} FROM expenses WHERE document_id = ${documentId}
				`;
				return rows[0] ? rowToExpense(rows[0]) : null;
			}, Effect.orDie);

			const ensureForDocument = Effect.fn('ExpenseRepository.ensureForDocument')(function* (
				documentId: string
			) {
				const existing = yield* findByDocumentId(documentId);
				if (existing) return existing;
				const now = new Date().toISOString();
				yield* sql`
					INSERT INTO expenses (id, document_id, status, billable, created_at, updated_at)
					VALUES (${crypto.randomUUID()}, ${documentId}, 'processing', 0, ${now}, ${now})
					ON CONFLICT (document_id) DO NOTHING
				`;
				const created = yield* findByDocumentId(documentId);
				if (!created) return yield* Effect.die(new Error('Expense creation failed'));
				return created;
			}, Effect.orDie);

			const detailFor = Effect.fn('ExpenseRepository.detailFor')(function* (expenseId: string) {
				const expense = yield* findById(expenseId);
				if (!expense) return null;
				const lineItemRows = yield* sql<LineItem>`
					SELECT id, expense_id AS expenseId, position, description, quantity,
						unit_price_minor AS unitPriceMinor, net_minor AS netMinor, tax_minor AS taxMinor,
						gross_minor AS grossMinor, category_id AS categoryId, client_id AS clientId, provenance
					FROM expense_line_items WHERE expense_id = ${expenseId} ORDER BY position
				`;
				const clientRows = yield* sql<{ readonly clientId: string }>`
					SELECT client_id AS clientId FROM expense_clients
					WHERE expense_id = ${expenseId} ORDER BY position
				`;
				const taxRows = yield* sql<TaxComponent>`
					SELECT id, expense_id AS expenseId, label, amount_minor AS amountMinor,
						rate_percent AS ratePercent
					FROM expense_tax_components WHERE expense_id = ${expenseId} ORDER BY created_at
				`;
				return {
					expense,
					clientIds:
						clientRows.length > 0
							? clientRows.map((row) => row.clientId)
							: expense.clientId
								? [expense.clientId]
								: [],
					lineItems: lineItemRows.map((row) => new LineItem(row)),
					taxComponents: taxRows.map((row) => new TaxComponent(row))
				};
			}, Effect.orDie);

			const referenceData = Effect.gen(function* () {
				const mapReference = (rows: ReadonlyArray<{ id: string; name: string; active: number }>) =>
					rows.map((row) => new ReferenceRecord({ ...row, active: !!row.active }));
				const accounts = yield* sql<{
					id: string;
					name: string;
					active: number;
				}>`
					SELECT id, name, active FROM payment_accounts WHERE active = 1 ORDER BY name
				`;
				const categories = yield* sql<{
					id: string;
					name: string;
					active: number;
				}>`
					SELECT id, name, active FROM expense_categories WHERE active = 1 ORDER BY name
				`;
				const clients = yield* sql<{
					id: string;
					name: string;
					active: number;
				}>`
					SELECT id, name, active FROM clients WHERE active = 1 ORDER BY name
				`;
				return {
					paymentAccounts: mapReference(accounts),
					categories: mapReference(categories),
					clients: mapReference(clients)
				};
			}).pipe(Effect.orDie);

			const saveDraft = Effect.fn('ExpenseRepository.saveDraft')(function* (
				expenseId: string,
				draft: NormalizedDraft
			) {
				const now = new Date().toISOString();
				const legacyClientId =
					draft.clientAssignmentMode === 'expense' && draft.clientIds.length === 1
						? draft.clientIds[0]!
						: null;
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE expenses SET
								vendor = ${draft.vendor}, transaction_date = ${draft.transactionDate},
								total_minor = ${draft.totalMinor}, currency = ${draft.currency},
								notes = ${draft.notes}, billable = ${draft.billable ? 1 : 0},
								client_id = ${legacyClientId},
								client_assignment_mode = ${draft.clientAssignmentMode},
								payment_account_id = ${draft.paymentAccountId},
								updated_at = ${now}
							WHERE id = ${expenseId}
						`;
						yield* sql`DELETE FROM expense_clients WHERE expense_id = ${expenseId}`;
						for (const [position, clientId] of draft.clientIds.entries()) {
							yield* sql`
								INSERT INTO expense_clients (expense_id, client_id, position)
								VALUES (${expenseId}, ${clientId}, ${position})
							`;
						}
						yield* sql`DELETE FROM expense_line_items WHERE expense_id = ${expenseId}`;
						for (const [index, item] of draft.lineItems.entries()) {
							yield* sql`
								INSERT INTO expense_line_items (
									id, expense_id, position, description, quantity, unit_price_minor,
									net_minor, tax_minor, gross_minor, category_id, client_id, provenance,
									created_at, updated_at
								) VALUES (
									${crypto.randomUUID()}, ${expenseId}, ${index}, ${item.description},
									${item.quantity}, ${item.unitPriceMinor}, ${item.netMinor}, ${item.taxMinor},
									${item.grossMinor}, ${item.categoryId}, ${item.clientId},
									${item.provenance === 'ocr' ? 'ocr' : 'manual'}, ${now}, ${now}
								)
							`;
						}
						yield* sql`DELETE FROM expense_tax_components WHERE expense_id = ${expenseId}`;
						for (const component of draft.taxComponents) {
							yield* sql`
								INSERT INTO expense_tax_components (
									id, expense_id, label, amount_minor, rate_percent, created_at, updated_at
								) VALUES (
									${crypto.randomUUID()}, ${expenseId}, ${component.label},
									${component.amountMinor}, ${component.ratePercent}, ${now}, ${now}
								)
							`;
						}
					})
				);
			}, Effect.orDie);

			const recordMoveIntent = Effect.fn('ExpenseRepository.recordMoveIntent')(function* (
				expenseId: string,
				intent: MoveIntent
			) {
				yield* sql`
					UPDATE expenses SET pending_move_json = ${JSON.stringify(intent)}, updated_at = ${new Date().toISOString()}
					WHERE id = ${expenseId}
				`;
			}, Effect.orDie);

			const clearMoveIntent = Effect.fn('ExpenseRepository.clearMoveIntent')(function* (
				expenseId: string
			) {
				yield* sql`
					UPDATE expenses SET pending_move_json = NULL, updated_at = ${new Date().toISOString()}
					WHERE id = ${expenseId}
				`;
			}, Effect.orDie);

			const pendingIntents = Effect.gen(function* () {
				const rows = yield* sql<Expense>`
					SELECT ${sql.unsafe(expenseColumns)} FROM expenses
					WHERE pending_move_json IS NOT NULL ORDER BY updated_at
				`;
				return rows
					.map((row) => ({
						expense: rowToExpense(row),
						intent: parseMoveIntent(row.pendingMoveJson ?? '')
					}))
					.filter(
						(entry): entry is { expense: Expense; intent: MoveIntent } => entry.intent !== null
					);
			}).pipe(Effect.orDie);

			const finalizeApproval = Effect.fn('ExpenseRepository.finalizeApproval')(function* (
				expenseId: string,
				input: { targetRelativePath: string; actorId: string }
			) {
				const now = new Date().toISOString();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE documents SET current_relative_path = ${input.targetRelativePath}, updated_at = ${now}
							WHERE id = (SELECT document_id FROM expenses WHERE id = ${expenseId})
						`;
						yield* sql`
							UPDATE expenses SET status = 'approved', pending_move_json = NULL,
								approved_at = ${now}, approved_by = ${input.actorId}, updated_at = ${now}
							WHERE id = ${expenseId}
						`;
					})
				);
			}, Effect.orDie);

			const finalizeRejection = Effect.fn('ExpenseRepository.finalizeRejection')(function* (
				expenseId: string,
				input: { targetRelativePath: string; actorId: string; reason: string }
			) {
				const now = new Date().toISOString();
				yield* sql.withTransaction(
					Effect.gen(function* () {
						yield* sql`
							UPDATE documents SET current_relative_path = ${input.targetRelativePath}, updated_at = ${now}
							WHERE id = (SELECT document_id FROM expenses WHERE id = ${expenseId})
						`;
						yield* sql`
							UPDATE expenses SET status = 'rejected', pending_move_json = NULL,
								rejection_reason = ${input.reason}, rejected_at = ${now}, rejected_by = ${input.actorId},
								updated_at = ${now}
							WHERE id = ${expenseId}
						`;
					})
				);
			}, Effect.orDie);

			const reopen = Effect.fn('ExpenseRepository.reopen')(function* (
				expenseId: string,
				actorId: string
			) {
				const existing = yield* sql<{ readonly status: string }>`
					SELECT status FROM expenses WHERE id = ${expenseId}
				`.pipe(Effect.orDie);
				if (existing[0]?.status !== 'approved') {
					return yield* Effect.fail(new ReviewStateError({ message: 'Expense is not approved' }));
				}
				const now = new Date().toISOString();
				yield* sql`
					UPDATE expenses SET status = 'needs_review', reopened_at = ${now}, reopened_by = ${actorId},
						updated_at = ${now}
					WHERE id = ${expenseId} AND status = 'approved'
				`.pipe(Effect.orDie);
			});

			const listSummaries = Effect.gen(function* () {
				const rows = yield* sql<{
					documentId: string;
					status: string;
					reopenedAt: string | null;
				}>`
					SELECT document_id AS documentId, status, reopened_at AS reopenedAt FROM expenses
				`;
				return rows;
			}).pipe(Effect.orDie);

			const reviewQueue = Effect.gen(function* () {
				const rows = yield* sql<{
					expenseId: string;
					documentId: string;
					originalFilename: string;
					status: string;
					reopenedAt: string | null;
					duplicateOfDocumentId: string | null;
				}>`
					SELECT expenses.id AS expenseId, expenses.document_id AS documentId,
						documents.original_filename AS originalFilename, expenses.status,
						expenses.reopened_at AS reopenedAt,
						documents.duplicate_of_document_id AS duplicateOfDocumentId
					FROM expenses JOIN documents ON documents.id = expenses.document_id
					ORDER BY documents.created_at DESC
				`;
				return rows;
			}).pipe(Effect.orDie);

			const reconcileSettled = Effect.gen(function* () {
				const now = new Date().toISOString();
				const eligible = yield* sql<{ readonly count: number }>`
					SELECT COUNT(*) AS count FROM expenses WHERE status = 'processing' AND document_id NOT IN (
						SELECT related_entity_id FROM jobs
						WHERE type IN ('intake_document', 'ocr_document')
							AND status IN ('pending', 'running') AND related_entity_id IS NOT NULL
					)
				`;
				yield* sql`
					UPDATE expenses SET status = 'needs_review', updated_at = ${now}
					WHERE status = 'processing' AND document_id NOT IN (
						SELECT related_entity_id FROM jobs
						WHERE type IN ('intake_document', 'ocr_document')
							AND status IN ('pending', 'running') AND related_entity_id IS NOT NULL
					)
				`;
				return eligible[0]?.count ?? 0;
			}).pipe(Effect.orDie);

			return ExpenseRepository.of({
				ensureForDocument,
				findById,
				findByDocumentId,
				detailFor,
				referenceData,
				saveDraft,
				recordMoveIntent,
				clearMoveIntent,
				pendingIntents,
				finalizeApproval,
				finalizeRejection,
				reopen,
				listSummaries,
				reviewQueue,
				reconcileSettled
			});
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(Layer.provide(DatabaseLive));
}
