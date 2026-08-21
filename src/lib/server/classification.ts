import { Context, Effect, Layer, Schema } from 'effect';

import { runtimeConfig, type RuntimeConfig } from './config';

export interface ClassificationField {
	readonly value: string | null;
	readonly confidence: number | null;
}

export interface ClassificationLineItem {
	readonly description: ClassificationField;
	readonly quantity: ClassificationField;
	readonly unitPrice: ClassificationField;
	readonly netAmount: ClassificationField;
	readonly taxAmount: ClassificationField;
	readonly grossAmount: ClassificationField;
}

export interface StructuredOcrInput {
	readonly merchantName: ClassificationField;
	readonly transactionDate: ClassificationField;
	readonly totalAmount: ClassificationField;
	readonly taxAmount: ClassificationField;
	readonly currencyCode: ClassificationField;
	readonly lineItems: ReadonlyArray<ClassificationLineItem>;
}

export interface ClassificationChoice {
	readonly id: string;
	readonly name: string;
}

export interface ClassificationRequest {
	readonly ocr: StructuredOcrInput;
	readonly choices: {
		readonly paymentAccounts: ReadonlyArray<ClassificationChoice>;
		readonly categories: ReadonlyArray<ClassificationChoice>;
		readonly clients: ReadonlyArray<ClassificationChoice>;
	};
	readonly ruleContext: { readonly matched: false };
}

export interface ClassificationSuggestion {
	readonly paymentAccountId: string | null;
	readonly categoryId: string | null;
	readonly clientId: string | null;
	readonly billable: boolean | null;
	readonly rationale: string;
	readonly confidence: number | null;
}

export type ClassificationFetch = (
	input: string | URL | Request,
	init?: RequestInit
) => Promise<Response>;

export class ClassificationError extends Schema.TaggedError<ClassificationError>()(
	'ClassificationError',
	{
		code: Schema.String,
		summary: Schema.String,
		retryable: Schema.Boolean
	}
) {}

