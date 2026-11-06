import type { PageServerLoad } from './$types';
import { portfolioQueue } from '$lib/server/actions';
import { scoreOf } from '$lib/actions';

export const load: PageServerLoad = () => ({ items: portfolioQueue(40).map((a) => ({ ...a, score: Math.round(scoreOf(a)) })) });
