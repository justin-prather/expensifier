import { auth, hasUsers } from '$lib/server/auth';
import { Credentials } from '$lib/server/credentials';
import { fail, redirect } from '@sveltejs/kit';
import { Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user) {
		redirect(303, '/');
	}

	if (!hasUsers()) {
		redirect(303, '/setup');
	}
};

export const actions: Actions = {
	default: async ({ request }) => {
		const form = await request.formData();

		try {
			const credentials = Schema.decodeUnknownSync(Credentials)({
				email: form.get('email'),
				password: form.get('password')
			});

			await auth.api.signInEmail({
				body: { ...credentials, rememberMe: true },
				headers: request.headers
			});
		} catch {
			return fail(400, {
				message: 'Check your email and password, then try again.',
				email: String(form.get('email') ?? '')
			});
		}

		redirect(303, '/');
	}
};
