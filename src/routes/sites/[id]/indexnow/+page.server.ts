import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { audit } from '$lib/server/db';
import { pacificToday } from '$lib/server/dates';
import { createKey, getKey, indexNowStatus, recentSitemapUrls, removedUrls, setAuto, submitUrls, verifyHost, hostStatuses, type SubmitResult } from '$lib/server/indexnow';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	return { status: indexNowStatus(site), presets: { recent: recentSitemapUrls(site.id, pacificToday()).length, removed: removedUrls(site).length } };
};

const summarise = (r: SubmitResult) => {
	if (r.error && !r.accepted && !r.batches.length) return { error: r.error };
	const skipped = r.skipped.map((s) => `${s.count} skipped (${s.reason})`).join('; ');
	return r.accepted ? { ok: `Sent ${r.accepted.toLocaleString('en-US')} URL${r.accepted === 1 ? '' : 's'} to IndexNow${skipped ? `; ${skipped}` : ''}.${r.error ? ` A problem: ${r.error}` : ''} Received, not necessarily indexed.` } : { error: r.error ?? `Nothing was sent${skipped ? `: ${skipped}` : ''}.` };
};

export const actions: Actions = {
	createKey: ({ params }) => {
		if (getKey(Number(params.id))) return fail(409, { error: 'A key already exists. Regenerate it only if you must: the key file on your site has to be replaced.' });
		createKey(Number(params.id));
		audit('indexnow.key_created', { siteId: Number(params.id) });
		return { ok: 'Key created. Download the key file and upload it to the root of your site, then verify it below.' };
	},
	regenerate: ({ params }) => {
		createKey(Number(params.id));
		audit('indexnow.key_regenerated', { siteId: Number(params.id) });
		return { ok: 'New key created. Upload the new key file; every host must be verified again.' };
	},
	verify: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const host = String((await request.formData()).get('host') ?? '');
		const r = await verifyHost(site, host);
		return r.ok ? { ok: `${host}: ${r.message}` } : fail(400, { error: `${host}: ${r.message}` });
	},
	verifyAll: async ({ params }) => {
		const site = getSite(Number(params.id))!;
		let ok = 0, bad = 0;
		for (const h of hostStatuses(site)) (await verifyHost(site, h.host)).ok ? ok++ : bad++;
		return bad ? fail(400, { error: `${ok} host${ok === 1 ? '' : 's'} verified, ${bad} not: see the messages below.` }) : { ok: `${ok} host${ok === 1 ? '' : 's'} verified.` };
	},
	auto: async ({ params, request }) => {
		const on = (await request.formData()).get('on') === '1';
		if (!getKey(Number(params.id))) return fail(400, { error: 'Create a key first.' });
		setAuto(Number(params.id), on);
		return { ok: on ? 'Automatic submission is on: new and changed sitemap URLs are sent after each sitemap read.' : 'Automatic submission is off.' };
	},
	submit: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const f = await request.formData();
		const urls = String(f.get('urls') ?? '').split(/\s+/).filter(Boolean);
		if (!urls.length) return fail(400, { error: 'Paste one or more full URLs, one per line.' });
		const r = await submitUrls(site, urls, { force: f.get('force') === 'on' });
		audit('indexnow.submitted', { siteId: site.id, detail: `${r.accepted} accepted` });
		return summarise(r);
	},
	presetRecent: async ({ params }) => {
		const site = getSite(Number(params.id))!;
		const urls = recentSitemapUrls(site.id, pacificToday());
		if (!urls.length) return fail(400, { error: 'No sitemap URL has a date in the last 7 days (or the sitemaps have not been read yet).' });
		return summarise(await submitUrls(site, urls));
	},
	presetRemoved: async ({ params }) => {
		const site = getSite(Number(params.id))!;
		const urls = removedUrls(site);
		if (!urls.length) return fail(400, { error: 'No page is known to return a 404 right now (the indexing monitor has not seen one).' });
		return summarise(await submitUrls(site, urls));
	}
};
