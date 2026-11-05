import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { daysParam, intParam } from '$lib/server/params';
import { portfolioTotals, siteCards } from '$lib/server/queries';
import { enqueueSiteSync } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { listAccounts, syncAccountSites } from '$lib/server/accounts';
import { displayName } from '$lib/server/clients';
import { ctrOf, pctChangeMin, positionShift } from '$lib/analytics';
import { allLinks } from '$lib/server/links';
import { hideCoveredDuplicates, hideableDuplicates, purgeRemovedSite } from '$lib/server/duplicates';

export const load: PageServerLoad = ({ url }) => {
	const days = daysParam(url);
	const showHidden = url.searchParams.get('hidden') === '1';
	const cards = siteCards(days, { includeHidden: showHidden });
	const totals = portfolioTotals(cards.filter((c) => !c.site.hidden && c.site.permission !== 'none'));
	const links = allLinks();
	const has = (id: number, k: string) => links.some((l) => l.site_id === id && l.kind === k);
	return {
		days,
		showHidden,
		totals: {
			clicks: totals.now.clicks,
			impressions: totals.now.impressions,
			position: totals.now.position,
			comparable: totals.comparable,
			loading: totals.loading,
			clicksDelta: totals.comparable ? pctChangeMin(totals.now.clicks, totals.prev.clicks, 10) : null,
			impressionsDelta: totals.comparable ? pctChangeMin(totals.now.impressions, totals.prev.impressions, 100) : null,
			ctr: ctrOf(totals.now),
			ctrDelta: totals.comparable && totals.prev.impressions >= 100 && totals.now.impressions >= 100 ? pctChangeMin(ctrOf(totals.now), ctrOf(totals.prev), 1e-9) : null,
			positionDelta: totals.comparable ? positionShift(totals.now, totals.prev) : null,
			sites: totals.sites,
			duplicates: totals.duplicates
		},
		duplicates: hideableDuplicates().map((d) => ({ id: d.id, name: displayName(d.url) })),
		accounts: listAccounts().map((a) => ({ id: a.id, label: a.label ?? a.email, status: a.status })),
		cards: cards.map((c) => ({
			id: c.site.id,
			name: displayName(c.site.site_url),
			href: c.site.site_url.startsWith('sc-domain:') ? `https://${c.site.site_url.slice(10)}/` : c.site.site_url,
			label: c.site.label,
			tags: c.site.tags ? c.site.tags.split(',').filter(Boolean) : [],
			account: c.site.account_label ?? c.site.account_email,
			accountId: c.site.account_id,
			permission: c.site.permission,
			hidden: !!c.site.hidden,
			removed: c.site.permission === 'none',
			coveredBy: c.coveredBy ? (cards.find((x) => x.site.id === c.coveredBy)?.site.site_url ?? null) : null,
			connected: { bing: has(c.site.id, 'bing'), ga4: has(c.site.id, 'ga4'), clarity: has(c.site.id, 'clarity'), openseo: has(c.site.id, 'openseo') },
			syncStatus: c.site.sync_status,
			syncMessage: c.site.sync_message,
			lastSync: c.site.last_sync_at,
			backfillDone: !!c.site.backfill_done,
			hasData: !!c.site.synced_through,
			end: c.period.end,
			clicks: c.now.clicks,
			impressions: c.now.impressions,
			ctr: ctrOf(c.now),
			position: c.now.position,
			comparable: c.comparable,
			clicksDelta: c.comparable ? pctChangeMin(c.now.clicks, c.prev.clicks, 10) : null,
			impressionsDelta: c.comparable ? pctChangeMin(c.now.impressions, c.prev.impressions, 100) : null,
			ctrDelta: c.comparable && c.prev.impressions >= 100 && c.now.impressions >= 100 ? pctChangeMin(ctrOf(c.now), ctrOf(c.prev), 1e-9) : null,
			positionDelta: c.comparable ? positionShift(c.now, c.prev) : null,
			spark: c.spark
		}))
	};
};

export const actions: Actions = {
	syncAll: async () => {
		// Re-read each account's property list from Google first, so properties you removed in Search Console
		// drop off the dashboard and newly added ones appear. Without this only data for known sites is refreshed.
		const noneBefore = (db().prepare("SELECT COUNT(*) n FROM sites WHERE permission = 'none'").get() as { n: number }).n;
		const accs = db().prepare("SELECT id FROM accounts WHERE status = 'active'").all() as { id: number }[];
		let listError: string | null = null;
		for (const a of accs) {
			try {
				await syncAccountSites(a.id);
			} catch (e) {
				listError = e instanceof Error ? e.message : 'Could not refresh the property list';
			}
		}
		const removed = Math.max(0, (db().prepare("SELECT COUNT(*) n FROM sites WHERE permission = 'none'").get() as { n: number }).n - noneBefore);
		const sites = db()
			.prepare("SELECT s.id FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.hidden = 0 AND a.status = 'active' AND s.permission NOT IN ('siteUnverifiedUser','none')")
			.all() as { id: number }[];
		let n = 0;
		for (const s of sites) if (enqueueSiteSync(s.id, 'auto')) n++;
		return { queued: n, removed, listError };
	},
	hideDuplicates: async () => ({ hidden: hideCoveredDuplicates() }),
	purgeRemoved: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			if (!purgeRemovedSite(id)) return fail(400, { error: 'Only properties removed from Search Console can be deleted here.' });
			return { ok: 'Deleted the stored data for that removed property.' };
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	},
	toggleHidden: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			db().prepare('UPDATE sites SET hidden = 1 - hidden WHERE id = ?').run(id);
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	}
};
