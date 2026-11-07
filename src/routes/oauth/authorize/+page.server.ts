import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { approveRequest, checkAuthorize, denyRequest } from '$lib/server/oauth';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';

/** The page an app sends the owner to ("Sign in" on a connector). The request is checked here; only a sound one is shown, and what is shown is what is later acted on. */
export const load: PageServerLoad = ({ url }) => {
	const r = checkAuthorize(url.search, config.origin);
	if (r.kind === 'error') error(400, r.message);
	if (r.kind === 'redirect') redirect(303, r.location);
	return { requestId: r.requestId, clientName: r.clientName, redirectHost: r.redirectHost, sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })), readOnly: config.readOnly };
};

const expired = 'This sign-in request expired or was already used. Start again from the app.';

export const actions: Actions = {
	allow: async ({ request }) => {
		const f = await request.formData();
		const id = String(f.get('request_id') ?? '');
		let siteIds: number[] | null = null;
		if (f.get('scope') === 'selected') {
			const known = new Set(allSites().map((s) => s.id));
			siteIds = [...new Set(f.getAll('site').map(Number).filter((n) => Number.isInteger(n) && known.has(n)))];
			if (!siteIds.length) return fail(400, { error: 'Pick at least one site, or choose all sites.' });
		}
		const r = approveRequest(id, siteIds, Date.now(), f.get('submit') === '1' && !config.readOnly);
		return r ? { redirect: r.location } : fail(400, { error: expired });
	},
	deny: async ({ request }) => {
		const r = denyRequest(String((await request.formData()).get('request_id') ?? ''));
		return r ? { redirect: r.location } : fail(400, { error: expired });
	}
};
