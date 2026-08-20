import { appRuntime } from '$lib/server/runtime';
import { SystemService } from '$lib/server/system';
import { json } from '@sveltejs/kit';

import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		const health = await appRuntime.runPromise(SystemService.use((system) => system.readiness));
		return json(health, { status: health.status === 'ready' ? 200 : 503 });
	} catch {
		return json({ status: 'unavailable' }, { status: 503 });
	}
};
