import { Context, Effect, Layer, Ref } from 'effect';

import { ensureManagedDirectories, managedDirectoriesAreWritable } from './config';
import { DatabaseLive } from './database';
import { InvitationService } from './invitations';
import { JobRepository, JobService } from './jobs';
import { logOperationalEvent } from './logger';
import { OcrService } from './ocr';

const PersistenceLive = Layer.merge(
	JobRepository.layerWithoutDependencies,
	InvitationService.layerWithoutDependencies
).pipe(Layer.provide(DatabaseLive));

const ApplicationServicesLive = JobService.layerWithoutDependencies.pipe(
	Layer.provideMerge(Layer.merge(PersistenceLive, OcrService.fakeLayer))
);

export interface ReadinessReport {
	readonly status: 'ready' | 'unavailable';
	readonly checks: {
		readonly runtime: boolean;
		readonly database: boolean;
		readonly storage: boolean;
	};
}

export class SystemService extends Context.Service<
	SystemService,
	{
		readonly initialize: Effect.Effect<void>;
		readonly readiness: Effect.Effect<ReadinessReport>;
	}
>()('expensifier/SystemService') {
	static readonly layerWithoutDependencies = Layer.effect(
		SystemService,
		Effect.gen(function* () {
			const jobs = yield* JobService;
			const started = yield* Ref.make(false);

			const initialize = Effect.gen(function* () {
				yield* Effect.sync(ensureManagedDirectories);
				yield* jobs.recoverAndProcess;
				yield* Ref.set(started, true);
				logOperationalEvent('info', 'application_started', {
					component: 'application',
					status: 'ready'
				});
			}).pipe(Effect.withSpan('SystemService.initialize'));

			const readiness = Effect.gen(function* () {
				const runtime = yield* Ref.get(started);
				const database = yield* jobs.health.pipe(
					Effect.as(true),
					Effect.catchCause(() => Effect.succeed(false))
				);
				const storage = managedDirectoriesAreWritable();
				const ready = runtime && database && storage;

				return {
					status: ready ? 'ready' : 'unavailable',
					checks: { runtime, database, storage }
				} satisfies ReadinessReport;
			});

			return SystemService.of({ initialize, readiness });
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(
		Layer.provideMerge(ApplicationServicesLive)
	);
}
