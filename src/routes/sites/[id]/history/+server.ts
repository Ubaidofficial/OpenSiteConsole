import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { fillDays, pageHistory, queryHistory, siteEnd } from '$lib/server/queries';
import { db } from '$lib/server/db';

/**
 * kind=split: for one search, each competing page's position week by week (impression-weighted), over the last 16 weeks. Used by the
 * Cannibalization tab to show whether the pages take turns (Google cannot decide) or one is steadily winning.
 */
function splitHistory(siteId: number, query: string, pages: string[], end: string) {
	const WEEKS = 16;
	const start = addDays(end, -(WEEKS * 7 - 1));
	const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(start, i * 7));
	const list = pages.slice(0, 4);
	if (!list.length) return { weeks, pages: [] };
	const rows = db().prepare(`SELECT page, date, SUM(impressions) i, SUM(position * impressions) pw FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ? AND page IN (${list.map(() => '?').join(',')}) GROUP BY page, date`).all(siteId, query, start, end, ...list) as { page: string; date: string; i: number; pw: number }[];
	const acc = new Map(list.map((p) => [p, weeks.map(() => ({ i: 0, pw: 0 }))]));
	for (const r of rows) {
		const w = Math.floor((Date.parse(r.date) - Date.parse(start)) / (7 * 86_400_000));
		if (w >= 0 && w < WEEKS) { const c = acc.get(r.page)![w]; c.i += r.i; c.pw += r.pw; }
	}
	return { weeks, pages: list.map((p) => ({ page: p, positions: acc.get(p)!.map((c) => (c.i ? c.pw / c.i : null)) })) };
}

export const GET: RequestHandler = ({ params, url }) => {
	const site = getSite(Number(params.id));
	if (!site) return json([], { status: 404 });
	const kind = url.searchParams.get('kind');
	const value = url.searchParams.get('value') ?? '';
	const end = siteEnd(site);
	const start = addDays(end, -Math.min(600, Number(url.searchParams.get('days')) || 480));
	if (kind === 'split') return json(splitHistory(site.id, value, url.searchParams.getAll('page'), end));
	if (kind === 'pages') {
		// which of the site's pages rank for one search, over the selected period
		const from = addDays(end, -(Math.min(480, Number(url.searchParams.get('period')) || 28) - 1));
		return json(db().prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) * 1.0 / NULLIF(SUM(impressions), 0) position FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ? GROUP BY page ORDER BY impressions DESC LIMIT 10').all(site.id, value, from, end));
	}
	return json(fillDays(kind === 'page' ? pageHistory(site.id, value, start, end) : queryHistory(site.id, value, start, end), start, end));
};
