import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { pageTotals, periodFor, summary } from '$lib/server/queries';
import { computeDecay, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const now = summary(site.id, p.start, p.end);
	const prev = summary(site.id, p.prevStart, p.prevEnd);
	const siteDelta = pctChange(now.clicks, prev.clicks) ?? 0;
	// Same weekdays one year earlier (364 days), only if we actually hold that history.
	const yStart = addDays(p.start, -364);
	const hasYear = !!site.backfilled_to && site.backfilled_to <= yStart;
	const year = hasYear ? pageTotals(site.id, yStart, addDays(p.end, -364)) : null;
	return {
		siteDelta,
		hasYear,
		rows: computeDecay(pageTotals(site.id, p.start, p.end), pageTotals(site.id, p.prevStart, p.prevEnd), siteDelta, year, { minPrevClicks: Math.max(10, Math.round((days / 28) * 20)) })
	};
};
