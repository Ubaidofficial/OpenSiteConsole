import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { db } from '$lib/server/db';
import { config } from '$lib/server/config';
import { addWatch, indexHistory, indexSummary, recentEvents, removeWatch, watchList } from '$lib/server/indexmon';
import { hostAllowed } from '$lib/server/onpage';
import { sitemapCoverage, syncSitemapUrls } from '$lib/server/sitemapcov';
import { autoSubmit } from '$lib/server/indexnow';
import { urlClassesReport } from '$lib/server/insights';
import { enqueueIndexMonitor } from '$lib/server/jobs';
import { EVENT_SEVERITY } from '$lib/indexing';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const u = urlClassesReport(site, days);
	return {
		days,
		monitoring: !!site.index_monitor,
		checkedOn: site.index_checked_on,
		message: site.index_message,
		nextAt: site.index_next_at,
		watch: watchList(site.id),
		history: indexHistory(site.id),
		coverage: sitemapCoverage(site),
		perRun: config.indexMonitorUrls,
		summary: indexSummary(site.id),
		events: recentEvents(site.id, 60).map((e) => ({ ...e, severity: EVENT_SEVERITY[e.kind as keyof typeof EVENT_SEVERITY] ?? 'warn' })),
		classes: { comparable: u.comparable, reason: u.reason, counts: u.counts, lost: u.lostClicks, rows: u.rows.slice(0, 500) }
	};
};

export const actions: Actions = {
	sitemapRefresh: async ({ params }) => {
		const r = await syncSitemapUrls(Number(params.id));
		const s = getSite(Number(params.id));
		if (s) await autoSubmit(s, r.changes).catch(() => {});
		if (r.urls === 0) return fail(502, { error: r.error ?? 'No sitemap URLs were found. Submit a sitemap in Search Console first (Sitemaps tab).' });
		return { ok: `Read ${r.sitemaps} sitemap file${r.sitemaps === 1 ? '' : 's'}: ${r.urls.toLocaleString('en-US')} URLs${r.truncated ? ' (cut off at the limit)' : ''}${r.error ? `. A problem: ${r.error}` : ''}.` };
	},
	watchAdd: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const all = String((await request.formData()).get('urls') ?? '').split(/\s+/).filter((u) => /^https?:\/\/\S+$/.test(u));
		const urls = all.filter((u) => hostAllowed(u, site.site_url));
		if (!urls.length) return fail(400, { error: 'Paste full URLs that belong to this site, one per line.' });
		addWatch(site.id, urls);
		return { ok: `Watching ${urls.length} URL${urls.length === 1 ? '' : 's'}; they are checked before anything else.${urls.length < all.length ? ` ${all.length - urls.length} skipped: not on this site.` : ''}` };
	},
	watchRemove: async ({ params, request }) => {
		removeWatch(Number(params.id), String((await request.formData()).get('url') ?? ''));
		return { ok: 'Removed from the watch list.' };
	},
	toggle: async ({ params, request }) => {
		const on = (await request.formData()).get('on') === '1';
		db().prepare('UPDATE sites SET index_monitor = ? WHERE id = ?').run(on ? 1 : 0, Number(params.id));
		if (on) enqueueIndexMonitor(Number(params.id));
		return { ok: on ? 'Monitoring switched on. The first check is running in the background.' : 'Monitoring switched off. Stored results are kept.' };
	},
	check: async ({ params }) => {
		if (!enqueueIndexMonitor(Number(params.id))) return fail(409, { error: 'A check is already running for this site.' });
		return { ok: 'Checking in the background. Reload in a minute.' };
	}
};
