import { db } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { brandTerms, dailySeries, fittedCurve, pageTotals, periodFor, queryHistory, queryPageRows, topPages, topQueries } from './queries';
import { ctrOf, isBranded, pctChange } from '../analytics';
import { buildHeatmap, completeMonths, countryCannibalization, groupPages, localeReport, topicClusters, urlSection } from '../groups';
import { classifyUrl, indexState, type UrlClass } from '../indexing';
import { computeMovers, isQuestionQuery, newAndLost, positionBands, projectClicks, trajectoryOf, weeklyTotals, type Keyed } from '../trends';
import { AI_ASSISTANTS } from '../ai';
import { linksFor } from './links';

type Site = Pick<SiteRow, 'id' | 'synced_through' | 'site_url' | 'brand_terms' | 'backfilled_to' | 'backfill_done'>;
const r2 = (n: number) => Math.round(n * 100) / 100;
const keyedQ = (rows: { query: string; clicks: number; impressions: number; position: number }[]): Keyed[] => rows.map((r) => ({ key: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position }));
const keyedP = (rows: { page: string; clicks: number; impressions: number; position: number }[]): Keyed[] => rows.map((r) => ({ key: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position }));

// ── Trends ───────────────────────────────────────────────────────────────────
export function trendsReport(site: Site, days: number, limit = 25) {
	const p = periodFor(site, days);
	const qNow = topQueries(site.id, p.start, p.end, {}, 100_000);
	const qPrev = topQueries(site.id, p.prevStart, p.prevEnd, {}, 100_000);
	const pNow = topPages(site.id, p.start, p.end, {}, 50_000);
	const pPrev = topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000);
	const terms = brandTerms(site);
	const nonBrand = (rows: typeof qNow) => rows.filter((r) => !isBranded(r.query, terms));
	const nl = newAndLost(keyedQ(qNow), keyedQ(qPrev), { limit });
	const prevByQuery = new Map(qPrev.map((r) => [r.query, r]));
	const questions = qNow.filter((r) => isQuestionQuery(r.query));
	const qClicks = qNow.reduce((a, r) => a + r.clicks, 0);
	const qImpr = qNow.reduce((a, r) => a + r.impressions, 0);
	return {
		period: p,
		queryMovers: computeMovers(keyedQ(qNow), keyedQ(qPrev), { limit }),
		pageMovers: computeMovers(keyedP(pNow), keyedP(pPrev), { limit }),
		newQueries: nl.added,
		lostQueries: nl.lost,
		bands: { now: positionBands(nonBrand(qNow)), prev: positionBands(nonBrand(qPrev)) },
		questions: {
			count: questions.length,
			clickShare: qClicks ? questions.reduce((a, r) => a + r.clicks, 0) / qClicks : 0,
			impressionShare: qImpr ? questions.reduce((a, r) => a + r.impressions, 0) / qImpr : 0,
			rows: questions.slice(0, limit).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: ctrOf(r), position: r.position, clicksDelta: pctChange(r.clicks, prevByQuery.get(r.query)?.clicks ?? 0) }))
		}
	};
}

const WEEKS_HISTORY = 26;

/** Weekly site clicks for the last `WEEKS_HISTORY` complete weeks, a projection, and the same weeks a year earlier if stored. */
export function forecastReport(site: Site, horizon = 8) {
	const end = site.synced_through ?? addDays(new Date().toISOString().slice(0, 10), -2);
	const start = addDays(end, -(7 * WEEKS_HISTORY) - 365);
	const days = dailySeries(site.id, start, end, false);
	const weekly = weeklyTotals(days, end, WEEKS_HISTORY);
	const projection = projectClicks(weekly, horizon);
	// Same calendar weeks last year, for the projected weeks: a rough read on seasonality the projection does not model.
	let lastYear: { weekEnd: string; clicks: number }[] | null = null;
	if (projection) {
		const byDate = new Map(days.map((d) => [d.date, d.clicks]));
		const out = projection.points.map((pt) => {
			const we = addDays(pt.weekEnd, -364);
			let have = 0;
			let clicks = 0;
			for (let i = 0; i < 7; i++) {
				const v = byDate.get(addDays(we, -i));
				if (v !== undefined) (have++, (clicks += v));
			}
			return { weekEnd: we, clicks, have };
		});
		lastYear = out.every((o) => o.have === 7) ? out.map(({ weekEnd, clicks }) => ({ weekEnd, clicks })) : null;
	}
	return { weekly, projection, lastYear };
}

