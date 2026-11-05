import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { periodFor, topPages } from '$lib/server/queries';
import { ctrOf, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const prev = new Map(topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000).map((r) => [r.page, r]));
	return {
		rows: topPages(site.id, p.start, p.end, {}, 5000).map((r) => ({
			page: r.page,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.page)?.clicks ?? 0)
		}))
	};
};
