import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSite } from '$lib/server/clients';
import { daysParam } from '$lib/server/params';
import { periodFor, topPages, topQueries } from '$lib/server/queries';
import { ctrOf } from '$lib/analytics';

/** Spreadsheet formula injection: a cell starting with = + - @ is executed by Excel/Sheets. */
const cell = (v: string | number) => {
	const s = String(v);
	const safe = /^[=+\-@\t\r]/.test(s) && typeof v === 'string' ? `'${s}` : s;
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export const GET: RequestHandler = ({ params, url }) => {
	const site = getSite(Number(params.id));
	if (!site) error(404);
	const days = daysParam(url);
	const p = periodFor(site, days);
	const dim = url.searchParams.get('dim') === 'page' ? 'page' : 'query';
	const rows = dim === 'page' ? topPages(site.id, p.start, p.end, {}, 100_000) : topQueries(site.id, p.start, p.end, {}, 100_000);
	const lines = [[dim, 'clicks', 'impressions', 'ctr', 'position'].join(',')];
	for (const r of rows) {
		lines.push([cell((r as never)[dim]), r.clicks, r.impressions, ctrOf(r).toFixed(4), r.position.toFixed(2)].map(cell).join(','));
	}
	const name = `${site.site_url.replace(/[^a-z0-9.-]+/gi, '_')}-${dim}s-${p.start}_${p.end}.csv`;
	return new Response('﻿' + lines.join('\r\n'), {
		headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"` }
	});
};