/** Direction of the weekly clicks of the site's biggest queries over the last 12 weeks. */
export function trajectories(site: Site, n = 15) {
	const end = site.synced_through ?? addDays(new Date().toISOString().slice(0, 10), -2);
	const p = periodFor(site, 84);
	return topQueries(site.id, p.start, end, {}, n).map((q) => {
		const w = weeklyTotals(queryHistory(site.id, q.query, addDays(end, -84), end), end, 12);
		const t = trajectoryOf(w.map((x) => x.clicks));
		return { query: q.query, clicks: q.clicks, direction: t.direction, weeklyChangePct: t.weeklyChangePct == null ? null : r2(t.weeklyChangePct * 100), weekly: w.map((x) => x.clicks) };
	});
}

// ── Groups, topics, heatmap, locales ─────────────────────────────────────────
export function groupsReport(site: Site, days: number, depth = 1) {
	const p = periodFor(site, days);
	const groups = groupPages(pageTotals(site.id, p.start, p.end, 50_000), pageTotals(site.id, p.prevStart, p.prevEnd, 50_000), depth);
	const terms = brandTerms(site);
	const topics = topicClusters(topQueries(site.id, p.start, p.end, {}, 20_000), { brandTerms: terms });
	return { period: p, groups, topics };
}

export function heatmapReport(site: Site, by: 'group' | 'page' = 'group', depth = 1) {
	const end = site.synced_through;
	const first = (db().prepare('SELECT MIN(date) d FROM site_daily WHERE site_id = ?').get(site.id) as { d: string | null }).d;
	if (!end || !first) return { months: [] as string[], rows: [] };
	const months = completeMonths(first, end);
	if (months.length < 2) return { months, rows: [] };
	const lo = `${months[0]}-01`;
	const hi = `${months[months.length - 1]}-31`;
	const cells = db()
		.prepare('SELECT substr(date,1,7) month, page, SUM(clicks) clicks FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY month, page')
		.all(site.id, lo, hi) as { month: string; page: string; clicks: number }[];
	const keyed = cells.map((c) => ({ key: by === 'group' ? urlSection(c.page, depth) : c.page, month: c.month, clicks: c.clicks }));
	return { months, rows: buildHeatmap(keyed, months, { limit: by === 'group' ? 30 : 40 }) };
}

export function localesReport(site: Site, days: number) {
	const p = periodFor(site, days);
	const rows = db()
		.prepare('SELECT page, country, SUM(clicks) clicks, SUM(impressions) impressions FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page, country')
		.all(site.id, p.start, p.end) as { page: string; country: string; clicks: number; impressions: number }[];
	return localeReport(rows);
}

export function countryCannibalReport(site: Site, days: number, limit = 100) {
	const p = periodFor(site, days);
	const rows = db()
		.prepare('SELECT country, query, page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) * 1.0 / NULLIF(SUM(impressions), 0) position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY country, query, page HAVING SUM(impressions) >= 3 ORDER BY impressions DESC LIMIT 150000')
		.all(site.id, p.start, p.end) as { country: string; query: string; page: string; clicks: number; impressions: number; position: number }[];
	const curve = fittedCurve(queryPageRows(site.id, p.start, p.end), brandTerms(site));
	return countryCannibalization(rows, curve, { limit });
}

// ── Weak and dead URLs ───────────────────────────────────────────────────────
export interface UrlClassRow { page: string; cls: UrlClass; clicks: number; prevClicks: number; impressions: number; position: number; index: string; fetchState: string | null }

