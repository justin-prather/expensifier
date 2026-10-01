import { extname } from 'node:path';

import {
	formatMinor,
	parseAmountToMinor,
	parseOptionalAmountToMinor,
	parseOptionalSignedAmountToMinor
} from '$lib/money';
import { Context, Effect, Layer, Result } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

import { ApprovalIntegrationService } from './approval-integration';
import { AuditRepository } from './audit';
import { ClassificationRepository, ClassificationStateError } from './classification-repository';
import { DocumentRepository } from './documents';
import {
	ExpenseRepository,
	ReviewStateError,
	ReviewValidationError,
	type ExpenseDraftInput,
	type NormalizedDraft,
	type ReferenceData
} from './expenses';
import { FileLifecycleError, FileLifecycleService } from './files';
import { TemplateService, sanitizeFilenameValue } from './templates';

export interface Actor {
	readonly id: string;
	readonly label: string;
}

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const ratePattern = /^\d{1,2}(?:\.\d{1,4})?$/;

function isValidCalendarDate(value: string): boolean {
	if (!datePattern.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function isEmptyRow(values: ReadonlyArray<string>): boolean {
	return values.every((value) => value.trim() === '');
}

export function validateDraft(
	input: ExpenseDraftInput,
	refs: ReferenceData,
	strict: boolean
): Effect.Effect<NormalizedDraft, ReviewValidationError> {
	return Effect.sync(() => {
		const fieldErrors: Record<string, string> = {};

		const vendor = input.vendor.trim();
		if (vendor.length > 200) fieldErrors.vendor = 'Vendor must be at most 200 characters';
		else if (strict && !vendor) fieldErrors.vendor = 'Vendor is required';

		const transactionDate = input.transactionDate.trim();
		if (transactionDate) {
			if (!isValidCalendarDate(transactionDate)) {
				fieldErrors.transactionDate = 'Transaction date must be a valid date (YYYY-MM-DD)';
			}
		} else if (strict) {
			fieldErrors.transactionDate = 'Transaction date is required';
		}

		let totalMinor: number | null = parseAmountToMinor(input.total);
		if (input.total.trim() === '') totalMinor = null;
		if (totalMinor === null) {
			if (strict) fieldErrors.total = 'Total amount is required';
			else if (input.total.trim() !== '') fieldErrors.total = 'Total amount is not a valid amount';
		} else if (totalMinor <= 0) {
			fieldErrors.total = 'Total amount must be greater than zero';
		}

		const currency = input.currency.trim();
		if (currency) {
			if (currency !== 'CAD' && currency !== 'USD' && currency !== 'EUR') {
				fieldErrors.currency = 'Currency must be CAD, USD, or EUR';
			}
		} else if (strict) {
			fieldErrors.currency = 'Currency is required';
		}

		const paymentAccountId = input.paymentAccountId;
		if (
			paymentAccountId &&
			!refs.paymentAccounts.some((account) => account.id === paymentAccountId)
		) {
			fieldErrors.paymentAccount = 'Unknown payment account';
		} else if (strict && !paymentAccountId) {
			fieldErrors.paymentAccount = 'Payment account is required';
		}

		const clientAssignmentMode = input.billable ? input.clientAssignmentMode : 'expense';
		const clientIds =
			input.billable && clientAssignmentMode === 'expense' ? [...new Set(input.clientIds)] : [];
		if (input.billable && clientAssignmentMode === 'expense') {
			if (strict && clientIds.length === 0) {
				fieldErrors.client = 'At least one client is required when billable';
			} else if (clientIds.some((id) => !refs.clients.some((client) => client.id === id))) {
				fieldErrors.client = 'Unknown client';
			}
		}

		const notes = input.notes.trim();
		if (notes.length > 1000) fieldErrors.notes = 'Notes must be at most 1000 characters';

		const lineItems: {
			description: string;
			quantity: string | null;
			unitPriceMinor: number | null;
			netMinor: number | null;
			taxMinor: number | null;
			grossMinor: number | null;
			categoryId: string;
			clientId: string | null;
			provenance: 'ocr' | 'manual';
		}[] = [];
		const activeLineItems = input.lineItems.filter(
			(item) =>
				!isEmptyRow([
					item.description,
					item.unitPrice,
					item.netAmount,
					item.taxAmount,
					item.grossAmount,
					input.billable && clientAssignmentMode === 'line_item' ? (item.clientId ?? '') : ''
				])
		);
		const hasAnyLineItemInput = input.lineItems.some(
			(item) =>
				!isEmptyRow([
					item.description,
					item.quantity,
					item.unitPrice,
					item.netAmount,
					item.taxAmount,
					item.grossAmount,
					item.categoryId,
					input.billable && clientAssignmentMode === 'line_item' ? (item.clientId ?? '') : ''
				])
		);
		if (
			strict &&
			activeLineItems.length === 0 &&
			(!input.approveWithoutLineItems || hasAnyLineItemInput)
		) {
			fieldErrors.lineItems = 'At least one line item is required';
		}
		for (const [index, item] of activeLineItems.entries()) {
			const prefix = `lineItems.${index}`;
			const description = item.description.trim();
			if (!description) fieldErrors[`${prefix}.description`] = 'Description is required';
			else if (description.length > 300) {
				fieldErrors[`${prefix}.description`] = 'Description must be at most 300 characters';
			}
			if (!item.categoryId) fieldErrors[`${prefix}.categoryId`] = 'Category is required';
			else if (!refs.categories.some((category) => category.id === item.categoryId)) {
				fieldErrors[`${prefix}.categoryId`] = 'Unknown category';
			}
			const clientId =
				input.billable && clientAssignmentMode === 'line_item' ? (item.clientId ?? null) : null;
			if (clientId && !refs.clients.some((client) => client.id === clientId)) {
				fieldErrors[`${prefix}.clientId`] = 'Unknown client';
			}

			const quantity = item.quantity.trim();
			if (quantity && !/^\d+(?:\.\d{1,3})?$/.test(quantity)) {
				fieldErrors[`${prefix}.quantity`] = 'Quantity must be a positive number';
			}
			const unitPriceMinor = parseOptionalSignedAmountToMinor(item.unitPrice);
			if (unitPriceMinor === null && item.unitPrice.trim() !== '') {
				fieldErrors[`${prefix}.unitPrice`] = 'Unit price is not a valid amount';
			}
			const netMinor = parseOptionalSignedAmountToMinor(item.netAmount);
			if (netMinor === null && item.netAmount.trim() !== '') {
				fieldErrors[`${prefix}.netAmount`] = 'Net amount is not a valid amount';
			}
			const taxMinor = parseOptionalSignedAmountToMinor(item.taxAmount);
			if (taxMinor === null && item.taxAmount.trim() !== '') {
				fieldErrors[`${prefix}.taxAmount`] = 'Tax amount is not a valid amount';
			}
			const grossMinor = parseOptionalSignedAmountToMinor(item.grossAmount);
			if (grossMinor === null && item.grossAmount.trim() !== '') {
				fieldErrors[`${prefix}.grossAmount`] = 'Gross amount is not a valid amount';
			}

			const effectiveGross =
				grossMinor ??
				(netMinor !== null || taxMinor !== null ? (netMinor ?? 0) + (taxMinor ?? 0) : null);
			if (strict && effectiveGross === null) {
				fieldErrors[`${prefix}.grossAmount`] = 'Enter a gross amount or net and tax amounts';
			}

			lineItems.push({
				description,
				quantity: quantity || null,
				unitPriceMinor,
				netMinor,
				taxMinor,
				grossMinor: effectiveGross,
				categoryId: item.categoryId,
				clientId,
				provenance: item.provenance === 'ocr' ? 'ocr' : 'manual'
			});
		}
		if (
			strict &&
			input.billable &&
			clientAssignmentMode === 'line_item' &&
			!lineItems.some((item) => item.clientId)
		) {
			fieldErrors.client = 'Assign at least one line item to a client';
		}

		const taxComponents: {
			label: 'GST' | 'HST' | 'PST' | 'QST' | 'OTHER';
			amountMinor: number;
			ratePercent: string | null;
		}[] = [];
		const activeTaxComponents = input.taxComponents.filter(
			(component) => !isEmptyRow([component.label, component.amount])
		);
		let taxTotal = 0;
		for (const [index, component] of activeTaxComponents.entries()) {
			const prefix = `taxComponents.${index}`;
			const label = component.label.trim();
			if (
				label !== 'GST' &&
				label !== 'HST' &&
				label !== 'PST' &&
				label !== 'QST' &&
				label !== 'OTHER'
			) {
				fieldErrors[`${prefix}.label`] = 'Choose a tax label';
				continue;
			}
			const amountMinor = parseOptionalAmountToMinor(component.amount);
			if (amountMinor === null) {
				fieldErrors[`${prefix}.amount`] = 'Tax amount is required';
				continue;
			}
			taxTotal += amountMinor;
			const ratePercent = component.ratePercent.trim();
			if (ratePercent && !ratePattern.test(ratePercent)) {
				fieldErrors[`${prefix}.ratePercent`] = 'Rate must be a percentage like 13 or 14.975';
			}
			taxComponents.push({
				label,
				amountMinor,
				ratePercent: ratePercent || null
			});
		}
		if (strict && totalMinor !== null && taxTotal > totalMinor) {
			fieldErrors.taxComponents = 'Tax components exceed the expense total';
		}

		if (
			strict &&
			activeLineItems.length > 0 &&
			totalMinor !== null &&
			Object.keys(fieldErrors).every(
				(key) => !key.startsWith('lineItems.') && !key.startsWith('taxComponents.')
			)
		) {
			const lineTotal = lineItems.reduce((total, item) => total + (item.grossMinor ?? 0), 0);
			const balancedTotal = input.lineItemsIncludeTax ? lineTotal : lineTotal + taxTotal;
			if (balancedTotal !== totalMinor) {
				const taxSuffix =
					!input.lineItemsIncludeTax && taxTotal > 0
						? ` plus separate tax ${(taxTotal / 100).toFixed(2)}`
						: '';
				fieldErrors.lineItems = `Line items total ${(lineTotal / 100).toFixed(2)}${taxSuffix} but expense total is ${(totalMinor / 100).toFixed(2)}`;
			}
		}

		if (Object.keys(fieldErrors).length > 0) {
			return Effect.fail(new ReviewValidationError({ fieldErrors }));
		}

		return Effect.succeed({
			vendor,
			transactionDate,
			totalMinor: totalMinor as number,
			currency: currency as 'CAD' | 'USD' | 'EUR',
			notes,
			billable: input.billable,
			clientAssignmentMode,
			clientIds,
			paymentAccountId: input.paymentAccountId,
			lineItems,
			taxComponents
		} satisfies NormalizedDraft);
	}).pipe(Effect.flatten);
}

export function assignedClientIds(draft: NormalizedDraft): ReadonlyArray<string> {
	return draft.clientAssignmentMode === 'expense'
		? draft.clientIds
		: [
				...new Set(
					draft.lineItems.map((item) => item.clientId).filter((id): id is string => id !== null)
				)
			];
}

function templateValuesFor(
	draft: NormalizedDraft,
	names: { readonly paymentAccount: string; readonly client: string },
	extension: string,
	expenseId: string
) {
	return {
		date: draft.transactionDate,
		vendor: draft.vendor,
		amount: draft.totalMinor !== null ? formatMinor(draft.totalMinor) : '',
		currency: draft.currency,
		paymentAccount: names.paymentAccount,
		notes: draft.notes,
		billable: draft.billable,
		client: names.client,
		extension,
		expenseId
	};
}

export class ReviewService extends Context.Service<
	ReviewService,
	{
		readonly saveDraft: (
			expenseId: string,
			input: ExpenseDraftInput,
			actor: Actor,
			classificationSuggestionId?: string | null
		) => Effect.Effect<void, ReviewValidationError | ReviewStateError | ClassificationStateError>;
		readonly approve: (
			expenseId: string,
			input: ExpenseDraftInput,
			actor: Actor,
			classificationSuggestionId?: string | null
		) => Effect.Effect<
			string,
			ReviewValidationError | ReviewStateError | FileLifecycleError | ClassificationStateError
		>;
		readonly reject: (
			expenseId: string,
			reason: string,
			actor: Actor
		) => Effect.Effect<string, ReviewStateError | FileLifecycleError>;
		readonly reopen: (expenseId: string, actor: Actor) => Effect.Effect<void, ReviewStateError>;
		readonly recoverInterrupted: Effect.Effect<void>;
	}
>()('expensifier/ReviewService') {
	static readonly layerWithoutDependencies = Layer.effect(
		ReviewService,
		Effect.gen(function* () {
			const expenses = yield* ExpenseRepository;
			const documents = yield* DocumentRepository;
			const files = yield* FileLifecycleService;
			const templates = yield* TemplateService;
			const audit = yield* AuditRepository;
			const integration = yield* ApprovalIntegrationService;
			const classifications = yield* ClassificationRepository;
			const sql = yield* SqlClient.SqlClient;

			const requireReviewable = Effect.fn('ReviewService.requireReviewable')(function* (
				expenseId: string
			) {
				const detail = yield* expenses.detailFor(expenseId);
				if (!detail || detail.expense.status !== 'needs_review') {
					return yield* Effect.fail(
						new ReviewStateError({
							message: 'Expense is not available for review'
						})
					);
				}
				const document = yield* documents.findById(detail.expense.documentId);
				if (!document || document.status !== 'processing') {
					return yield* Effect.fail(
						new ReviewStateError({
							message: 'Managed document is unavailable'
						})
					);
				}
				return { ...detail, document };
			}, Effect.orDie);

			const moveWithIntent = Effect.fn('ReviewService.moveWithIntent')(function* (
				expenseId: string,
				intent: { kind: 'approve' | 'reject'; targetRelativePath: string },
				contentHash: string,
				currentRelativePath: string,
				finalize: Effect.Effect<void>,
				failureAction: 'approve' | 'reject'
			) {
				yield* expenses.recordMoveIntent(expenseId, intent);
				const moved =
					intent.targetRelativePath === currentRelativePath
						? Effect.succeed(currentRelativePath)
						: files.moveToManagedDestination(
								currentRelativePath,
								intent.targetRelativePath,
								contentHash
							);
				const outcome = yield* Effect.result(moved);
				if (Result.isFailure(outcome)) {
					yield* expenses.clearMoveIntent(expenseId);
					yield* audit.append({
						actorUserId: null,
						actorLabel: 'system',
						action: `${failureAction}_failed`,
						entityType: 'expense',
						entityId: expenseId,
						data: { code: outcome.failure.code }
					});
					return yield* Effect.fail(outcome.failure);
				}
				yield* finalize;
			}, Effect.orDie);

			const saveDraft = Effect.fn('ReviewService.saveDraft')(function* (
				expenseId: string,
				input: ExpenseDraftInput,
				actor: Actor,
				classificationSuggestionId?: string | null
			) {
				const detail = yield* expenses.detailFor(expenseId);
				if (!detail)
					return yield* Effect.fail(new ReviewStateError({ message: 'Expense not found' }));
				const refs = yield* expenses.referenceData;
				const draft = yield* validateDraft(input, refs, false);
				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* expenses.saveDraft(expenseId, draft);
							if (classificationSuggestionId) {
								yield* classifications.recordSubmittedOutcome(
									expenseId,
									classificationSuggestionId,
									draft,
									actor
								);
							}
							yield* audit.append({
								actorUserId: actor.id,
								actorLabel: actor.label,
								action: 'reviewer_edited',
								entityType: 'expense',
								entityId: expenseId,
								data: {
									vendor: draft.vendor,
									totalMinor: draft.totalMinor,
									currency: draft.currency
								}
							});
						})
					)
					.pipe(Effect.catchTag('SqlError', Effect.die));
			});

			const approve = Effect.fn('ReviewService.approve')(function* (
				expenseId: string,
				input: ExpenseDraftInput,
				actor: Actor,
				classificationSuggestionId?: string | null
			) {
				const context = yield* requireReviewable(expenseId);
				const refs = yield* expenses.referenceData;
				const draft = yield* validateDraft(input, refs, true);

				const accountName =
					refs.paymentAccounts.find((account) => account.id === draft.paymentAccountId)?.name ?? '';
				const clientName = assignedClientIds(draft)
					.map((id) => refs.clients.find((client) => client.id === id)?.name)
					.filter((name): name is string => !!name)
					.join(' + ');
				const values = templateValuesFor(
					draft,
					{ paymentAccount: accountName, client: clientName },
					context.document.extension,
					expenseId
				);
				const filename = yield* templates.previewFilename(values);
				const destination = yield* templates.previewDestination(values);
				const targetRelativePath = `${destination}/${filename}`;

				if (
					targetRelativePath !== context.document.currentRelativePath &&
					(yield* files.managedFileExists(targetRelativePath))
				) {
					return yield* Effect.fail(
						new ReviewStateError({
							message: `Destination already exists: ${targetRelativePath}`
						})
					);
				}

				yield* sql
					.withTransaction(
						Effect.gen(function* () {
							yield* expenses.saveDraft(expenseId, draft);
							if (classificationSuggestionId) {
								yield* classifications.recordSubmittedOutcome(
									expenseId,
									classificationSuggestionId,
									draft,
									actor
								);
							}
							yield* audit.append({
								actorUserId: actor.id,
								actorLabel: actor.label,
								action: 'approval_started',
								entityType: 'expense',
								entityId: expenseId,
								data: { targetRelativePath }
							});
						})
					)
					.pipe(Effect.catchTag('SqlError', Effect.die));

				return yield* moveWithIntent(
					expenseId,
					{ kind: 'approve', targetRelativePath },
					context.document.contentHash,
					context.document.currentRelativePath,
					Effect.gen(function* () {
						yield* expenses.finalizeApproval(expenseId, {
							targetRelativePath,
							actorId: actor.id
						});
						yield* audit.append({
							actorUserId: actor.id,
							actorLabel: actor.label,
							action: 'approved',
							entityType: 'expense',
							entityId: expenseId,
							data: {
								targetRelativePath,
								totalMinor: draft.totalMinor,
								currency: draft.currency,
								lineItemsOmitted: draft.lineItems.length === 0,
								clientAssignmentMode: draft.clientAssignmentMode,
								clientIds: assignedClientIds(draft)
							}
						});
						yield* integration.notifyApproved({
							expenseId,
							documentId: context.expense.documentId,
							vendor: draft.vendor,
							transactionDate: draft.transactionDate,
							totalMinor: draft.totalMinor,
							currency: draft.currency,
							billable: draft.billable,
							clientAssignmentMode: draft.clientAssignmentMode,
							clientIds: assignedClientIds(draft),
							lineItems: draft.lineItems.map((item, position) => ({
								position,
								clientId: item.clientId
							})),
							managedPath: targetRelativePath
						});
					}),
					'approve'
				).pipe(Effect.as(targetRelativePath));
			});

			const reject = Effect.fn('ReviewService.reject')(function* (
				expenseId: string,
				reason: string,
				actor: Actor
			) {
				const trimmedReason = reason.trim();
				if (!trimmedReason) {
					return yield* Effect.fail(
						new ReviewStateError({ message: 'Rejection reason is required' })
					);
				}
				if (trimmedReason.length > 500) {
					return yield* Effect.fail(
						new ReviewStateError({
							message: 'Rejection reason must be at most 500 characters'
						})
					);
				}
				const context = yield* requireReviewable(expenseId);
				const sanitized = sanitizeFilenameValue(context.document.originalFilename);
				const filename = sanitized || `${expenseId}.${context.document.extension}`;
				const extension = extname(filename);
				const stem = extension ? filename.slice(0, -extension.length) : filename;
				const existingSuffix = /^(.*) \((\d+)\)$/.exec(stem);
				const base = existingSuffix ? existingSuffix[1] : stem;
				let suffix = existingSuffix ? Number(existingSuffix[2]) : 0;
				let targetRelativePath = `rejected/${filename}`;

				while (
					targetRelativePath !== context.document.currentRelativePath &&
					(yield* files.managedFileExists(targetRelativePath))
				) {
					suffix += 1;
					const ending = ` (${suffix})${extension}`;
					const fittedBase = Array.from(base);
					while (new TextEncoder().encode(fittedBase.join('') + ending).length > 255) {
						fittedBase.pop();
					}
					targetRelativePath = `rejected/${fittedBase.join('')}${ending}`;
				}

				yield* audit.append({
					actorUserId: actor.id,
					actorLabel: actor.label,
					action: 'rejection_started',
					entityType: 'expense',
					entityId: expenseId,
					data: { targetRelativePath }
				});

				return yield* moveWithIntent(
					expenseId,
					{ kind: 'reject', targetRelativePath },
					context.document.contentHash,
					context.document.currentRelativePath,
					Effect.gen(function* () {
						yield* expenses.finalizeRejection(expenseId, {
							targetRelativePath,
							actorId: actor.id,
							reason: trimmedReason
						});
						yield* audit.append({
							actorUserId: actor.id,
							actorLabel: actor.label,
							action: 'rejected',
							entityType: 'expense',
							entityId: expenseId,
							data: { targetRelativePath, reason: trimmedReason }
						});
					}),
					'reject'
				).pipe(Effect.as(targetRelativePath));
			});

			const reopen = Effect.fn('ReviewService.reopen')(function* (expenseId: string, actor: Actor) {
				const expense = yield* expenses.findById(expenseId);
				if (!expense) {
					return yield* Effect.fail(new ReviewStateError({ message: 'Expense not found' }));
				}
				yield* expenses.reopen(expenseId, actor.id);
				yield* audit.append({
					actorUserId: actor.id,
					actorLabel: actor.label,
					action: 'reopened',
					entityType: 'expense',
					entityId: expenseId
				});
			});

			const recoverInterrupted = Effect.gen(function* () {
				const pending = yield* expenses.pendingIntents;
				for (const { expense, intent } of pending) {
					const document = yield* documents.findById(expense.documentId);
					if (!document) {
						yield* expenses.clearMoveIntent(expense.id);
						continue;
					}
					const outcome = yield* Effect.result(
						files.moveToManagedDestination(
							document.currentRelativePath,
							intent.targetRelativePath,
							document.contentHash
						)
					);
					if (Result.isSuccess(outcome)) {
						if (intent.kind === 'approve') {
							yield* expenses.finalizeApproval(expense.id, {
								targetRelativePath: intent.targetRelativePath,
								actorId: 'system-recovery'
							});
						} else {
							yield* expenses.finalizeRejection(expense.id, {
								targetRelativePath: intent.targetRelativePath,
								actorId: 'system-recovery',
								reason: expense.rejectionReason ?? 'Rejected'
							});
						}
						yield* audit.append({
							actorUserId: null,
							actorLabel: 'system-recovery',
							action: intent.kind === 'approve' ? 'approved' : 'rejected',
							entityType: 'expense',
							entityId: expense.id,
							data: {
								recovered: true,
								targetRelativePath: intent.targetRelativePath
							}
						});
					} else {
						yield* expenses.clearMoveIntent(expense.id);
						yield* audit.append({
							actorUserId: null,
							actorLabel: 'system-recovery',
							action: 'move_interrupted',
							entityType: 'expense',
							entityId: expense.id,
							data: { code: outcome.failure.code, kind: intent.kind }
						});
					}
				}
			}).pipe(Effect.withSpan('ReviewService.recoverInterrupted'), Effect.orDie);

			return ReviewService.of({
				saveDraft,
				approve,
				reject,
				reopen,
				recoverInterrupted
			});
		})
	);
}
