import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSite } from '$lib/server/clients';
import { submissionsCsv } from '$lib/server/submission';

/** The "what happened to submitted URLs" table as a spreadsheet: one row per URL, with the verdict after 5 days. */
export const GET: RequestHandler = ({ params }) => {
	const site = getSite(Number(params.id));
	if (!site) error(404);
	const name = `${site.site_url.replace(/[^a-z0-9.-]+/gi, '_')}-submissions-${new Date().toISOString().slice(0, 10)}.csv`;
	return new Response('\uFEFF' + submissionsCsv(site.id), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` } });
};
