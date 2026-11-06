import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite, getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { audit, db } from '$lib/server/db';
import { diagnoseSitemap } from '$lib/server/sitemapcov';
import { demoSitemapFetch } from '$lib/server/demo-channels';

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
	/** Fetch the sitemap like a crawler and compare it with what Google last reported. Read-only, so allowed in READ_ONLY mode. */
	check: async ({ params, request }) => {
		const feed = String((await request.formData()).get('feed') ?? '').trim();
		if (!/^https?:\/\/\S+$/.test(feed)) return fail(400, { error: 'Not a sitemap address.' });
		const { client, site } = clientForSite(Number(params.id));
		const google = (await client.listSitemaps(site.site_url).catch(() => [])).find((s) => s.path === feed);
		const demo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number }).is_demo;
		return { check: await diagnoseSitemap(feed, site.site_url, google, demo ? demoSitemapFetch(site.id) : undefined) };
	},
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
