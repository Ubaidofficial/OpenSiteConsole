import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { countryCannibalReport, groupsReport, heatmapReport, localesReport } from '$lib/server/insights';
import { brandTerms } from '$lib/server/queries';

const VIEWS = ['folders', 'topics', 'heatmap', 'locales'] as const;

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const v = url.searchParams.get('view') as (typeof VIEWS)[number];
	const view = VIEWS.includes(v) ? v : 'folders';
	const depth = Math.min(4, Math.max(1, Number(url.searchParams.get('depth')) || 1));
	const by = url.searchParams.get('by') === 'page' ? ('page' as const) : ('group' as const);
	const base = { view, days, depth, by, brandTerms: brandTerms(site) };
	if (view === 'heatmap') return { ...base, heatmap: heatmapReport(site, by, depth) };
	if (view === 'locales') return { ...base, locales: localesReport(site, days), cannibal: countryCannibalReport(site, days, 100) };
	const g = groupsReport(site, days, depth);
	return { ...base, comparable: g.comparable, reason: g.reason, groups: g.groups, topics: g.topics };
};
