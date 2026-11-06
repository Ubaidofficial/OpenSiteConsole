import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { forecastReport, trajectories, trendsReport } from '$lib/server/insights';
import { brandTerms } from '$lib/server/queries';

const VIEWS = ['movers', 'new', 'bands', 'questions', 'trajectories', 'forecast'] as const;
export type TrendView = (typeof VIEWS)[number];

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const v = url.searchParams.get('view') as TrendView;
	const view: TrendView = VIEWS.includes(v) ? v : 'movers';
	// Each view computes only what it shows: these reports read a lot of rows.
	const terms = brandTerms(site);
	if (view === 'trajectories') return { view, days, brandTerms: terms, trajectories: trajectories(site, 25) };
	if (view === 'forecast') return { view, days, brandTerms: terms, forecast: forecastReport(site) };
	const t = trendsReport(site, days, 40);
	return { view, days, brandTerms: terms, comparable: t.comparable, reason: t.reason, period: t.period, movers: { queries: t.queryMovers, pages: t.pageMovers }, added: t.newQueries, lost: t.lostQueries, bands: t.bands, questions: t.questions };
};
