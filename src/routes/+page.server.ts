import { auth, hasUsers } from '$lib/server/auth';
import { requirePermission } from '$lib/server/authorization';
import { DocumentRepository, QueueItem } from '$lib/server/documents';
import { IntakeService } from '$lib/server/intake';
import { JobService } from '$lib/server/jobs';
import { appRuntime } from '$lib/server/runtime';
import { redirect } from '@sveltejs/kit';
import { Effect, Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, hasUsers() ? '/login' : '/setup');
	}
	requirePermission(locals.user, 'expenses:view');

	const queue = await appRuntime.runPromise(
		DocumentRepository.use((repository) => repository.queue)
	);
	const encodeQueueItem = Schema.encodeSync(QueueItem);

	return {
		queue: queue.map((item) => encodeQueueItem(item)),
		user: locals.user
	};
};

export const actions: Actions = {
	'reconcile-inbox': async ({ locals }) => {
		requirePermission(locals.user, 'expenses:retry-ocr');
		await appRuntime.runPromise(
			Effect.gen(function* () {
				const intake = yield* IntakeService;
				const jobs = yield* JobService;
				yield* intake.reconcile;
				yield* jobs.processAvailable;
			})
		);
		return { message: 'Inbox reconciliation requested' };
	},
	'sign-out': async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, '/login');
	}
};
