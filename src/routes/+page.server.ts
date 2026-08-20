import { auth, hasUsers } from '$lib/server/auth';
import { requirePermission } from '$lib/server/authorization';
import { Job, JobService } from '$lib/server/jobs';
import { appRuntime } from '$lib/server/runtime';
import { redirect } from '@sveltejs/kit';
import { Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) {
		redirect(303, hasUsers() ? '/login' : '/setup');
	}

	const jobs = await appRuntime.runPromise(JobService.use((service) => service.list));
	const encodeJob = Schema.encodeSync(Job);

	return {
		jobs: jobs.map((job) => encodeJob(job)),
		user: locals.user
	};
};

export const actions: Actions = {
	'run-ocr': async ({ locals }) => {
		requirePermission(locals.user, 'expenses:retry-ocr');

		await appRuntime.runPromise(JobService.use((service) => service.enqueueFakeOcr));
		return { message: 'Fake OCR job completed' };
	},
	'sign-out': async ({ request }) => {
		await auth.api.signOut({ headers: request.headers });
		redirect(303, '/login');
	}
};
