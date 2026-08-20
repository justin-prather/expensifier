import { auth, hasUsers } from '$lib/server/auth';
import { SetupCredentials } from '$lib/server/credentials';
import { fail, redirect } from '@sveltejs/kit';
import { Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ locals }) => {
	if (locals.user || hasUsers()) {
		redirect(303, locals.user ? '/' : '/login');
	}
};

export const actions: Actions = {
	default: async ({ request }) => {
		if (hasUsers()) {
			redirect(303, '/login');
		}

		const form = await request.formData();

		try {
			const credentials = Schema.decodeUnknownSync(SetupCredentials)({
				name: form.get('name'),
				email: form.get('email'),
				password: form.get('password')
			});

			await auth.api.signUpEmail({
				body: credentials,
				headers: request.headers
			});
		} catch {
			return fail(400, {
				message: 'Use a valid name, email, and password of at least eight characters.',
				name: String(form.get('name') ?? ''),
				email: String(form.get('email') ?? '')
			});
		}

		redirect(303, '/');
	}
};
