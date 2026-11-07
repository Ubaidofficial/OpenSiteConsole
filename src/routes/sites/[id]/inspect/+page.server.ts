import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite } from '$lib/server/clients';
import { db } from '$lib/server/db';
import { inspectUrls, MAX_INSPECT_URLS } from '$lib/server/inspect';
import { periodFor, topPages } from '$lib/server/queries';
import type { InspectionResult } from '$lib/server/google';
import { getSite } from '$lib/server/clients';
import { CHANNEL_LABEL, SubmitRefused, submitForIndexing } from '$lib/server/submission';
import { addPending } from '$lib/server/requestindex';

const MAX_URLS = MAX_INSPECT_URLS;

interface Row { url: string; fetched_at: number; result: string }

export const load: PageServerLoad = ({ params }) => {
	const rows = db().prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ? ORDER BY fetched_at DESC LIMIT 200').all(Number(params.id)) as Row[];
	return { results: rows.map((r) => ({ url: r.url, at: r.fetched_at, r: JSON.parse(r.result) as InspectionResult & { error?: string } })) };
};

export const actions: Actions = {
	/** Send the ticked URLs to the channels that take them (IndexNow, Bing, and Google's Indexing API for job and livestream pages). */
	submitSelected: async ({ params, request }) => {
		const urls = (await request.formData()).getAll('url').map(String).filter(Boolean);
		if (!urls.length) return fail(400, { error: 'Tick at least one URL.' });
		try {
			const r = await submitForIndexing(getSite(Number(params.id))!, urls, { source: 'app' });
			const line = r.channels.map((c) => `${CHANNEL_LABEL[c.channel].split(' (')[0]}: ${c.available ? `${c.accepted} of ${c.attempted} accepted${c.queued ? `, ${c.queued} queued` : ''}` : 'not used'}`).join(' · ');
			return { submitted: `${line}. Details and re-checks are on the Submit tab.` };
		} catch (e) {
			if (e instanceof SubmitRefused) return fail(400, { error: e.message });
			throw e;
		}
	},
	/** Put the ticked URLs on the Request indexing list (the Search Console button has no API, so that list is where you press it). */
	addToRequests: async ({ params, request }) => {
		const urls = (await request.formData()).getAll('url').map(String).filter(Boolean);
		if (!urls.length) return fail(400, { error: 'Tick at least one URL.' });
		const r = addPending(getSite(Number(params.id))!, urls);
		const parts = [`${r.added} added to the Request list`, r.problems && `${r.problems} need fixing first`, r.alreadyIndexed && `${r.alreadyIndexed} already indexed`, r.recentlyAsked && `${r.recentlyAsked} asked about recently`, r.rejected && `${r.rejected} not on this site`].filter(Boolean);
		return { submitted: parts.join(', ') + '. Open the Request tab to ask Google.' };
	},
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
