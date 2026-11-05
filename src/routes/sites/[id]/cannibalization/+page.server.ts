import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { brandTerms, fittedCurve, periodFor, queryPageRows } from '$lib/server/queries';
import { computeCannibalization } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const rows = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(rows, brandTerms(site));
	return { groups: computeCannibalization(rows, curve, { minQueryImpressions: Math.max(20, Math.round((days / 28) * 40)) }) };
};
