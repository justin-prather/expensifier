import { auth } from '$lib/server/auth';
import { InvitationCredentials } from '$lib/server/credentials';
import { InvitationService } from '$lib/server/invitations';
import { appRuntime } from '$lib/server/runtime';
import { fail, redirect } from '@sveltejs/kit';
import { Effect, Result, Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

const messages = {
	invalid: 'This invitation link is not valid.',
	expired: 'This invitation has expired. Ask an admin for a new link.',
	accepted: 'This invitation has already been used.',
	revoked: 'This invitation has been revoked.'
} as const;

export const load: PageServerLoad = async ({ params, locals }) => {
	if (locals.user) redirect(303, '/');
	const outcome = await appRuntime.runPromise(
		InvitationService.use((service) => Effect.result(service.inspect(params.token)))
	);

	if (Result.isFailure(outcome)) {
		return { invitation: null, unavailableMessage: messages[outcome.failure.code] };
	}
	return {
		invitation: { email: outcome.success.email, role: outcome.success.role },
		unavailableMessage: null
	};
};

export const actions: Actions = {
	default: async ({ params, request, locals }) => {
		if (locals.user) redirect(303, '/');
		const form = await request.formData();
		let credentials: { readonly name: string; readonly password: string };
		try {
			credentials = Schema.decodeUnknownSync(InvitationCredentials)({
				name: form.get('name'),
				password: form.get('password')
			});
		} catch {
			return fail(400, {
				message: 'Enter your name and a password of at least eight characters.',
				name: String(form.get('name') ?? '')
			});
		}

		let invitation;
		try {
			invitation = await appRuntime.runPromise(
				InvitationService.use((service) => service.inspect(params.token))
			);
		} catch {
			return fail(400, {
				message: 'This invitation is no longer available.',
				name: credentials.name
			});
		}

		try {
			const created = await auth.api.createUser({
				body: {
					email: invitation.email,
					password: credentials.password,
					name: credentials.name,
					role: invitation.role
				}
			});
			await appRuntime.runPromise(
				InvitationService.use((service) => service.accept(invitation.id, created.user.id))
			);
			await auth.api.signInEmail({
				body: { email: invitation.email, password: credentials.password, rememberMe: true },
				headers: request.headers
			});
		} catch {
			return fail(400, {
				message: 'The account could not be created. Ask an admin for a new invitation.',
				name: credentials.name
			});
		}

		redirect(303, '/');
	}
};
