import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { decayReport } from '$lib/server/decay';

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	return decayReport(getSite(Number(params.id))!, days, url.searchParams.get('mode') === 'yoy' ? 'yoy' : 'period');
};
