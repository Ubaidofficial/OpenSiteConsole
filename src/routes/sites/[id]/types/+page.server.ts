import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { appearanceFor, periodFor, typeBreakdown, typeSeries } from '$lib/server/queries';
import { ctrOf, pctChangeMin } from '$lib/analytics';
import { ALL_TYPES } from '$lib/searchTypes';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const now = typeBreakdown(site.id, p.start, p.end);
	const prev = typeBreakdown(site.id, p.prevStart, p.prevEnd);
	const series = typeSeries(site.id, p.start, p.end);
	const total = ALL_TYPES.reduce((a, t) => a + (now[t]?.clicks ?? 0), 0);
	const types = ALL_TYPES.map((t) => {
		const n = now[t];
		const pv = prev[t];
		return {
			type: t,
			has: !!n && (n.clicks > 0 || n.impressions > 0),
			clicks: n?.clicks ?? 0,
			impressions: n?.impressions ?? 0,
			ctr: n ? ctrOf(n) : 0,
			position: n?.position ?? 0,
			share: total ? (n?.clicks ?? 0) / total : 0,
			clicksDelta: n && pv ? pctChangeMin(n.clicks, pv.clicks, 10) : null,
			spark: series[t]
		};
	});
	const appearance = appearanceFor(site.id, days);
	return { types, appearance, typesPulled: !!site.types_synced_at };
};
