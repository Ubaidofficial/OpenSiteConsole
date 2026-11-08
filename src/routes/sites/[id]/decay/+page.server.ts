import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { decayReport } from '$lib/server/decay';
import { db } from '$lib/server/db';
import { addDays } from '$lib/server/dates';
import { periodFor } from '$lib/server/queries';

const WEEKS = 16;

/**
 * Weekly clicks for the site's biggest pages over the last 16 weeks (plus any page flagged as decaying), for the decay map. Each row
 * is later scaled to its own best week, so a slow slide shows as a row fading out whatever the page's size.
 */
function decayMap(siteId: number, end: string, flagged: string[]) {
	const start = addDays(end, -(WEEKS * 7 - 1));
	const top = (db().prepare('SELECT page, SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page ORDER BY c DESC LIMIT 15').all(siteId, start, end) as { page: string; c: number }[]).map((r) => r.page);
	const pages = [...new Set([...flagged, ...top])].slice(0, 20);
	if (!pages.length) return { weeks: [] as string[], rows: [] as { page: string; flagged: boolean; clicks: number[] }[] };
	const weeks = Array.from({ length: WEEKS }, (_, i) => addDays(start, i * 7));
	const at = new Map(pages.map((p) => [p, Array(WEEKS).fill(0) as number[]]));
	const rows = db().prepare(`SELECT page, date, SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND page IN (${pages.map(() => '?').join(',')}) GROUP BY page, date`).all(siteId, start, end, ...pages) as { page: string; date: string; c: number }[];
	for (const r of rows) {
		const w = Math.floor((Date.parse(r.date) - Date.parse(start)) / (7 * 86_400_000));
		if (w >= 0 && w < WEEKS) at.get(r.page)![w] += r.c;
	}
	const set = new Set(flagged);
	return { weeks, rows: pages.map((p) => ({ page: p, flagged: set.has(p), clicks: at.get(p)! })) };
}

export const load: PageServerLoad = async ({ params, parent, url }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const report = decayReport(site, days, url.searchParams.get('mode') === 'yoy' ? 'yoy' : 'period');
	return { ...report, map: decayMap(site.id, periodFor(site, days).end, report.rows.map((r) => r.page)) };
};
