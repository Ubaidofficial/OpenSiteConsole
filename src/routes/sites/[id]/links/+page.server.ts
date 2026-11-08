import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { groupByTarget, linkReport, pagesToCrawl, setLinkDone } from '$lib/server/internallinks';
import { enqueueLinkCrawl } from '$lib/server/jobs';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const r = linkReport(getSite(Number(params.id))!, days);
	return {
		days,
		maxPages: config.linkCrawlPages,
		crawl: r.crawl,
		summary: { pagesCrawled: r.pagesCrawled, pagesFailed: r.pagesFailed, linksFound: r.linksFound, targets: r.targets, suggestions: r.suggestions.length, orphans: r.orphans.length },
		groups: groupByTarget(r.suggestions),
		done: r.done,
		orphans: r.orphans.slice(0, 50)
	};
};

export const actions: Actions = {
	/** Start a crawl in the background; the page polls until it has finished. */
	crawl: async ({ params }) => {
		const site = getSite(Number(params.id))!;
		if (!pagesToCrawl(site, 1).length) return fail(400, { error: 'No page data yet: let the first sync finish.' });
		enqueueLinkCrawl(site.id);
		return { ok: 'Crawl started.' };
	},
	/** Hide a suggestion (source and target) because the link has been added, or put it back with undo=1. */
	done: async ({ params, request }) => {
		const f = await request.formData();
		const key = String(f.get('key') ?? '');
		if (!key || key.length > 2000) return fail(400, { error: 'Nothing selected.' });
		const undo = f.get('undo') === '1';
		setLinkDone(Number(params.id), key, !undo);
		return { ok: undo ? 'Put back in the list.' : 'Marked done.' };
	}
};
