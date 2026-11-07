import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { brandTerms, fittedCurve, periodFor, queryPageRows, topQueries } from '$lib/server/queries';
import { computeCtrGaps, computeStriking, isBranded } from '$lib/analytics';
import { hiddenReport } from '$lib/server/hidden';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const qp = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	// Scale thresholds with the window so a 7-day view is not starved of rows.
	const minImpr = Math.max(10, Math.round((days / 28) * 30));
	const striking = computeStriking(topQueries(site.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: minImpr });
	const ctrGaps = computeCtrGaps(qp.filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: Math.max(50, minImpr * 3) });
	return {
		hidden: hiddenReport(site, days),
		striking,
		ctrGaps,
		curve: { values: curve.curve.slice(1, 11), fitted: curve.fitted.slice(1, 11), source: curve.source }
	};
};
