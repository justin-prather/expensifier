import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import { Context, Effect, Layer, Schema } from 'effect';

import { runtimeConfig, type RuntimeConfig } from './config';

export class OcrTextField extends Schema.Class<OcrTextField>('OcrTextField')({
	value: Schema.NullOr(Schema.String),
	confidence: Schema.NullOr(Schema.Number),
	source: Schema.String
}) {}

export class OcrAmountField extends Schema.Class<OcrAmountField>('OcrAmountField')({
	value: Schema.NullOr(Schema.String),
	confidence: Schema.NullOr(Schema.Number),
	source: Schema.String
}) {}

export class OcrLineItem extends Schema.Class<OcrLineItem>('OcrLineItem')({
	description: OcrTextField,
	quantity: OcrAmountField,
	unitPrice: OcrAmountField,
	netAmount: OcrAmountField,
	taxAmount: OcrAmountField,
	grossAmount: OcrAmountField
}) {}

export class NormalizedOcrResult extends Schema.Class<NormalizedOcrResult>('NormalizedOcrResult')({
	provider: Schema.String,
	merchantName: OcrTextField,
	transactionDate: OcrTextField,
	totalAmount: OcrAmountField,
	taxAmount: OcrAmountField,
	currencyCode: OcrTextField,
	lineItems: Schema.Array(OcrLineItem)
}) {}

export interface OcrDocument {
	readonly id: string;
	readonly absolutePath: string;
	readonly mimeType: string;
	readonly originalFilename: string;
	readonly byteSize: number;
	readonly contentHash: string;
}

export interface OcrProviderResult {
	readonly rawResponseJson: string;
	readonly normalized: NormalizedOcrResult;
}

const OcrErrorCode = Schema.Literals([
	'configuration_missing',
	'file_unreadable',
	'unauthorized',
	'rate_limited',
	'timeout',
	'provider_unavailable',
	'rejected_document',
	'invalid_response'
]);

export class OcrError extends Schema.TaggedError<OcrError>()('OcrError', {
	code: OcrErrorCode,
	summary: Schema.String,
	retryable: Schema.Boolean,
	rawResponseJson: Schema.NullOr(Schema.String)
}) {}

type UnknownRecord = Readonly<Record<string, unknown>>;

function record(value: unknown): UnknownRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as UnknownRecord)
		: {};
}

function fieldValue(value: unknown): unknown {
	const candidate = record(value);
	return 'data' in candidate ? candidate.data : value;
}

function confidence(value: unknown): number | null {
	const candidate = record(value).confidenceLevel;
	return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}

function textField(root: UnknownRecord, key: string): OcrTextField {
	const raw = root[key];
	const value = fieldValue(raw);
	return new OcrTextField({
		value: typeof value === 'string' && value.trim() ? value.trim() : null,
		confidence: confidence(raw),
		source: `${key}.data`
	});
}

function amountField(root: UnknownRecord, key: string): OcrAmountField {
	const raw = root[key];
	const value = fieldValue(raw);
	return new OcrAmountField({
		value:
			typeof value === 'number' && Number.isFinite(value)
				? String(value)
				: typeof value === 'string' && value.trim()
					? value.trim()
					: null,
		confidence: confidence(raw),
		source: `${key}.data`
	});
}

function emptyAmount(source: string): OcrAmountField {
	return new OcrAmountField({ value: null, confidence: null, source });
}

function validTaggunField(
	root: UnknownRecord,
	key: string,
	expected: 'string' | 'number'
): boolean {
	if (!(key in root)) return true;
	const field = record(root[key]);
	if (Object.keys(field).length === 0 && root[key] !== null) return false;
	if ('data' in field && field.data !== null && typeof field.data !== expected) return false;
	return !('confidenceLevel' in field) || typeof field.confidenceLevel === 'number';
}

function validTaggunResponse(value: unknown): boolean {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
	const root = record(value);
	const recognized = [
		'totalAmount',
		'taxAmount',
		'date',
		'merchantName',
		'text',
		'trackingId',
		'confidenceLevel',
		'entities'
	].some((key) => key in root);
	if (!recognized) return false;
	if (!validTaggunField(root, 'totalAmount', 'number')) return false;
	if (!validTaggunField(root, 'taxAmount', 'number')) return false;
	if (!validTaggunField(root, 'date', 'string')) return false;
	if (!validTaggunField(root, 'merchantName', 'string')) return false;
	const items = record(root.entities).productLineItems;
	return items === undefined || Array.isArray(items);
}

