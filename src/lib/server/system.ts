import { Context, Effect, Layer, Ref } from 'effect';

import { ensureManagedDirectories, managedDirectoriesAreWritable } from './config';
import { DatabaseLive } from './database';
import { DocumentRepository } from './documents';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { InvitationService } from './invitations';
import { JobRepository, JobService } from './jobs';
import { logOperationalEvent } from './logger';
import { OcrService } from './ocr';

const PersistenceLive = Layer.merge(
	Layer.merge(JobRepository.layerWithoutDependencies, InvitationService.layerWithoutDependencies),
	DocumentRepository.layerWithoutDependencies
).pipe(Layer.provide(DatabaseLive));

const ServiceDependenciesLive = Layer.merge(
	Layer.merge(PersistenceLive, OcrService.fakeLayer),
	FileLifecycleService.layer
);

const ApplicationServicesLive = Layer.merge(
	JobService.layerWithoutDependencies,
	IntakeService.layerWithoutDependencies
).pipe(Layer.provideMerge(ServiceDependenciesLive));

export interface ReadinessReport {
	readonly status: 'ready' | 'unavailable';
	readonly checks: {
		readonly runtime: boolean;
		readonly database: boolean;
		readonly jobs: boolean;
		readonly intake: boolean;
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
			const intake = yield* IntakeService;
			const started = yield* Ref.make(false);

			const initialize = Effect.gen(function* () {
				yield* Effect.sync(ensureManagedDirectories);
				yield* intake.start;
				yield* jobs.recoverAndProcess;
				yield* jobs.start;
				yield* Ref.set(started, true);
				logOperationalEvent('info', 'application_started', {
					component: 'application',
					status: 'ready'
				});
			}).pipe(Effect.withSpan('SystemService.initialize'));

			const readiness = Effect.gen(function* () {
				const runtime = yield* Ref.get(started);
				const jobChecks = yield* jobs.health.pipe(
					Effect.map((health) => ({ database: true, jobs: health.started })),
					Effect.catchCause(() => Effect.succeed({ database: false, jobs: false }))
				);
				const intakeStarted = yield* intake.isStarted;
				const storage = managedDirectoriesAreWritable();
				const ready = runtime && jobChecks.database && jobChecks.jobs && intakeStarted && storage;

				return {
					status: ready ? 'ready' : 'unavailable',
					checks: { runtime, ...jobChecks, intake: intakeStarted, storage }
				} satisfies ReadinessReport;
			});

			return SystemService.of({ initialize, readiness });
		})
	);

	static readonly layer = this.layerWithoutDependencies.pipe(
		Layer.provideMerge(ApplicationServicesLive)
	);
}
