import type { PageServerLoad } from './$types';
import { COMPETITORS, CHECKED_ON, DEFAULT_HOSTED_PRICE, REPO_URL } from '$lib/compare';
import { env } from '$lib/server/config';

export const load: PageServerLoad = () => ({
	hosted: env('COMPARE_HOSTED_PRICE', DEFAULT_HOSTED_PRICE),
	repo: REPO_URL,
	checkedOn: CHECKED_ON,
	tools: COMPETITORS.map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb, price: c.price, weWin: c.weWin[0], theyWin: c.theyWin[0], shot: c.shots[0] }))
});
