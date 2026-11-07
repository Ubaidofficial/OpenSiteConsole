import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { getKey, hostStatuses } from '$lib/server/indexnow';
import { indexingApiDailyCap, indexingApiEnabled, indexingApiUsed } from '$lib/server/indexingapi';
import { linksFor } from '$lib/server/links';
import { clientForSite } from '$lib/server/clients';
import { diagnoseSitemap } from '$lib/server/sitemapcov';
import { demoSitemapFetch } from '$lib/server/demo-channels';
import { enqueueIndexMonitor } from '$lib/server/jobs';
import { CHANNELS, MAX_SUBMIT_URLS, SubmitRefused, presetUrls, resubmitSitemaps, submissionStatus, submitForIndexing, submitSitemapTo, type Channel, type Preset } from '$lib/server/submission';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	const hosts = getKey(site.id) ? hostStatuses(site) : [];
	return {
		readOnly: config.readOnly,
		maxUrls: MAX_SUBMIT_URLS,
		channels: {
			indexnow: { hasKey: !!getKey(site.id), verifiedHosts: hosts.filter((h) => h.ok).length },
			bing: { linked: !!linksFor(site.id).bing },
			googleIndexing: { enabled: indexingApiEnabled(), used: indexingApiUsed(site.id), cap: indexingApiDailyCap() }
		},
		presets: { new: presetUrls(site, 'new').length, never_shown: presetUrls(site, 'never_shown').length, removed: presetUrls(site, 'removed').length },
		submissions: submissionStatus(site.id, 50)
	};
};

const readUrls = (v: FormDataEntryValue | null) => String(v ?? '').split(/\s+/).filter(Boolean);

export const actions: Actions = {
	/** Fill the box with a ready-made list; nothing is sent until the owner presses Submit. */
	preset: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const preset = String((await request.formData()).get('preset') ?? '') as Preset;
		if (!['new', 'never_shown', 'removed'].includes(preset)) return fail(400, { error: 'Unknown list.' });
		const urls = presetUrls(site, preset);
		return urls.length ? { prefill: urls.join('\n') } : fail(400, { error: 'Nothing found for that list (the sitemaps may not have been read yet: Indexing tab → Read sitemaps now).' });
	},
	submit: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const f = await request.formData();
		const channels = f.getAll('channel').map(String).filter((c): c is Channel => (CHANNELS as string[]).includes(c));
		if (!channels.length) return fail(400, { error: 'Tick at least one channel.' });
		try {
			return { report: await submitForIndexing(site, readUrls(f.get('urls')), { channels, dryRun: f.get('dry') === 'on', force: f.get('force') === 'on', source: 'app' }) };
		} catch (e) {
			if (e instanceof SubmitRefused) return fail(400, { error: e.message });
			throw e;
		}
	},
	sitemapSubmit: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		try {
			const feed = await submitSitemapTo(site, String((await request.formData()).get('feed') ?? ''), 'app');
			return { ok: `Submitted ${feed}. Search Console reads it on its own schedule; submitting again does not speed that up.` };
		} catch (e) {
			if (e instanceof SubmitRefused) return fail(400, { error: e.message });
			throw e;
		}
	},
	sitemapResubmit: async ({ params }) => {
		const site = getSite(Number(params.id))!;
		try {
			const r = await resubmitSitemaps(site, 'app');
			if (!r.submitted.length && !r.failed.length) return fail(400, { error: 'Search Console lists no sitemap for this site yet: submit one first.' });
			return r.failed.length ? fail(502, { error: `Resubmitted ${r.submitted.length}; ${r.failed.length} failed: ${r.failed[0].error}` }) : { ok: `Resubmitted ${r.submitted.length} sitemap${r.submitted.length === 1 ? '' : 's'}.` };
		} catch (e) {
			if (e instanceof SubmitRefused) return fail(400, { error: e.message });
			throw e;
		}
	},
	/** Fetch a sitemap like a crawler and compare it with what Google reported. Read-only, so allowed in READ_ONLY mode. */
	sitemapCheck: async ({ params, request }) => {
		const feed = String((await request.formData()).get('feed') ?? '').trim();
		if (!/^https?:\/\/\S+$/.test(feed)) return fail(400, { error: 'Not a sitemap address.' });
		const { client, site } = clientForSite(Number(params.id));
		const google = (await client.listSitemaps(site.site_url).catch(() => [])).find((s) => s.path === feed);
		const demo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number }).is_demo;
		return { check: await diagnoseSitemap(feed, site.site_url, google, demo ? demoSitemapFetch(site.id) : undefined) };
	},
	check: async ({ params }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: starting checks is disabled.' });
		if (!enqueueIndexMonitor(Number(params.id))) return fail(409, { error: 'A check is already running for this site.' });
		return { ok: 'Checking in the background (watched and submitted URLs first). Reload in a minute.' };
	}
};
