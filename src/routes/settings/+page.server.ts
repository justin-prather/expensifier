import { requirePermission } from '$lib/server/authorization';

import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'settings:manage');
	return {};
};