async function readDocument(
	path: string,
	expectedBytes: number,
	maximumBytes: number,
	expectedHash: string
): Promise<Uint8Array> {
	const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const metadata = await handle.stat();
		if (!metadata.isFile() || metadata.size !== expectedBytes || metadata.size > maximumBytes) {
			throw new Error('invalid_managed_file');
		}
		const bytes = await handle.readFile();
		if (
			bytes.byteLength !== expectedBytes ||
			bytes.byteLength > maximumBytes ||
			createHash('sha256').update(bytes).digest('hex') !== expectedHash
		) {
			throw new Error('invalid_managed_file');
		}
		return bytes;
	} finally {
		await handle.close();
	}
}

async function readResponse(response: Response, maximumBytes: number): Promise<string> {
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

export function normalizeTaggunResponse(value: unknown): NormalizedOcrResult {
	const root = record(value);
	const totalAmount = record(root.totalAmount);
	const entities = record(root.entities);
	const items = Array.isArray(entities.productLineItems) ? entities.productLineItems : [];
	const providerDate = textField(root, 'date');
	return new NormalizedOcrResult({
		provider: 'taggun',
		merchantName: textField(root, 'merchantName'),
		transactionDate: new OcrTextField({
			...providerDate,
			value: providerDate.value?.match(/^\d{4}-\d{2}-\d{2}T/)
				? providerDate.value.slice(0, 10)
				: providerDate.value
		}),
		totalAmount: amountField(root, 'totalAmount'),
		taxAmount: amountField(root, 'taxAmount'),
		currencyCode: new OcrTextField({
			value:
				typeof totalAmount.currencyCode === 'string' && totalAmount.currencyCode.trim()
					? totalAmount.currencyCode.trim()
					: null,
			confidence: confidence(root.totalAmount),
			source: 'totalAmount.currencyCode'
		}),
		lineItems: items.map((item, index) => {
			const row = record(record(item).data);
			const itemConfidence = confidence(item);
			const amount = (key: string, source: string) => {
				const extracted = amountField(row, key);
				return new OcrAmountField({
					...extracted,
					confidence: extracted.confidence ?? itemConfidence,
					source
				});
			};
			const name = textField(row, 'name');
			return new OcrLineItem({
				description: new OcrTextField({
					...name,
					confidence: name.confidence ?? itemConfidence,
					source: `entities.productLineItems[${index}].data.name.data`
				}),
				quantity: amount('quantity', `entities.productLineItems[${index}].data.quantity.data`),
				unitPrice: amount('unitPrice', `entities.productLineItems[${index}].data.unitPrice.data`),
				netAmount: emptyAmount(`entities.productLineItems[${index}].data.netAmount.data`),
				taxAmount: emptyAmount(`entities.productLineItems[${index}].data.taxAmount.data`),
				grossAmount: amount(
					'totalPrice',
					`entities.productLineItems[${index}].data.totalPrice.data`
				)
			});
		})
	});
}

export class OcrService extends Context.Service<
	OcrService,
	{
		readonly provider: string;
		readonly providerVersion: string;
		readonly process: (document: OcrDocument) => Effect.Effect<OcrProviderResult, OcrError>;
	}
>()('expensifier/OcrService') {
	static readonly fakeLayer = Layer.succeed(
		OcrService,
		OcrService.of({
			provider: 'fake',
			providerVersion: 'fixture-v1',
			process: (document) =>
				Effect.succeed({
					rawResponseJson: JSON.stringify({ fixture: document.mimeType }),
					normalized: new NormalizedOcrResult({
						provider: 'fake',
						merchantName: new OcrTextField({
							value: 'Sanitized Fixture Merchant',
							confidence: 1,
							source: 'fixture.merchantName'
						}),
						transactionDate: new OcrTextField({
							value: '2026-08-20',
							confidence: 1,
							source: 'fixture.date'
						}),
						totalAmount: new OcrAmountField({
							value: '42.00',
							confidence: 1,
							source: 'fixture.totalAmount'
						}),
						taxAmount: new OcrAmountField({
							value: null,
							confidence: null,
							source: 'fixture.taxAmount'
						}),
						currencyCode: new OcrTextField({
							value: 'CAD',
							confidence: 1,
							source: 'fixture.currencyCode'
						}),
						lineItems: []
					})
				})
		})
	);

	static layerFor(
		config: RuntimeConfig,
		fetchImplementation: typeof fetch = fetch
	): Layer.Layer<OcrService> {
		return Layer.succeed(
			OcrService,
			OcrService.of({
				provider: 'taggun',
				providerVersion: 'receipt-v1-verbose',
				process: Effect.fn('TaggunOcr.process')(function* (document: OcrDocument) {
					if (!config.taggunApiKey) {
						return yield* new OcrError({
							code: 'configuration_missing',
							summary: 'OCR provider credentials are not configured',
							retryable: false,
							rawResponseJson: null
						});
					}

					if (document.byteSize > config.ocrMaxFileBytes) {
						return yield* new OcrError({
							code: 'rejected_document',
							summary: 'Document exceeds the OCR provider size limit',
							retryable: false,
							rawResponseJson: null
						});
					}
					const bytes = yield* Effect.tryPromise({
						try: () =>
							readDocument(
								document.absolutePath,
								document.byteSize,
								config.ocrMaxFileBytes,
								document.contentHash
							),
						catch: () =>
							new OcrError({
								code: 'file_unreadable',
								summary: 'Managed document could not be read',
								retryable: false,
								rawResponseJson: null
							})
					});
					const body = new FormData();
					body.append(
						'file',
						new Blob([Uint8Array.from(bytes).buffer], { type: document.mimeType }),
						document.originalFilename
					);
					body.append('extractLineItems', 'true');
					body.append('incognito', 'true');
					body.append('referenceId', document.id);

					const response = yield* Effect.tryPromise({
						try: () =>
							fetchImplementation(config.taggunEndpoint, {
								method: 'POST',
								headers: { apikey: config.taggunApiKey! },
								body,
								signal: AbortSignal.timeout(config.ocrTimeoutMilliseconds)
							}),
						catch: (cause) =>
							new OcrError({
								code:
									cause instanceof DOMException && cause.name === 'TimeoutError'
										? 'timeout'
										: 'provider_unavailable',
								summary:
									cause instanceof DOMException && cause.name === 'TimeoutError'
										? 'OCR provider request timed out'
										: 'OCR provider could not be reached',
								retryable: true,
								rawResponseJson: null
							})
					});
					const rawResponseJson = yield* Effect.tryPromise({
						try: () => readResponse(response, config.ocrMaxResponseBytes),
						catch: (cause) =>
							new OcrError({
								code:
									cause instanceof Error && cause.message === 'response_too_large'
										? 'invalid_response'
										: 'provider_unavailable',
								summary:
									cause instanceof Error && cause.message === 'response_too_large'
										? 'OCR provider response exceeded the size limit'
										: 'OCR provider response could not be read',
								retryable: !(cause instanceof Error && cause.message === 'response_too_large'),
								rawResponseJson: null
							})
					});

					if (!response.ok) {
						const code =
							response.status === 401 || response.status === 403
								? 'unauthorized'
								: response.status === 429
									? 'rate_limited'
									: response.status === 408
										? 'timeout'
										: response.status >= 500
											? 'provider_unavailable'
											: 'rejected_document';
						return yield* new OcrError({
							code,
							summary: `OCR provider rejected the request with status ${response.status}`,
							retryable:
								code === 'rate_limited' || code === 'timeout' || code === 'provider_unavailable',
							rawResponseJson
						});
					}

					let parsed: unknown;
					try {
						parsed = JSON.parse(rawResponseJson);
					} catch {
						return yield* new OcrError({
							code: 'invalid_response',
							summary: 'OCR provider returned an invalid response',
							retryable: false,
							rawResponseJson
						});
					}
					if (!validTaggunResponse(parsed)) {
						return yield* new OcrError({
							code: 'invalid_response',
							summary: 'OCR provider returned an unexpected response shape',
							retryable: false,
							rawResponseJson
						});
					}

					return { rawResponseJson, normalized: normalizeTaggunResponse(parsed) };
				})
			})
		);
	}

	static readonly taggunLayer = this.layerFor(runtimeConfig);
}
