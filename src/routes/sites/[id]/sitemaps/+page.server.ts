import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite, getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { audit } from '$lib/server/db';

export const load: PageServerLoad = async ({ params }) => {
	const { client, site } = clientForSite(Number(params.id));
	if (['siteUnverifiedUser', 'none'].includes(site.permission)) return { sitemaps: [], error: 'This property is not verified for this account.' };
	try {
		return { sitemaps: await client.listSitemaps(site.site_url), error: null };
	} catch (e) {
		return { sitemaps: [], error: e instanceof Error ? e.message : 'Could not load sitemaps' };
	}
};

function guard() {
	return config.readOnly ? fail(403, { error: 'READ_ONLY=1: sitemap changes are disabled.' }) : null;
}

export const actions: Actions = {
	submit: async ({ params, request }) => {
		const blocked = guard();
		if (blocked) return blocked;
		const feed = String((await request.formData()).get('feed') ?? '').trim();
		if (!/^https?:\/\/\S+$/.test(feed)) return fail(400, { error: 'Enter a full sitemap URL, e.g. https://example.com/sitemap.xml' });
		const { client, site } = clientForSite(Number(params.id));
		try {
			await client.submitSitemap(site.site_url, feed);
			audit('sitemap.submitted', { siteId: site.id, detail: feed });
			return { ok: `Submitted ${feed}` };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'Submit failed' });
		}
	},
	delete: async ({ params, request }) => {
		const blocked = guard();
		if (blocked) return blocked;
		const feed = String((await request.formData()).get('feed') ?? '');
		const site = getSite(Number(params.id))!;
		const { client } = clientForSite(site.id);
		try {
			await client.deleteSitemap(site.site_url, feed);
			audit('sitemap.deleted', { siteId: site.id, detail: feed });
			return { ok: `Removed ${feed}` };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'Delete failed' });
		}
	}
};
