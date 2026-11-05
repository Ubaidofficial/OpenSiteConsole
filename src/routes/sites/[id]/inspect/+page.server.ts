import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite } from '$lib/server/clients';
import { db } from '$lib/server/db';
import { periodFor, topPages } from '$lib/server/queries';
import type { InspectionResult } from '$lib/server/google';

const TTL = 12 * 3600_000;
const MAX_URLS = 20;

interface Row { url: string; fetched_at: number; result: string }

export const load: PageServerLoad = ({ params }) => {
	const rows = db().prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ? ORDER BY fetched_at DESC LIMIT 200').all(Number(params.id)) as Row[];
	return { results: rows.map((r) => ({ url: r.url, at: r.fetched_at, r: JSON.parse(r.result) as InspectionResult & { error?: string } })) };
};

async function inspectMany(siteId: number, urls: string[], force: boolean) {
	const { client, site } = clientForSite(siteId);
	const d = db();
	const get = d.prepare('SELECT fetched_at FROM url_inspections WHERE site_id = ? AND url = ?');
	const put = d.prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
	let live = 0;
	let cached = 0;
	const queue = [...new Set(urls)].slice(0, MAX_URLS);
	// URL Inspection is quota-limited (~2000/day per property), so stay gentle: 3 at a time, 12h cache.
	const worker = async () => {
		for (let u = queue.shift(); u; u = queue.shift()) {
			const hit = get.get(siteId, u) as { fetched_at: number } | undefined;
			if (hit && !force && Date.now() - hit.fetched_at < TTL) {
				cached++;
				continue;
			}
			try {
				put.run(siteId, u, Date.now(), JSON.stringify(await client.inspectUrl(site.site_url, u)));
			} catch (e) {
				put.run(siteId, u, Date.now(), JSON.stringify({ error: e instanceof Error ? e.message : 'Inspection failed' }));
			}
			live++;
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	return { live, cached };
}

export const actions: Actions = {
	inspect: async ({ params, request }) => {
		const f = await request.formData();
		const urls = String(f.get('urls') ?? '')
			.split(/\s+/)
			.filter((u) => /^https?:\/\/\S+$/.test(u));
		if (!urls.length) return fail(400, { error: 'Paste one or more full URLs (up to 20).' });
		return { ...(await inspectMany(Number(params.id), urls, f.get('force') === 'on')), truncated: urls.length > MAX_URLS };
	},
	top: async ({ params }) => {
		const site = clientForSite(Number(params.id)).site;
		const p = periodFor(site, 28);
		const urls = topPages(site.id, p.start, p.end, {}, 10).map((r) => r.page);
		if (!urls.length) return fail(400, { error: 'No page data yet.' });
		return { ...(await inspectMany(site.id, urls, false)), truncated: false };
	}
};
