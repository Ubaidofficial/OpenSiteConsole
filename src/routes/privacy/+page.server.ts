import type { PageServerLoad } from './$types';
import { privacySections } from '$lib/legal';
import { legalContext } from '$lib/server/legal';

export const load: PageServerLoad = ({ locals }) => {
	const c = legalContext();
	return { sections: privacySections(c.context), configured: c.configured, authed: locals.authed };
};
