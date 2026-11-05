import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { daysParam, intParam } from '$lib/server/params';
import { portfolioTotals, siteCards } from '$lib/server/queries';
import { enqueueSiteSync } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { listAccounts } from '$lib/server/accounts';
import { displayName } from '$lib/server/clients';
import { ctrOf, pctChange } from '$lib/analytics';
import { allLinks } from '$lib/server/links';
import { hideCoveredDuplicates, hideableDuplicates } from '$lib/server/duplicates';

export const load: PageServerLoad = ({ url }) => {
	const days = daysParam(url);
	const showHidden = url.searchParams.get('hidden') === '1';
	const cards = siteCards(days, { includeHidden: showHidden });
	const totals = portfolioTotals(cards.filter((c) => !c.site.hidden));
	const links = allLinks();
	const has = (id: number, k: string) => links.some((l) => l.site_id === id && l.kind === k);
	return {
		days,
		showHidden,
		totals: {
			clicks: totals.now.clicks,
			impressions: totals.now.impressions,
			position: totals.now.position,
			clicksDelta: pctChange(totals.now.clicks, totals.prev.clicks),
			impressionsDelta: pctChange(totals.now.impressions, totals.prev.impressions),
			ctr: ctrOf(totals.now),
			ctrDelta: pctChange(ctrOf(totals.now), ctrOf(totals.prev)),
			positionDelta: pctChange(totals.now.position, totals.prev.position),
			sites: totals.sites,
			duplicates: totals.duplicates
		},
		duplicates: hideableDuplicates().map((d) => ({ id: d.id, name: displayName(d.url) })),
		accounts: listAccounts().map((a) => ({ id: a.id, label: a.label ?? a.email, status: a.status })),
		cards: cards.map((c) => ({
			id: c.site.id,
			name: displayName(c.site.site_url),
			label: c.site.label,
			tags: c.site.tags ? c.site.tags.split(',').filter(Boolean) : [],
			account: c.site.account_label ?? c.site.account_email,
			accountId: c.site.account_id,
			permission: c.site.permission,
			hidden: !!c.site.hidden,
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
			clicksDelta: pctChange(c.now.clicks, c.prev.clicks),
			impressionsDelta: pctChange(c.now.impressions, c.prev.impressions),
			ctrDelta: pctChange(ctrOf(c.now), ctrOf(c.prev)),
			positionDelta: pctChange(c.now.position, c.prev.position),
			spark: c.spark
		}))
	};
};

export const actions: Actions = {
	syncAll: async () => {
		const sites = db()
			.prepare("SELECT s.id FROM sites s JOIN accounts a ON a.id = s.account_id WHERE s.hidden = 0 AND a.status = 'active' AND s.permission NOT IN ('siteUnverifiedUser','none')")
			.all() as { id: number }[];
		let n = 0;
		for (const s of sites) if (enqueueSiteSync(s.id, 'auto')) n++;
		return { queued: n };
	},
	hideDuplicates: async () => ({ hidden: hideCoveredDuplicates() }),
	toggleHidden: async ({ request }) => {
		try {
			const id = intParam((await request.formData()).get('id'));
			db().prepare('UPDATE sites SET hidden = 1 - hidden WHERE id = ?').run(id);
		} catch {
			return fail(400, { error: 'Invalid site' });
		}
	}
};
