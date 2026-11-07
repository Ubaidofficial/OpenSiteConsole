import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { bySlug, DEFAULT_HOSTED_PRICE, REPO_URL } from '$lib/compare';
import { env } from '$lib/server/config';

export const load: PageServerLoad = ({ params }) => {
	const c = bySlug(params.slug);
	if (!c) error(404, 'No such comparison');
	return { c, hosted: env('COMPARE_HOSTED_PRICE', DEFAULT_HOSTED_PRICE), repo: REPO_URL };
};
