import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { breakdown, periodFor } from '$lib/server/queries';
import { ctrOf, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const shape = (dim: 'country' | 'device') => {
		const prev = new Map(breakdown(site.id, p.prevStart, p.prevEnd, dim).map((r) => [r.key, r]));
		return breakdown(site.id, p.start, p.end, dim).map((r) => ({
			key: dim === 'country' ? r.key.toUpperCase() : r.key,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.key)?.clicks ?? 0)
		}));
	};
	return { countries: shape('country'), devices: shape('device') };
};
