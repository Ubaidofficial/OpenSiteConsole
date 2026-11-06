import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite } from '$lib/server/clients';
import { db } from '$lib/server/db';
import { inspectUrls, MAX_INSPECT_URLS } from '$lib/server/inspect';
import { periodFor, topPages } from '$lib/server/queries';
import type { InspectionResult } from '$lib/server/google';

const MAX_URLS = MAX_INSPECT_URLS;

interface Row { url: string; fetched_at: number; result: string }

export const load: PageServerLoad = ({ params }) => {
	const rows = db().prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ? ORDER BY fetched_at DESC LIMIT 200').all(Number(params.id)) as Row[];
	return { results: rows.map((r) => ({ url: r.url, at: r.fetched_at, r: JSON.parse(r.result) as InspectionResult & { error?: string } })) };
};

export const actions: Actions = {
	inspect: async ({ params, request }) => {
		const f = await request.formData();
		const urls = String(f.get('urls') ?? '')
			.split(/\s+/)
			.filter((u) => /^https?:\/\/\S+$/.test(u));
		if (!urls.length) return fail(400, { error: 'Paste one or more full URLs (up to 20).' });
		return { ...(await inspectUrls(Number(params.id), urls, f.get('force') === 'on')), truncated: urls.length > MAX_URLS };
	},
	top: async ({ params }) => {
		const site = clientForSite(Number(params.id)).site;
		const p = periodFor(site, 28);
		const urls = topPages(site.id, p.start, p.end, {}, 10).map((r) => r.page);
		if (!urls.length) return fail(400, { error: 'No page data yet.' });
		return { ...(await inspectUrls(site.id, urls, false)), truncated: false };
	}
};
