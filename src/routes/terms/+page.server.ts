import type { PageServerLoad } from './$types';
import { termsSections } from '$lib/legal';
import { legalContext } from '$lib/server/legal';

export const load: PageServerLoad = ({ locals }) => {
	const c = legalContext();
	return { sections: termsSections(c.context), configured: c.configured, authed: locals.authed };
};
