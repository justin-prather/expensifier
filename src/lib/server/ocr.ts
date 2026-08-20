import { Context, Effect, Layer, Schema } from 'effect';

export class OcrResult extends Schema.Class<OcrResult>('OcrResult')({
	merchant: Schema.String,
	transactionDate: Schema.String,
	total: Schema.String,
	currency: Schema.Literals(['CAD', 'USD', 'EUR']),
	provider: Schema.String
}) {}

export class OcrError extends Schema.TaggedError<OcrError>()('OcrError', {
	code: Schema.String
}) {}

export class OcrService extends Context.Service<
	OcrService,
	{
		readonly process: (documentId: string) => Effect.Effect<OcrResult, OcrError>;
	}
>()('expensifier/OcrService') {
	static readonly fakeLayer = Layer.succeed(
		OcrService,
		OcrService.of({
			process: Effect.fn('OcrService.process')(function* (documentId: string) {
				yield* Effect.sleep('150 millis');

				return new OcrResult({
					merchant: 'Phase Zero Supplies',
					transactionDate: '2026-08-20',
					total: '42.00',
					currency: 'CAD',
					provider: `fake:${documentId.slice(0, 8)}`
				});
			})
		})
	);
}
