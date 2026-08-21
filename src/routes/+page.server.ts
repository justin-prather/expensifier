import { auth, hasUsers } from '$lib/server/auth';
import { requirePermission } from '$lib/server/authorization';
import { DocumentRepository, QueueItem } from '$lib/server/documents';
import { ExpenseRepository } from '$lib/server/expenses';
import { IntakeService } from '$lib/server/intake';
import { JobService } from '$lib/server/jobs';
import { appRuntime } from '$lib/server/runtime';
import { fail, redirect } from '@sveltejs/kit';
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
	const review = await appRuntime.runPromise(
		ExpenseRepository.use((repository) => repository.reviewQueue)
	);
	const encodeQueueItem = Schema.encodeSync(QueueItem);

	return {
		queue: queue.map((item) => encodeQueueItem(item)),
		review,
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
	'retry-ocr': async ({ locals, request }) => {
		requirePermission(locals.user, 'expenses:retry-ocr');
		const documentId = (await request.formData()).get('documentId');
		if (typeof documentId !== 'string' || !/^[0-9a-f-]{36}$/i.test(documentId)) {
			return fail(400, { message: 'Invalid document' });
		}
		try {
			await appRuntime.runPromise(JobService.use((service) => service.retryOcr(documentId)));
			return { message: 'OCR retry requested' };
		} catch {
			return fail(409, { message: 'OCR is already active or unavailable' });
		}
	},
	'sign-out': async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, '/login');
	}
};
