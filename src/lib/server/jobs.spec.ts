import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';

import { makeDatabaseLayer } from './database';
import { DocumentRepository } from './documents';
import { FileLifecycleService } from './files';
import { JobRepository, JobService } from './jobs';
import { OcrService } from './ocr';

const PersistenceTest = Layer.merge(
	JobRepository.layerWithoutDependencies,
	DocumentRepository.layerWithoutDependencies
).pipe(Layer.provide(makeDatabaseLayer(':memory:')));

const TestLayer = JobService.layerWithoutDependencies.pipe(
	Layer.provide(
		Layer.merge(Layer.merge(PersistenceTest, OcrService.fakeLayer), FileLifecycleService.layer)
	)
);

describe('JobService', () => {
	it.live('runs a fake OCR job through the durable repository', () =>
		Effect.gen(function* () {
			const jobs = yield* JobService;
			const completed = yield* jobs.enqueueFakeOcr;
			const all = yield* jobs.list;

			expect(completed.status).toBe('succeeded');
			expect(all).toHaveLength(1);
			expect(completed.resultJson).toContain('Phase Zero Supplies');
		}).pipe(Effect.provide(TestLayer))
	);
});
