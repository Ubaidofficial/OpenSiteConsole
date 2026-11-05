import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { fillDays, pageHistory, queryHistory, siteEnd } from '$lib/server/queries';

export const GET: RequestHandler = ({ params, url }) => {
	const site = getSite(Number(params.id));
	if (!site) return json([], { status: 404 });
	const kind = url.searchParams.get('kind');
	const value = url.searchParams.get('value') ?? '';
	const end = siteEnd(site);
	const start = addDays(end, -Math.min(600, Number(url.searchParams.get('days')) || 480));
	return json(fillDays(kind === 'page' ? pageHistory(site.id, value, start, end) : queryHistory(site.id, value, start, end), start, end));
};
