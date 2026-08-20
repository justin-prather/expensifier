import { building } from '$app/environment';
import { auth, migrateAuthDatabase } from '$lib/server/auth';
import { validateRuntimeConfig } from '$lib/server/config';
import { initializeRuntime, registerShutdownHandlers } from '$lib/server/runtime';
import type { Handle } from '@sveltejs/kit';
import { svelteKitHandler } from 'better-auth/svelte-kit';

export async function init(): Promise<void> {
	if (building) {
		return;
	}

	validateRuntimeConfig();
	await migrateAuthDatabase();
	await initializeRuntime();
	registerShutdownHandlers();
}

export const handle: Handle = async ({ event, resolve }) => {
	const current = await auth.api.getSession({ headers: event.request.headers });
	event.locals.user = current?.user ?? null;
	event.locals.session = current?.session ?? null;

	return svelteKitHandler({ event, resolve, auth, building });
};
