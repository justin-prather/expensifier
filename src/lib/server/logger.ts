type LogLevel = 'info' | 'warn' | 'error';

export interface OperationalFields {
	readonly component?: 'application' | 'database' | 'jobs';
	readonly recordId?: string;
	readonly jobType?: string;
	readonly status?: string;
	readonly attemptCount?: number;
	readonly durationMs?: number;
	readonly errorCode?: string;
}

export function logOperationalEvent(
	level: LogLevel,
	event: string,
	fields: OperationalFields = {}
): void {
	const entry = JSON.stringify({
		timestamp: new Date().toISOString(),
		level,
		event,
		...fields
	});

	if (level === 'error') {
		console.error(entry);
	} else if (level === 'warn') {
		console.warn(entry);
	} else {
		console.info(entry);
	}
}