export function urlClassesReport(site: Site, days: number) {
	const p = periodFor(site, days);
	const now = new Map(topPages(site.id, p.start, p.end, {}, 50_000).map((r) => [r.page, r]));
	const prev = new Map(topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000).map((r) => [r.page, r]));
	const insp = new Map(
		(db().prepare('SELECT url, result FROM url_inspections WHERE site_id = ?').all(site.id) as { url: string; result: string }[]).map((r) => {
			const j = JSON.parse(r.result) as { error?: string; indexStatusResult?: { verdict?: string; pageFetchState?: string } };
			return [r.url, { state: indexState({ verdict: j.indexStatusResult?.verdict, error: j.error }), fetch: j.indexStatusResult?.pageFetchState ?? null }] as const;
		})
	);
	const curve = fittedCurve(queryPageRows(site.id, p.start, p.end), brandTerms(site));
	const rows: UrlClassRow[] = [];
	for (const page of new Set([...now.keys(), ...prev.keys()])) {
		const n = now.get(page);
		const b = prev.get(page);
		const i = insp.get(page);
		const perf = { clicks: n?.clicks ?? 0, impressions: n?.impressions ?? 0, position: n?.position ?? 0, prevClicks: b?.clicks ?? 0, prevImpressions: b?.impressions ?? 0, index: i?.state, fetchState: i?.fetch ?? undefined };
		rows.push({ page, cls: classifyUrl(perf, curve), clicks: perf.clicks, prevClicks: perf.prevClicks, impressions: perf.impressions, position: perf.position, index: i?.state ?? 'not checked', fetchState: i?.fetch ?? null });
	}
	const counts: Record<UrlClass, number> = { dead: 0, 'not-indexed': 0, fading: 0, underperforming: 0, weak: 0, healthy: 0 };
	for (const r of rows) counts[r.cls]++;
	const lost: Record<string, number> = {};
	for (const r of rows) if (r.cls !== 'healthy') lost[r.cls] = (lost[r.cls] ?? 0) + Math.max(0, r.prevClicks - r.clicks);
	return { period: p, counts, lostClicks: lost, rows: rows.filter((r) => r.cls !== 'healthy').sort((a, b) => b.prevClicks - a.prevClicks || b.impressions - a.impressions) };
}

// ── AI-assistant traffic ─────────────────────────────────────────────────────
export function aiTrafficReport(site: Site, days: number) {
	if (!linksFor(site.id).ga4) return { linked: false as const };
	const d = db();
	const rows = d.prepare('SELECT assistant, page, sessions, engaged_sessions engaged, key_events keyEvents, pulled_on FROM ga4_ai WHERE site_id = ? AND days = ? ORDER BY sessions DESC').all(site.id, days) as { assistant: string; page: string; sessions: number; engaged: number; keyEvents: number; pulled_on: string }[];
	const have = d.prepare('SELECT 1 FROM sites WHERE id = ? AND ga4_periods_on IS NOT NULL').get(site.id) != null;
	const total = (d.prepare('SELECT SUM(sessions) s FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, periodFor(site, days).start, periodFor(site, days).end) as { s: number | null }).s ?? 0;
	const by = AI_ASSISTANTS.map((a) => {
		const mine = rows.filter((r) => r.assistant === a);
		return { assistant: a, sessions: mine.reduce((x, r) => x + r.sessions, 0), engaged: mine.reduce((x, r) => x + r.engaged, 0), keyEvents: r2(mine.reduce((x, r) => x + r.keyEvents, 0)), pages: mine.length };
	}).filter((x) => x.sessions > 0);
	const sessions = by.reduce((a, b) => a + b.sessions, 0);
	return {
		linked: true as const,
		synced: have,
		pulledOn: rows[0]?.pulled_on ?? null,
		sessions,
		shareOfAllSessions: total ? sessions / total : null,
		assistants: by,
		pages: rows.slice(0, 100).map((r) => ({ page: r.page, assistant: r.assistant, sessions: r.sessions, engaged: r.engaged, keyEvents: r2(r.keyEvents) }))
	};
}

