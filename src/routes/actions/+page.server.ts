import type { PageServerLoad } from './$types';
import { portfolioQueue } from '$lib/server/actions';
import { scoreOf } from '$lib/actions';

// 100 rather than 40: the page filters by site and type on the client, so a filter should not come up empty because the list was cut first.
export const load: PageServerLoad = () => ({ items: portfolioQueue(100).map((a) => ({ ...a, score: Math.round(scoreOf(a)) })) });
