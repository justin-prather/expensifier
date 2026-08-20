import { auth } from '$lib/server/auth';
import { isRole, requirePermission } from '$lib/server/authorization';
import { betterAuthUrl } from '$lib/server/config';
import { Invitation, InvitationService } from '$lib/server/invitations';
import { appRuntime } from '$lib/server/runtime';
import { fail } from '@sveltejs/kit';
import { Schema } from 'effect';

import type { Actions, PageServerLoad } from './$types';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function listUsers(headers: Headers) {
	return auth.api.listUsers({
		query: { limit: 100, sortBy: 'createdAt', sortDirection: 'asc' },
		headers
	});
}

export const load: PageServerLoad = async ({ locals, request }) => {
	requirePermission(locals.user, 'users:manage');
	const [users, invitations] = await Promise.all([
		listUsers(request.headers),
		appRuntime.runPromise(InvitationService.use((service) => service.list))
	]);
	const encodeInvitation = Schema.encodeSync(Invitation);

	return {
		users: users.users,
		invitations: invitations.map((invitation) => encodeInvitation(invitation))
	};
};

export const actions: Actions = {
	invite: async ({ locals, request }) => {
		const actor = requirePermission(locals.user, 'users:manage');
		const form = await request.formData();
		const email = String(form.get('email') ?? '')
			.trim()
			.toLowerCase();
		const role = form.get('role');

		if (!emailPattern.test(email) || !isRole(role)) {
			return fail(400, { action: 'invite', message: 'Enter a valid email and role.', email });
		}

		try {
			const created = await appRuntime.runPromise(
				InvitationService.use((service) =>
					service.create({ email, role, invitedByUserId: actor.id })
				)
			);
			const invitationUrl = new URL(`/invite/${created.token}`, betterAuthUrl).toString();
			return {
				action: 'invite',
				message: `Invitation created for ${created.invitation.email}.`,
				invitationUrl
			};
		} catch {
			return fail(500, {
				action: 'invite',
				message: 'The invitation could not be created.',
				email
			});
		}
	},
	'set-role': async ({ locals, request }) => {
		const actor = requirePermission(locals.user, 'users:manage');
		const form = await request.formData();
		const userId = String(form.get('userId') ?? '');
		const role = form.get('role');
		if (!userId || !isRole(role)) {
			return fail(400, { action: 'set-role', message: 'Select a valid role.' });
		}
		if (userId === actor.id && role !== 'admin') {
			return fail(400, {
				action: 'set-role',
				message: 'You cannot remove your own admin access.'
			});
		}

		const users = await listUsers(request.headers);
		const target = users.users.find((user) => user.id === userId);
		const adminCount = users.users.filter((user) => user.role === 'admin').length;
		if (target?.role === 'admin' && role !== 'admin' && adminCount <= 1) {
			return fail(400, { action: 'set-role', message: 'At least one admin is required.' });
		}

		try {
			await auth.api.setRole({ body: { userId, role }, headers: request.headers });
			return { action: 'set-role', message: 'User role updated.' };
		} catch {
			return fail(400, { action: 'set-role', message: 'The user role could not be updated.' });
		}
	},
	revoke: async ({ locals, request }) => {
		requirePermission(locals.user, 'users:manage');
		const form = await request.formData();
		const invitationId = String(form.get('invitationId') ?? '');
		if (!invitationId) {
			return fail(400, { action: 'revoke', message: 'Invitation not found.' });
		}

		try {
			await appRuntime.runPromise(InvitationService.use((service) => service.revoke(invitationId)));
			return { action: 'revoke', message: 'Invitation revoked.' };
		} catch {
			return fail(400, { action: 'revoke', message: 'Invitation is no longer active.' });
		}
	}
};
