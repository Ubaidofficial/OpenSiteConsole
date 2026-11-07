import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { quickWins } from '$lib/server/quickwins';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	return quickWins(getSite(Number(params.id))!, days);
};
