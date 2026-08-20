import { ManagedRuntime } from 'effect';

import { logOperationalEvent } from './logger';
import { SystemService } from './system';

export const appRuntime = ManagedRuntime.make(SystemService.layer);

let shutdownHandlersRegistered = false;
let shutdownPromise: Promise<void> | undefined;

export async function initializeRuntime(): Promise<void> {
	await appRuntime.context();
	await appRuntime.runPromise(SystemService.use((system) => system.initialize));
}

export function shutdownRuntime(): Promise<void> {
	shutdownPromise ??= appRuntime.dispose().then(() => {
		logOperationalEvent('info', 'application_stopped', {
			component: 'application',
			status: 'stopped'
		});
	});
	return shutdownPromise;
}

export function registerShutdownHandlers(): void {
	if (shutdownHandlersRegistered) return;
	shutdownHandlersRegistered = true;

	for (const [signal, exitCode] of [
		['SIGINT', 130],
		['SIGTERM', 143]
	] as const) {
		process.once(signal, () => {
			void shutdownRuntime().finally(() => process.exit(exitCode));
		});
	}
}
