import { watch, type FSWatcher } from 'node:fs';

import { Context, Effect, Layer, Result } from 'effect';

import { runtimeConfig, type RuntimeConfig } from './config';
import { DocumentRepository } from './documents';
import { FileLifecycleService, type FileCandidate } from './files';
import { logOperationalEvent } from './logger';

interface Observation {
	readonly byteSize: number;
	readonly modifiedAtMilliseconds: number;
	readonly unchangedSince: number;
}

export class IntakeService extends Context.Service<
	IntakeService,
	{
		readonly start: Effect.Effect<void>;
		readonly reconcile: Effect.Effect<void>;
		readonly isStarted: Effect.Effect<boolean>;
	}
>()('expensifier/IntakeService') {
	static layerFor(config: RuntimeConfig) {
		return Layer.effect(
			IntakeService,
			Effect.gen(function* () {
				const documents = yield* DocumentRepository;
				const files = yield* FileLifecycleService;
				const observations = new Map<string, Observation>();
				let watcher: FSWatcher | undefined;
				let timer: ReturnType<typeof setInterval> | undefined;
				let scanning = false;

				const ingest = Effect.fn('IntakeService.ingest')(function* (candidate: FileCandidate) {
					const contentHash = yield* files.hash(candidate.absolutePath);
					const staged = yield* documents.stage({
						originalFilename: candidate.originalFilename,
						currentRelativePath: candidate.relativePath,
						mimeType: candidate.mimeType,
						extension: candidate.extension,
						byteSize: candidate.byteSize,
						contentHash,
						sourceIdentity: candidate.sourceIdentity
					});
					if (staged.created) {
						logOperationalEvent('info', 'document_staged', {
							component: 'jobs',
							recordId: staged.document.id,
							status: staged.document.duplicateOfDocumentId ? 'duplicate' : 'pending'
						});
					}
				});

				const reconcile = Effect.gen(function* () {
					if (scanning) return;
					scanning = true;
					try {
						const discovered = yield* files.discover;
						const active = new Set(discovered.map((candidate) => candidate.sourceIdentity));
						const now = Date.now();
						for (const candidate of discovered) {
							const previous = observations.get(candidate.sourceIdentity);
							const changed =
								!previous ||
								previous.byteSize !== candidate.byteSize ||
								previous.modifiedAtMilliseconds !== candidate.modifiedAtMilliseconds;
							if (changed) {
								observations.set(candidate.sourceIdentity, {
									byteSize: candidate.byteSize,
									modifiedAtMilliseconds: candidate.modifiedAtMilliseconds,
									unchangedSince: now
								});
								if (config.intakeStableMilliseconds > 0) continue;
							}
							const observed = observations.get(candidate.sourceIdentity);
							if (!observed || now - observed.unchangedSince < config.intakeStableMilliseconds) {
								continue;
							}
							const outcome = yield* Effect.result(ingest(candidate));
							if (Result.isSuccess(outcome)) observations.delete(candidate.sourceIdentity);
						}
						for (const identity of observations.keys()) {
							if (!active.has(identity)) observations.delete(identity);
						}
					} finally {
						scanning = false;
					}
				}).pipe(
					Effect.catchCause(() => Effect.void),
					Effect.withSpan('IntakeService.reconcile')
				);

				const trigger = () => Effect.runFork(reconcile);
				const start = Effect.gen(function* () {
					if (watcher || timer) return;
					yield* reconcile;
					watcher = (() => {
						try {
							return watch(config.directories.inbox, { recursive: true }, trigger);
						} catch {
							return watch(config.directories.inbox, trigger);
						}
					})();
					timer = setInterval(trigger, config.intakeScanIntervalMilliseconds);
				});

				yield* Effect.addFinalizer(() =>
					Effect.sync(() => {
						watcher?.close();
						if (timer) clearInterval(timer);
						watcher = undefined;
						timer = undefined;
					})
				);

				return IntakeService.of({
					start,
					reconcile,
					isStarted: Effect.sync(() => !!watcher && !!timer)
				});
			})
		);
	}

	static readonly layerWithoutDependencies = this.layerFor(runtimeConfig);
}
