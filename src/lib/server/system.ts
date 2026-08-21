import { Context, Effect, Layer, Ref } from 'effect';

import { ApprovalIntegrationService } from './approval-integration';
import { AuditRepository } from './audit';
import { ensureManagedDirectories, managedDirectoriesAreWritable } from './config';
import { DatabaseLive } from './database';
import { DocumentRepository } from './documents';
import { ExpenseRepository } from './expenses';
import { FileLifecycleService } from './files';
import { IntakeService } from './intake';
import { InvitationService } from './invitations';
import { JobRepository, JobService } from './jobs';
import { logOperationalEvent } from './logger';
import { OcrService } from './ocr';
import { OcrRunRepository } from './ocr-runs';
import { ReferenceService } from './reference';
import { ReviewService } from './review';
import { VendorRuleService } from './rules';
import { TemplateService } from './templates';

const PersistenceLive = Layer.mergeAll(
	JobRepository.layerWithoutDependencies,
	InvitationService.layerWithoutDependencies,
	DocumentRepository.layerWithoutDependencies,
	OcrRunRepository.layerWithoutDependencies,
	ExpenseRepository.layerWithoutDependencies,
	AuditRepository.layerWithoutDependencies,
	TemplateService.layerWithoutDependencies
).pipe(Layer.provideMerge(DatabaseLive));

const AdminServicesLive = Layer.merge(
	ReferenceService.layerWithoutDependencies,
	VendorRuleService.layerWithoutDependencies
).pipe(Layer.provideMerge(PersistenceLive));

const ServiceDependenciesLive = Layer.merge(
	Layer.merge(Layer.merge(PersistenceLive, OcrService.taggunLayer), FileLifecycleService.layer),
	Layer.merge(ApprovalIntegrationService.layer, AdminServicesLive)
);

const ApplicationServicesLive = Layer.merge(
	Layer.merge(JobService.layerWithoutDependencies, IntakeService.layerWithoutDependencies),
	ReviewService.layerWithoutDependencies
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
			const expenses = yield* ExpenseRepository;
			const review = yield* ReviewService;
			const started = yield* Ref.make(false);

			const initialize = Effect.gen(function* () {
				yield* Effect.sync(ensureManagedDirectories);
				yield* intake.start;
				yield* jobs.recoverAndProcess;
				yield* review.recoverInterrupted;
				yield* expenses.reconcileSettled;
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