function record(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function field(value: unknown): ClassificationField {
	const candidate = record(value);
	return {
		value: typeof candidate.value === 'string' ? candidate.value : null,
		confidence: typeof candidate.confidence === 'number' ? candidate.confidence : null
	};
}

export function projectStructuredOcr(value: unknown): StructuredOcrInput {
	const root = record(value);
	const items = Array.isArray(root.lineItems) ? root.lineItems : [];
	return {
		merchantName: field(root.merchantName),
		transactionDate: field(root.transactionDate),
		totalAmount: field(root.totalAmount),
		taxAmount: field(root.taxAmount),
		currencyCode: field(root.currencyCode),
		lineItems: items.slice(0, 100).map((item) => {
			const row = record(item);
			return {
				description: field(row.description),
				quantity: field(row.quantity),
				unitPrice: field(row.unitPrice),
				netAmount: field(row.netAmount),
				taxAmount: field(row.taxAmount),
				grossAmount: field(row.grossAmount)
			};
		})
	};
}

function parseSuggestion(
	value: unknown,
	request: ClassificationRequest
): ClassificationSuggestion | null {
	const candidate = record(value);
	const nullableId = (key: string, choices: ReadonlyArray<ClassificationChoice>) => {
		const id = candidate[key];
		if (id === null) return null;
		return typeof id === 'string' && choices.some((choice) => choice.id === id) ? id : undefined;
	};
	const paymentAccountId = nullableId('paymentAccountId', request.choices.paymentAccounts);
	const categoryId = nullableId('categoryId', request.choices.categories);
	const clientId = nullableId('clientId', request.choices.clients);
	const billable = candidate.billable;
	const rationale = candidate.rationale;
	const confidence = candidate.confidence;
	if (
		paymentAccountId === undefined ||
		categoryId === undefined ||
		clientId === undefined ||
		(billable !== null && typeof billable !== 'boolean') ||
		typeof rationale !== 'string' ||
		rationale.trim().length === 0 ||
		rationale.length > 500 ||
		(confidence !== null && (typeof confidence !== 'number' || confidence < 0 || confidence > 1))
	) {
		return null;
	}
	return {
		paymentAccountId,
		categoryId,
		clientId,
		billable,
		rationale: rationale.trim(),
		confidence
	};
}

function outputText(value: unknown): string | null {
	const root = record(value);
	if (typeof root.output_text === 'string') return root.output_text;
	if (!Array.isArray(root.output)) return null;
	for (const output of root.output) {
		const content = record(output).content;
		if (!Array.isArray(content)) continue;
		for (const part of content) {
			const text = record(part).text;
			if (typeof text === 'string') return text;
		}
	}
	return null;
}

async function readBoundedResponse(response: Response, maximumBytes: number): Promise<string> {
	const declaredLength = Number(response.headers.get('content-length'));
	if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
		throw new Error('response_too_large');
	}
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Array<Uint8Array> = [];
	let byteLength = 0;
	while (true) {
		// oxlint-disable-next-line no-await-in-loop -- response stream reads are sequential.
		const chunk = await reader.read();
		if (chunk.done) break;
		byteLength += chunk.value.byteLength;
		if (byteLength > maximumBytes) {
			// oxlint-disable-next-line no-await-in-loop -- cancel before rejecting the stream.
			await reader.cancel();
			throw new Error('response_too_large');
		}
		chunks.push(chunk.value);
	}
	const bytes = new Uint8Array(byteLength);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

const responseSchema = {
	type: 'object',
	additionalProperties: false,
	required: ['paymentAccountId', 'categoryId', 'clientId', 'billable', 'rationale', 'confidence'],
	properties: {
		paymentAccountId: { type: ['string', 'null'] },
		categoryId: { type: ['string', 'null'] },
		clientId: { type: ['string', 'null'] },
		billable: { type: ['boolean', 'null'] },
		rationale: { type: 'string', maxLength: 500 },
		confidence: { type: ['number', 'null'], minimum: 0, maximum: 1 }
	}
};

export class ClassificationService extends Context.Service<
	ClassificationService,
	{
		readonly provider: string;
		readonly model: string;
		readonly configured: boolean;
		readonly classify: (
			request: ClassificationRequest
		) => Effect.Effect<ClassificationSuggestion, ClassificationError>;
	}
>()('expensifier/ClassificationService') {
	static fakeLayer(
		suggestion: ClassificationSuggestion = {
			paymentAccountId: null,
			categoryId: null,
			clientId: null,
			billable: false,
			rationale: 'Sanitized fixture suggestion',
			confidence: 0.8
		}
	): Layer.Layer<ClassificationService> {
		return Layer.succeed(
			ClassificationService,
			ClassificationService.of({
				provider: 'fake',
				model: 'fixture-v1',
				configured: true,
				classify: () => Effect.succeed(suggestion)
			})
		);
	}

	static layerFor(
		config: RuntimeConfig,
		fetchImplementation: ClassificationFetch = fetch
	): Layer.Layer<ClassificationService> {
		return Layer.succeed(
			ClassificationService,
			ClassificationService.of({
				provider: 'openai',
				model: config.classificationModel,
				configured: !!config.classificationApiKey,
				classify: Effect.fn('OpenAiClassification.classify')(function* (
					request: ClassificationRequest
				) {
					if (!config.classificationApiKey) {
						return yield* new ClassificationError({
							code: 'configuration_missing',
							summary: 'Classification provider credentials are not configured',
							retryable: false
						});
					}
					const response = yield* Effect.tryPromise({
						try: () =>
							fetchImplementation(config.classificationEndpoint, {
								method: 'POST',
								headers: {
									Authorization: `Bearer ${config.classificationApiKey}`,
									'Content-Type': 'application/json'
								},
								body: JSON.stringify({
									model: config.classificationModel,
									store: false,
									instructions:
										'Classify the structured receipt fields using only supplied candidate IDs. Return null when evidence is insufficient. Never invent an ID.',
									input: JSON.stringify(request),
									text: {
										format: {
											type: 'json_schema',
											name: 'expense_classification',
											strict: true,
											schema: responseSchema
										}
									}
								}),
								signal: AbortSignal.timeout(config.classificationTimeoutMilliseconds)
							}),
						catch: (cause) =>
							new ClassificationError({
								code:
									cause instanceof DOMException && cause.name === 'TimeoutError'
										? 'timeout'
										: 'provider_unavailable',
								summary: 'Classification provider could not be reached',
								retryable: true
							})
					});
					const responseText = yield* Effect.tryPromise({
						try: () => readBoundedResponse(response, config.classificationMaxResponseBytes),
						catch: () =>
							new ClassificationError({
								code: 'invalid_response',
								summary: 'Classification provider response could not be read',
								retryable: false
							})
					});
					if (!response.ok) {
						const retryable =
							response.status === 408 || response.status === 429 || response.status >= 500;
						return yield* new ClassificationError({
							code: response.status === 429 ? 'rate_limited' : 'provider_rejected',
							summary: `Classification provider rejected the request with status ${response.status}`,
							retryable
						});
					}
					let parsed: unknown;
					try {
						parsed = JSON.parse(responseText);
						const text = outputText(parsed);
						parsed = text ? JSON.parse(text) : null;
					} catch {
						parsed = null;
					}
					const suggestion = parseSuggestion(parsed, request);
					if (!suggestion) {
						return yield* new ClassificationError({
							code: 'invalid_response',
							summary: 'Classification provider returned an invalid structured suggestion',
							retryable: false
						});
					}
					return suggestion;
				})
			})
		);
	}

	static readonly openAiLayer = this.layerFor(runtimeConfig);
}
