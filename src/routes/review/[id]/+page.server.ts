import { AuditRepository } from '$lib/server/audit';
import { hasUsers } from '$lib/server/auth';
import { requirePermission } from '$lib/server/authorization';
import { ClassificationRepository } from '$lib/server/classification-repository';
import { DocumentRepository } from '$lib/server/documents';
import { ExpenseRepository, type ExpenseDraftInput } from '$lib/server/expenses';
import { JobService } from '$lib/server/jobs';
import { OcrRunRepository } from '$lib/server/ocr-runs';
import { ReferenceService, type ReferenceKind } from '$lib/server/reference';
import { ReviewService, validateDraft } from '$lib/server/review';
import { VendorRuleService } from '$lib/server/rules';
import { appRuntime } from '$lib/server/runtime';
import { TemplateService } from '$lib/server/templates';
import { error, fail, redirect } from '@sveltejs/kit';
import { Effect, Result, Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const LineItemPayload = Schema.Struct({
	description: Schema.String,
	quantity: Schema.String,
	unitPrice: Schema.String,
	netAmount: Schema.String,
	taxAmount: Schema.String,
	grossAmount: Schema.String,
	categoryId: Schema.String,
	clientId: Schema.NullOr(Schema.String),
	provenance: Schema.optional(Schema.Literals(['ocr', 'manual']))
});

const TaxComponentPayload = Schema.Struct({
	label: Schema.String,
	amount: Schema.String,
	ratePercent: Schema.String
});

const DraftPayload = Schema.Struct({
	vendor: Schema.String,
	transactionDate: Schema.String,
	total: Schema.String,
	currency: Schema.String,
	notes: Schema.String,
	billable: Schema.Boolean,
	clientAssignmentMode: Schema.Literals(['expense', 'line_item']),
	clientIds: Schema.Array(Schema.String),
	paymentAccountId: Schema.NullOr(Schema.String),
	lineItemsIncludeTax: Schema.Boolean,
	approveWithoutLineItems: Schema.Boolean,
	lineItems: Schema.Array(LineItemPayload),
	taxComponents: Schema.Array(TaxComponentPayload),
	classificationSuggestionId: Schema.optional(Schema.NullOr(Schema.String))
});

type ParsedDraftPayload = ExpenseDraftInput & {
	readonly classificationSuggestionId?: string | null;
};

function parseDraftPayload(value: unknown): ParsedDraftPayload | null {
	try {
		return Schema.decodeUnknownSync(DraftPayload)(value);
	} catch {
		return null;
	}
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) {
		redirect(303, hasUsers() ? '/login' : '/setup');
	}
	requirePermission(locals.user, 'expenses:view');
	if (!UUID_PATTERN.test(params.id)) error(404, 'Expense not found');

	const expense = await appRuntime.runPromise(
		ExpenseRepository.use((repository) => repository.findById(params.id))
	);
	if (!expense) error(404, 'Expense not found');

	const document = await appRuntime.runPromise(
		DocumentRepository.use((repository) => repository.findById(expense.documentId))
	);
	if (!document || document.status !== 'processing') error(404, 'Expense not found');

	const detail = await appRuntime.runPromise(
		ExpenseRepository.use((repository) => repository.detailFor(expense.id))
	);
	if (!detail) error(404, 'Expense not found');
	const refs = await appRuntime.runPromise(
		ExpenseRepository.use((repository) => repository.referenceData)
	);
	const runs = await appRuntime.runPromise(
		OcrRunRepository.use((repository) => repository.listForDocument(document.id))
	);
	const latestSuccess = runs
		.filter((run) => run.status === 'succeeded' && run.normalizedResultJson)
		.toSorted((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
	let normalizedOcr: unknown = null;
	if (latestSuccess?.normalizedResultJson) {
		try {
			normalizedOcr = JSON.parse(latestSuccess.normalizedResultJson);
		} catch {
			normalizedOcr = null;
		}
	}
	const rawOcrJson = latestSuccess?.rawResponseJson ?? null;

	const queue = await appRuntime.runPromise(
		ExpenseRepository.use((repository) => repository.reviewQueue)
	);
	const reviewableIds = queue
		.filter((entry) => entry.status === 'needs_review')
		.map((e) => e.expenseId);
	const position = reviewableIds.indexOf(expense.id);
	const previousId = position > 0 ? reviewableIds[position - 1] : null;
	const nextId =
		position >= 0 && position < reviewableIds.length - 1 ? reviewableIds[position + 1] : null;

	const events = await appRuntime.runPromise(
		AuditRepository.use((repository) => repository.listForEntity('expense', expense.id))
	);

	const duplicateOf = document.duplicateOfDocumentId
		? await appRuntime.runPromise(
				DocumentRepository.use((repository) =>
					repository.findById(document.duplicateOfDocumentId as string)
				)
			)
		: null;

	const accountName =
		refs.paymentAccounts.find((account) => account.id === detail.expense.paymentAccountId)?.name ??
		'';
	const assignedClientIds =
		detail.expense.clientAssignmentMode === 'expense'
			? detail.clientIds
			: [
					...new Set(
						detail.lineItems.map((item) => item.clientId).filter((id): id is string => id !== null)
					)
				];
	const clientName = assignedClientIds
		.map((id) => refs.clients.find((client) => client.id === id)?.name)
		.filter((name): name is string => !!name)
		.join(' + ');
	const templateValues = {
		date: detail.expense.transactionDate ?? '',
		vendor: detail.expense.vendor ?? '',
		amount:
			detail.expense.totalMinor !== null && detail.expense.totalMinor !== undefined
				? (detail.expense.totalMinor / 100).toFixed(2)
				: '',
		currency: detail.expense.currency ?? '',
		paymentAccount: accountName,
		notes: detail.expense.notes ?? '',
		billable: detail.expense.billable,
		client: clientName,
		extension: document.extension,
		expenseId: expense.id
	};
	const preview = await appRuntime.runPromise(
		Effect.gen(function* () {
			const templates = yield* TemplateService;
			const filenameResult = yield* Effect.result(templates.previewFilename(templateValues));
			const destinationResult = yield* Effect.result(templates.previewDestination(templateValues));
			return {
				filename: Result.isSuccess(filenameResult) ? filenameResult.success : '',
				destination: Result.isSuccess(destinationResult) ? destinationResult.success : ''
			};
		})
	);

	const ocrVendorName =
		normalizedOcr &&
		typeof normalizedOcr === 'object' &&
		'merchantName' in normalizedOcr &&
		normalizedOcr.merchantName &&
		typeof normalizedOcr.merchantName === 'object' &&
		'value' in normalizedOcr.merchantName &&
		typeof normalizedOcr.merchantName.value === 'string'
			? normalizedOcr.merchantName.value
			: null;
	const suggestion = await appRuntime.runPromise(
		VendorRuleService.use((service) =>
			service.suggestForVendor(detail.expense.vendor ?? ocrVendorName)
		)
	);
	const classification = suggestion
		? { run: null, suggestion: null }
		: await appRuntime.runPromise(
				ClassificationRepository.use((repository) => repository.latestForExpense(expense.id))
			);

	return {
		user: locals.user,
		document: {
			id: document.id,
			originalFilename: document.originalFilename,
			mimeType: document.mimeType,
			extension: document.extension,
			byteSize: document.byteSize,
			currentRelativePath: document.currentRelativePath,
			duplicateOfFilename: duplicateOf?.originalFilename ?? null
		},
		expense: {
			id: detail.expense.id,
			status: detail.expense.status,
			vendor: detail.expense.vendor,
			transactionDate: detail.expense.transactionDate,
			totalMinor: detail.expense.totalMinor,
			currency: detail.expense.currency,
			notes: detail.expense.notes,
			billable: detail.expense.billable,
			clientAssignmentMode: detail.expense.clientAssignmentMode,
			clientIds: detail.clientIds,
			paymentAccountId: detail.expense.paymentAccountId,
			rejectionReason: detail.expense.rejectionReason,
			reopenedAt: detail.expense.reopenedAt
		},
		lineItems: detail.lineItems.map((item) => ({
			description: item.description,
			quantity: item.quantity ?? '',
			unitPrice: item.unitPriceMinor !== null ? (item.unitPriceMinor / 100).toFixed(2) : '',
			netAmount: item.netMinor !== null ? (item.netMinor / 100).toFixed(2) : '',
			taxAmount: item.taxMinor !== null ? (item.taxMinor / 100).toFixed(2) : '',
			grossAmount: item.grossMinor !== null ? (item.grossMinor / 100).toFixed(2) : '',
			categoryId: item.categoryId ?? '',
			clientId: item.clientId,
			provenance: item.provenance
		})),
		taxComponents: detail.taxComponents.map((component) => ({
			label: component.label,
			amount: (component.amountMinor / 100).toFixed(2),
			ratePercent: component.ratePercent ?? ''
		})),
		referenceData: {
			paymentAccounts: refs.paymentAccounts.map((account) => ({
				id: account.id,
				name: account.name,
				active: account.active
			})),
			categories: refs.categories.map((category) => ({
				id: category.id,
				name: category.name,
				active: category.active
			})),
			clients: refs.clients.map((client) => ({
				id: client.id,
				name: client.name,
				active: client.active
			}))
		},
		normalizedOcr,
		rawOcrJson: rawOcrJson ? rawOcrJson.slice(0, 40_000) : null,
		ocrRunCount: runs.length,
		suggestion,
		classification: {
			run: classification.run
				? {
						id: classification.run.id,
						status: classification.run.status,
						provider: classification.run.provider,
						model: classification.run.model,
						errorCode: classification.run.errorCode,
						errorSummary: classification.run.errorSummary
					}
				: null,
			suggestion: classification.suggestion ? { ...classification.suggestion } : null
		},
		preview,
		previousId,
		nextId,
		events: events.map((event) => ({
			action: event.action,
			actorLabel: event.actorLabel,
			dataJson: event.dataJson,
			createdAt: event.createdAt
		}))
	};
};

async function draftFromRequest(request: Request): Promise<ParsedDraftPayload | null> {
	const formData = await request.formData();
	const raw = formData.get('payload');
	if (typeof raw !== 'string') return null;
	try {
		return parseDraftPayload(JSON.parse(raw));
	} catch {
		return null;
	}
}

export const actions: Actions = {
	save: async ({ locals, request, params }) => {
		const user = requirePermission(locals.user, 'expenses:edit');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const input = await draftFromRequest(request);
		if (!input) return fail(400, { message: 'Invalid form payload' });
		try {
			await appRuntime.runPromise(
				ReviewService.use((service) =>
					service.saveDraft(
						params.id as string,
						input,
						{
							id: user.id,
							label: user.email ?? user.id
						},
						input.classificationSuggestionId
					)
				)
			);
			return { message: 'Draft saved' };
		} catch (cause) {
			const failure = cause as {
				fieldErrors?: Record<string, string>;
				message?: string;
			};
			if (failure.fieldErrors) return fail(400, { fieldErrors: failure.fieldErrors });
			return fail(409, { message: failure.message ?? 'Unable to save draft' });
		}
	},

	approve: async ({ locals, request, params }) => {
		const user = requirePermission(locals.user, 'expenses:approve');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const input = await draftFromRequest(request);
		if (!input) return fail(400, { message: 'Invalid form payload' });
		try {
			const targetPath = await appRuntime.runPromise(
				ReviewService.use((service) =>
					service.approve(
						params.id as string,
						input,
						{
							id: user.id,
							label: user.email ?? user.id
						},
						input.classificationSuggestionId
					)
				)
			);
			return { approved: true, message: `Approved to ${targetPath}` };
		} catch (cause) {
			const failure = cause as {
				fieldErrors?: Record<string, string>;
				message?: string;
				code?: string;
			};
			if (failure.fieldErrors) return fail(400, { fieldErrors: failure.fieldErrors });
			if (failure.code === 'collision') {
				return fail(409, {
					message: 'A file already exists at the destination'
				});
			}
			return fail(409, {
				message: failure.message ?? 'Unable to approve expense'
			});
		}
	},

	reject: async ({ locals, request, params }) => {
		const user = requirePermission(locals.user, 'expenses:reject');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const formData = await request.formData();
		const reason = formData.get('reason');
		if (typeof reason !== 'string') return fail(400, { message: 'Rejection reason is required' });
		try {
			const targetPath = await appRuntime.runPromise(
				ReviewService.use((service) =>
					service.reject(params.id as string, reason, {
						id: user.id,
						label: user.email ?? user.id
					})
				)
			);
			return { rejected: true, message: `Rejected to ${targetPath}` };
		} catch (cause) {
			const failure = cause as { message?: string; code?: string };
			if (failure.code === 'collision') {
				return fail(409, {
					message: 'A file already exists at the destination'
				});
			}
			return fail(409, {
				message: failure.message ?? 'Unable to reject expense'
			});
		}
	},

	reopen: async ({ locals, params }) => {
		const user = requirePermission(locals.user, 'expenses:reopen');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		try {
			await appRuntime.runPromise(
				ReviewService.use((service) =>
					service.reopen(params.id as string, {
						id: user.id,
						label: user.email ?? user.id
					})
				)
			);
			return { message: 'Expense reopened for review' };
		} catch (cause) {
			const failure = cause as { message?: string };
			return fail(409, {
				message: failure.message ?? 'Unable to reopen expense'
			});
		}
	},

	'retry-ocr': async ({ locals, params }) => {
		requirePermission(locals.user, 'expenses:retry-ocr');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const expense = await appRuntime.runPromise(
			ExpenseRepository.use((repository) => repository.findById(params.id))
		);
		if (!expense) return fail(404, { message: 'Expense not found' });
		try {
			await appRuntime.runPromise(
				JobService.use((service) => service.retryOcr(expense.documentId))
			);
			return { message: 'OCR retry requested' };
		} catch {
			return fail(409, { message: 'OCR is already active or unavailable' });
		}
	},

	'retry-classification': async ({ locals, params }) => {
		requirePermission(locals.user, 'expenses:edit');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		try {
			await appRuntime.runPromise(
				JobService.use((service) => service.retryClassification(params.id as string))
			);
			return { message: 'Classification retry requested' };
		} catch {
			return fail(409, { message: 'Classification is already active or unavailable' });
		}
	},

	'create-reference': async ({ locals, params, request }) => {
		const user = requirePermission(locals.user, 'expenses:edit');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const expense = await appRuntime.runPromise(
			ExpenseRepository.use((repository) => repository.findById(params.id))
		);
		if (!expense) return fail(404, { message: 'Expense not found' });
		const form = await request.formData();
		const kindValue = form.get('kind');
		const name = form.get('name');
		if ((kindValue !== 'client' && kindValue !== 'category') || typeof name !== 'string') {
			return fail(400, { message: 'Invalid reference' });
		}
		const kind: ReferenceKind = kindValue;
		const result = await appRuntime.runPromise(
			Effect.result(
				ReferenceService.use((service) =>
					service.create(kind, name, { id: user.id, label: user.email ?? user.id })
				)
			)
		);
		if (Result.isFailure(result)) return fail(400, { message: result.failure.message });
		return {
			reference: { id: result.success.id, name: result.success.name }
		};
	},

	'suggestion-outcome': async ({ locals, params, request }) => {
		const user = requirePermission(locals.user, 'expenses:edit');
		if (!UUID_PATTERN.test(params.id)) return fail(400, { message: 'Invalid expense' });
		const form = await request.formData();
		const suggestionId = form.get('suggestionId');
		if (typeof suggestionId !== 'string') {
			return fail(400, { message: 'Invalid suggestion outcome' });
		}
		try {
			await appRuntime.runPromise(
				ClassificationRepository.use((repository) =>
					repository.recordOutcome(params.id as string, suggestionId, 'rejected', {
						id: user.id,
						label: user.email ?? user.id
					})
				)
			);
			return { message: 'Suggestion rejected' };
		} catch (cause) {
			return fail(409, {
				message: (cause as { message?: string }).message ?? 'Unable to record outcome'
			});
		}
	},

	'preview-path': async ({ locals, request }) => {
		requirePermission(locals.user, 'expenses:view');
		const input = await draftFromRequest(request);
		if (!input) return fail(400, { message: 'Invalid form payload' });
		return appRuntime.runPromise(
			Effect.gen(function* () {
				const expenses = yield* ExpenseRepository;
				const refs = yield* expenses.referenceData;
				const draftResult = yield* Effect.result(validateDraft(input, refs, false));
				if (Result.isFailure(draftResult)) {
					return fail(400, { fieldErrors: draftResult.failure.fieldErrors });
				}
				const draft = draftResult.success;
				const templates = yield* TemplateService;
				const accountName =
					refs.paymentAccounts.find((account) => account.id === draft.paymentAccountId)?.name ?? '';
				const assignedClientIds =
					draft.clientAssignmentMode === 'expense'
						? draft.clientIds
						: [
								...new Set(
									draft.lineItems
										.map((item) => item.clientId)
										.filter((id): id is string => id !== null)
								)
							];
				const clientName = assignedClientIds
					.map((id) => refs.clients.find((client) => client.id === id)?.name)
					.filter((name): name is string => !!name)
					.join(' + ');
				const documentExtension = new URL(request.url).searchParams.get('extension') ?? 'pdf';
				const values = {
					date: draft.transactionDate,
					vendor: draft.vendor,
					amount: draft.totalMinor !== null ? (draft.totalMinor / 100).toFixed(2) : '',
					currency: draft.currency,
					paymentAccount: accountName,
					notes: draft.notes,
					billable: draft.billable,
					client: clientName,
					extension: documentExtension,
					expenseId: ''
				};
				const filenameResult = yield* Effect.result(templates.previewFilename(values));
				const destinationResult = yield* Effect.result(templates.previewDestination(values));
				return {
					filename: Result.isSuccess(filenameResult)
						? filenameResult.success
						: '(unable to render)',
					destination: Result.isSuccess(destinationResult)
						? destinationResult.success
						: '(unable to render)'
				};
			})
		);
	}
};
