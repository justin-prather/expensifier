import { requirePermission } from '$lib/server/authorization';
import { ReferenceService, isReferenceKind, type ReferenceKind } from '$lib/server/reference';
import type { Actor } from '$lib/server/review';
import { VendorRuleService, type VendorRuleInput } from '$lib/server/rules';
import { appRuntime } from '$lib/server/runtime';
import { fail } from '@sveltejs/kit';
import { Effect, Result } from 'effect';

import type { Actions, PageServerLoad } from './$types';

type ServiceMessage = { action: string; message: string };

function actorFrom(user: { id: string; email?: string | null }): Actor {
	return { id: user.id, label: user.email ?? user.id };
}

async function runManaged<T>(
	effect: Effect.Effect<T, { message: string }, ReferenceService | VendorRuleService>
): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
	const result = await appRuntime.runPromise(Effect.result(effect));
	return Result.isSuccess(result)
		? { ok: true, value: result.success }
		: { ok: false, message: result.failure.message };
}

function kindFromForm(form: FormData): ReferenceKind | null {
	const kind = form.get('kind');
	return isReferenceKind(kind) ? kind : null;
}

interface ReferenceRow {
	readonly id: string;
	readonly name: string;
	readonly active: boolean;
	readonly inUse: boolean;
}

function toPlain(items: readonly ReferenceRow[]) {
	return items.map((item) => ({
		id: item.id,
		name: item.name,
		active: item.active,
		inUse: item.inUse
	}));
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'settings:manage');
	const { paymentAccounts, categories, clients } = await appRuntime.runPromise(
		Effect.gen(function* () {
			const refs = yield* ReferenceService;
			return yield* Effect.all({
				paymentAccounts: refs.list('payment_account'),
				categories: refs.list('category'),
				clients: refs.list('client')
			});
		})
	);
	const rules = await appRuntime.runPromise(VendorRuleService.use((service) => service.list));
	return {
		paymentAccounts: toPlain(paymentAccounts),
		categories: toPlain(categories),
		clients: toPlain(clients),
		rules: [...rules]
	};
};

export const actions: Actions = {
	create: async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const kind = kindFromForm(form);
		const name = String(form.get('name') ?? '');
		if (!kind)
			return fail(400, {
				action: 'create',
				message: 'Unknown reference type.'
			});
		const outcome = await runManaged(
			ReferenceService.use((refs) => refs.create(kind, name, actor))
		);
		if (!outcome.ok) return fail(400, { action: 'create', message: outcome.message });
		return { action: 'create', message: 'Created.' } satisfies ServiceMessage;
	},
	rename: async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const kind = kindFromForm(form);
		const id = String(form.get('id') ?? '');
		const name = String(form.get('name') ?? '');
		if (!kind || !id) return fail(400, { action: 'rename', message: 'Unknown reference.' });
		const outcome = await runManaged(
			ReferenceService.use((refs) => refs.rename(kind, id, name, actor))
		);
		if (!outcome.ok) return fail(400, { action: 'rename', message: outcome.message });
		return { action: 'rename', message: 'Renamed.' } satisfies ServiceMessage;
	},
	toggle: async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const kind = kindFromForm(form);
		const id = String(form.get('id') ?? '');
		const active = form.get('active') === 'true';
		if (!kind || !id) return fail(400, { action: 'toggle', message: 'Unknown reference.' });
		const outcome = await runManaged(
			ReferenceService.use((refs) => refs.setActive(kind, id, active, actor))
		);
		if (!outcome.ok) return fail(400, { action: 'toggle', message: outcome.message });
		return {
			action: 'toggle',
			message: active ? 'Activated.' : 'Deactivated.'
		} satisfies ServiceMessage;
	},
	delete: async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const kind = kindFromForm(form);
		const id = String(form.get('id') ?? '');
		if (!kind || !id) return fail(400, { action: 'delete', message: 'Unknown reference.' });
		const outcome = await runManaged(ReferenceService.use((refs) => refs.remove(kind, id, actor)));
		if (!outcome.ok) return fail(400, { action: 'delete', message: outcome.message });
		return { action: 'delete', message: 'Deleted.' } satisfies ServiceMessage;
	},
	'create-rule': async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const input: VendorRuleInput = {
			alias: String(form.get('alias') ?? ''),
			vendorName: String(form.get('vendorName') ?? ''),
			paymentAccountId: String(form.get('paymentAccountId') ?? '') || null,
			categoryId: String(form.get('categoryId') ?? '') || null,
			clientId: String(form.get('clientId') ?? '') || null
		};
		const outcome = await runManaged(VendorRuleService.use((rules) => rules.create(input, actor)));
		if (!outcome.ok) return fail(400, { action: 'create-rule', message: outcome.message });
		return {
			action: 'create-rule',
			message: 'Rule created.'
		} satisfies ServiceMessage;
	},
	'update-rule': async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { action: 'update-rule', message: 'Unknown rule.' });
		const input: VendorRuleInput = {
			alias: String(form.get('alias') ?? ''),
			vendorName: String(form.get('vendorName') ?? ''),
			paymentAccountId: String(form.get('paymentAccountId') ?? '') || null,
			categoryId: String(form.get('categoryId') ?? '') || null,
			clientId: String(form.get('clientId') ?? '') || null
		};
		const outcome = await runManaged(
			VendorRuleService.use((rules) => rules.update(id, input, actor))
		);
		if (!outcome.ok) return fail(400, { action: 'update-rule', message: outcome.message });
		return {
			action: 'update-rule',
			message: 'Rule updated.'
		} satisfies ServiceMessage;
	},
	'toggle-rule': async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		const active = form.get('active') === 'true';
		if (!id) return fail(400, { action: 'toggle-rule', message: 'Unknown rule.' });
		const outcome = await runManaged(
			VendorRuleService.use((rules) => rules.setActive(id, active, actor))
		);
		if (!outcome.ok) return fail(400, { action: 'toggle-rule', message: outcome.message });
		return {
			action: 'toggle-rule',
			message: active ? 'Rule activated.' : 'Rule deactivated.'
		} satisfies ServiceMessage;
	},
	'delete-rule': async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const id = String(form.get('id') ?? '');
		if (!id) return fail(400, { action: 'delete-rule', message: 'Unknown rule.' });
		const outcome = await runManaged(VendorRuleService.use((rules) => rules.remove(id, actor)));
		if (!outcome.ok) return fail(400, { action: 'delete-rule', message: outcome.message });
		return {
			action: 'delete-rule',
			message: 'Rule deleted.'
		} satisfies ServiceMessage;
	}
};
