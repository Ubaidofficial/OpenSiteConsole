import type { PageServerLoad } from './$types';
import { daysParam } from '$lib/server/params';
import { portfolioAnomalies, portfolioCannibalization, portfolioDecay, portfolioStriking } from '$lib/server/portfolio';

export const load: PageServerLoad = ({ url }) => {
	const days = daysParam(url);
	const tab = ['striking', 'cannibalization', 'decay', 'anomalies'].includes(url.searchParams.get('tab') ?? '') ? url.searchParams.get('tab')! : 'striking';
	const rows =
		tab === 'striking' ? portfolioStriking(days) : tab === 'cannibalization' ? portfolioCannibalization(days) : tab === 'decay' ? portfolioDecay(days) : portfolioAnomalies(days);
	return { days, tab, rows };
};
