import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@effect/vitest';
import { Effect } from 'effect';

import { loadRuntimeConfig } from './config';
import { normalizeTaggunResponse, OcrService } from './ocr';

const fixtures = ['pdf-success.json', 'jpeg-partial.json', 'png-minimal.json'] as const;

function fixture(name: (typeof fixtures)[number]): string {
	return readFileSync(new URL(`./fixtures/taggun/${name}`, import.meta.url), 'utf8');
}

describe('TaggunOcrLayer', () => {
	it('normalizes sanitized provider fixtures while preserving missing fields', () => {
		const results = fixtures.map((name) => normalizeTaggunResponse(JSON.parse(fixture(name))));
		expect(results[0].merchantName.value).toBe('North Market');
		expect(results[0].totalAmount.value).toBe('37.45');
		expect(results[0].lineItems[0]?.description.source).toBe(
			'entities.productLineItems[0].data.name.data'
		);
		expect(results[1].taxAmount.value).toBeNull();
		expect(results[2].merchantName.value).toBeNull();
		expect(results.every((result) => result.provider === 'taggun')).toBe(true);
	});

	it.live('uploads multipart content and returns raw plus normalized results', () => {
		const root = mkdtempSync(join(tmpdir(), 'expensifier-taggun-contract-'));
		const path = join(root, 'receipt.pdf');
		writeFileSync(path, '%PDF-1.4\nfixture');
		const config = loadRuntimeConfig({
			APP_DATA_ROOT: root,
			TAGGUN_API_KEY: 'contract-test-key',
			TAGGUN_ENDPOINT: 'https://taggun.invalid/api/receipt/v1/verbose/file'
		});
		let request: RequestInit | undefined;
		const fetchFixture = (async (_input: string | URL | Request, init?: RequestInit) => {
			request = init;
			return new Response(fixture('pdf-success.json'), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			});
		}) as typeof fetch;

		return OcrService.use((service) =>
			service.process({
				id: 'document-id',
				absolutePath: path,
				mimeType: 'application/pdf',
				originalFilename: 'receipt.pdf',
				byteSize: Buffer.byteLength('%PDF-1.4\nfixture'),
				contentHash: createHash('sha256').update('%PDF-1.4\nfixture').digest('hex')
			})
		).pipe(
			Effect.tap((result) =>
				Effect.sync(() => {
					expect(request?.method).toBe('POST');
					expect(new Headers(request?.headers).get('apikey')).toBe('contract-test-key');
					expect(request?.body).toBeInstanceOf(FormData);
					expect(result.rawResponseJson).toContain('North Market');
					expect(result.normalized.currencyCode.value).toBe('CAD');
				})
			),
			Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
			Effect.provide(OcrService.layerFor(config, fetchFixture))
		);
	});

	it.live('classifies throttling as retryable and retains the provider response', () => {
		const root = mkdtempSync(join(tmpdir(), 'expensifier-taggun-failure-'));
		const path = join(root, 'receipt.png');
		writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
		const config = loadRuntimeConfig({ APP_DATA_ROOT: root, TAGGUN_API_KEY: 'contract-test-key' });
		const throttled = (async () =>
			new Response('{"error":"rate limit"}', { status: 429 })) as unknown as typeof fetch;

		return OcrService.use((service) =>
			service.process({
				id: 'document-id',
				absolutePath: path,
				mimeType: 'image/png',
				originalFilename: 'receipt.png',
				byteSize: 4,
				contentHash: createHash('sha256')
					.update(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
					.digest('hex')
			})
		).pipe(
			Effect.flip,
			Effect.tap((error) =>
				Effect.sync(() => {
					expect(error.code).toBe('rate_limited');
					expect(error.retryable).toBe(true);
					expect(error.rawResponseJson).toBe('{"error":"rate limit"}');
				})
			),
			Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
			Effect.provide(OcrService.layerFor(config, throttled))
		);
	});

	it.live('rejects a successful HTTP response that does not match the provider contract', () => {
		const root = mkdtempSync(join(tmpdir(), 'expensifier-taggun-invalid-'));
		const path = join(root, 'receipt.pdf');
		writeFileSync(path, '%PDF-1.4\nfixture');
		const config = loadRuntimeConfig({ APP_DATA_ROOT: root, TAGGUN_API_KEY: 'contract-test-key' });
		const errorEnvelope = (async () =>
			new Response('{"error":"unexpected"}', { status: 200 })) as unknown as typeof fetch;

		return OcrService.use((service) =>
			service.process({
				id: 'document-id',
				absolutePath: path,
				mimeType: 'application/pdf',
				originalFilename: 'receipt.pdf',
				byteSize: Buffer.byteLength('%PDF-1.4\nfixture'),
				contentHash: createHash('sha256').update('%PDF-1.4\nfixture').digest('hex')
			})
		).pipe(
			Effect.flip,
			Effect.tap((error) =>
				Effect.sync(() => {
					expect(error.code).toBe('invalid_response');
					expect(error.retryable).toBe(false);
					expect(error.rawResponseJson).toBe('{"error":"unexpected"}');
				})
			),
			Effect.ensuring(Effect.sync(() => rmSync(root, { recursive: true, force: true }))),
			Effect.provide(OcrService.layerFor(config, errorEnvelope))
		);
	});
});
