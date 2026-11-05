import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { breakdown, brandTerms, periodFor, topQueries } from '$lib/server/queries';
import { ctrOf, isBranded, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const f = { country: url.searchParams.get('country') || undefined, device: url.searchParams.get('device') || undefined };
	const b = url.searchParams.get('b') ?? 'all';
	const terms = brandTerms(site);
	const prev = new Map(topQueries(site.id, p.prevStart, p.prevEnd, f, 20_000).map((r) => [r.query, r]));
	const rows = topQueries(site.id, p.start, p.end, f, 5000)
		.map((r) => ({
			query: r.query,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.query)?.clicks ?? 0),
			posChange: prev.has(r.query) ? r.position - prev.get(r.query)!.position : null,
			branded: isBranded(r.query, terms)
		}))
		.filter((r) => (b === 'brand' ? r.branded : b === 'nonbrand' ? !r.branded : true));
	return {
		rows,
		b,
		filters: f,
		countries: breakdown(site.id, p.start, p.end, 'country').map((c) => c.key),
		devices: breakdown(site.id, p.start, p.end, 'device').map((c) => c.key),
		brandTerms: terms
	};
};
