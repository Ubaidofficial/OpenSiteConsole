import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { forecastReport, trajectories, trendsReport } from '$lib/server/insights';

const VIEWS = ['movers', 'new', 'bands', 'questions', 'trajectories', 'forecast'] as const;
export type TrendView = (typeof VIEWS)[number];

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const v = url.searchParams.get('view') as TrendView;
	const view: TrendView = VIEWS.includes(v) ? v : 'movers';
	// Each view computes only what it shows: these reports read a lot of rows.
	if (view === 'trajectories') return { view, days, trajectories: trajectories(site, 25) };
	if (view === 'forecast') return { view, days, forecast: forecastReport(site) };
	const t = trendsReport(site, days, 40);
	return { view, days, period: t.period, movers: { queries: t.queryMovers, pages: t.pageMovers }, added: t.newQueries, lost: t.lostQueries, bands: t.bands, questions: t.questions };
};
