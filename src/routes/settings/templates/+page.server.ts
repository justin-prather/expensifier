import { requirePermission } from '$lib/server/authorization';
import { ReferenceService } from '$lib/server/reference';
import type { Actor } from '$lib/server/review';
import { appRuntime } from '$lib/server/runtime';
import { TemplateService } from '$lib/server/templates';
import { fail } from '@sveltejs/kit';
import { Effect, Result } from 'effect';

import type { Actions, PageServerLoad } from './$types';

const sampleValues = {
	date: '2026-08-20',
	vendor: 'Home Depot',
	amount: '148.27',
	currency: 'CAD',
	paymentAccount: '0740-CIBC-USD-VISA',
	notes: 'Shelving brackets',
	billable: true,
	client: 'Acme Corp',
	extension: 'pdf',
	expenseId: '00000000-0000-0000-0000-000000000000'
};

function actorFrom(user: { id: string; email?: string | null }): Actor {
	return { id: user.id, label: user.email ?? user.id };
}

async function preview() {
	return appRuntime.runPromise(
		Effect.gen(function* () {
			const templates = yield* TemplateService;
			return {
				filename: yield* templates.previewFilename(sampleValues),
				destination: yield* templates.previewDestination(sampleValues)
			};
		})
	);
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'settings:manage');
	const templates = await appRuntime.runPromise(ReferenceService.use((refs) => refs.templates));
	return {
		filename: templates.filename,
		destination: templates.destination,
		preview: await preview(),
		sampleValues
	};
};

export const actions: Actions = {
	save: async ({ locals, request }) => {
		const actor = actorFrom(requirePermission(locals.user, 'settings:manage'));
		const form = await request.formData();
		const filename = String(form.get('filename') ?? '');
		const destination = String(form.get('destination') ?? '');
		const result = await appRuntime.runPromise(
			Effect.result(
				ReferenceService.use((refs) => refs.saveTemplates({ filename, destination }, actor))
			)
		);
		if (Result.isFailure(result)) {
			return fail(400, {
				action: 'save',
				message: result.failure.message,
				filename,
				destination
			});
		}
		const saved = result.success;
		return {
			action: 'save',
			message: 'Templates saved.',
			filename: saved.filename,
			destination: saved.destination,
			preview: await preview()
		};
	}
};
