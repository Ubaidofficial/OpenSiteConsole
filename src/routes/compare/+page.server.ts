import type { PageServerLoad } from './$types';
import { COMPETITORS, CHECKED_ON, DEFAULT_HOSTED_PRICE, REPO_URL } from '$lib/compare';
import { env } from '$lib/server/config';

export const load: PageServerLoad = () => ({
	hosted: env('COMPARE_HOSTED_PRICE', DEFAULT_HOSTED_PRICE),
	repo: REPO_URL,
	// the days the competitors' pages were read (newer entries were added later)
	checkedOn: [...new Set([CHECKED_ON, ...COMPETITORS.map((c) => c.checkedOn)])].sort().join(' and '),
	tools: COMPETITORS.map((c) => ({ slug: c.slug, name: c.name, blurb: c.blurb, price: c.price, weWin: c.weWin[0], theyWin: c.theyWin[0], shot: c.shots[0] }))
});
