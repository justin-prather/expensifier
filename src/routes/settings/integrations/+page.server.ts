import { requirePermission } from '$lib/server/authorization';
import { runtimeConfig } from '$lib/server/config';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'integrations:manage');
	return {
		classification: {
			provider: 'OpenCode Zen',
			model: runtimeConfig.classificationModel,
			configured: !!runtimeConfig.classificationApiKey,
			endpointHost: new URL(runtimeConfig.classificationEndpoint).host,
			timeoutMilliseconds: runtimeConfig.classificationTimeoutMilliseconds
		}
	};
};
