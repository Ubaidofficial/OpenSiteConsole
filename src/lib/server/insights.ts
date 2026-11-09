import { db } from './db';
import type { SiteRow } from './clients';
import { addDays } from './dates';
import { brandTerms, dailySeries, fittedCurve, historyCoversPrevious, pageTotals, periodFor, queryHistory, queryPageRows, summary, topPages, topQueries } from './queries';
import { ctrOf, isBranded, pctChange } from '../analytics';
import { buildHeatmap, completeMonths, countryCannibalization, groupPages, localeReport, spansHosts, topicClusters, urlSection } from '../groups';
import { classifyUrl, indexState, type UrlClass } from '../indexing';
import { classifyIntent, computeMovers, INTENTS, isQuestionQuery, newAndLost, positionBands, projectClicks, trajectoryOf, weeklyTotals, type Intent, type Keyed } from '../trends';
import { AI_ASSISTANTS } from '../ai';
import { linksFor } from './links';

type Site = Pick<SiteRow, 'id' | 'synced_through' | 'site_url' | 'brand_terms' | 'backfilled_to' | 'backfill_done'>;
const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Whether the previous period can be trusted as a baseline. While history is still downloading, or for a site that has no
 * data before the current period, every query and page would look brand new: +3,600% and "25 winners" that are really just
 * missing data. Same rule the Overview uses (historyCoversPrevious), plus: the previous period must hold something.
 */
export function comparability(site: Site, p: { prevStart: string; prevEnd: string; days: number }): { comparable: boolean; reason: string | null } {
	if (!historyCoversPrevious(site, p.prevStart)) return { comparable: false, reason: `The previous ${p.days} days are still being downloaded, so changes against them would be wrong. This clears once the history backfill finishes.` };
	if (summary(site.id, p.prevStart, p.prevEnd).impressions <= 0) return { comparable: false, reason: `There is no data for the ${p.days} days before this period (a new site, or Search Console has none), so there is nothing to compare with.` };
	return { comparable: true, reason: null };
}
const keyedQ = (rows: { query: string; clicks: number; impressions: number; position: number }[]): Keyed[] => rows.map((r) => ({ key: r.query, clicks: r.clicks, impressions: r.impressions, position: r.position }));
const keyedP = (rows: { page: string; clicks: number; impressions: number; position: number }[]): Keyed[] => rows.map((r) => ({ key: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position }));

// ── Trends ───────────────────────────────────────────────────────────────────
export function trendsReport(site: Site, days: number, limit = 25) {
	const p = periodFor(site, days);
	const cmp = comparability(site, p);
	const qNow = topQueries(site.id, p.start, p.end, {}, 100_000);
	const qPrev = cmp.comparable ? topQueries(site.id, p.prevStart, p.prevEnd, {}, 100_000) : [];
	const pNow = topPages(site.id, p.start, p.end, {}, 50_000);
	const pPrev = cmp.comparable ? topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000) : [];
	const terms = brandTerms(site);
	const nonBrand = (rows: typeof qNow) => rows.filter((r) => !isBranded(r.query, terms));
	const nl = cmp.comparable ? newAndLost(keyedQ(qNow), keyedQ(qPrev), { limit }) : { added: [], lost: [] };
	const prevByQuery = new Map(qPrev.map((r) => [r.query, r]));
	const questions = qNow.filter((r) => isQuestionQuery(r.query));
	const qClicks = qNow.reduce((a, r) => a + r.clicks, 0);
	const qImpr = qNow.reduce((a, r) => a + r.impressions, 0);
	return {
		period: p,
		comparable: cmp.comparable,
		reason: cmp.reason,
		queryMovers: cmp.comparable ? computeMovers(keyedQ(qNow), keyedQ(qPrev), { limit }) : { winners: [], losers: [] },
		pageMovers: cmp.comparable ? computeMovers(keyedP(pNow), keyedP(pPrev), { limit }) : { winners: [], losers: [] },
		newQueries: nl.added,
		lostQueries: nl.lost,
		bands: { now: positionBands(nonBrand(qNow)), prev: cmp.comparable ? positionBands(nonBrand(qPrev)) : null },
		questions: {
			count: questions.length,
			clickShare: qClicks ? questions.reduce((a, r) => a + r.clicks, 0) / qClicks : 0,
			impressionShare: qImpr ? questions.reduce((a, r) => a + r.impressions, 0) / qImpr : 0,
			rows: questions.slice(0, limit).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: ctrOf(r), position: r.position, clicksDelta: pctChange(r.clicks, prevByQuery.get(r.query)?.clicks ?? 0) }))
		}
	};
}

const WEEKS_HISTORY = 26;
const firstStored = (siteId: number) => (db().prepare('SELECT MIN(date) d FROM site_daily WHERE site_id = ?').get(siteId) as { d: string | null }).d ?? undefined;

/** Weekly site clicks for the last `WEEKS_HISTORY` complete weeks, a projection, and the same weeks a year earlier if stored. */
export function forecastReport(site: Site, horizon = 8) {
	const end = site.synced_through ?? addDays(new Date().toISOString().slice(0, 10), -2);
	const start = addDays(end, -(7 * WEEKS_HISTORY) - 365);
	const days = dailySeries(site.id, start, end, false);
	const weekly = weeklyTotals(days, end, WEEKS_HISTORY, firstStored(site.id));
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
	const first = firstStored(site.id);
	return topQueries(site.id, p.start, end, {}, n).map((q) => {
		const w = weeklyTotals(queryHistory(site.id, q.query, addDays(end, -84), end), end, 12, first);
		const t = trajectoryOf(w.map((x) => x.clicks));
		return { query: q.query, clicks: q.clicks, direction: t.direction, weeklyChangePct: t.weeklyChangePct == null ? null : r2(t.weeklyChangePct * 100), weekly: w.map((x) => x.clicks) };
	});
}

// ── Month by month, query counts, intent ─────────────────────────────────────
const lastDayOf = (month: string) => { const [y, m] = month.split('-').map(Number); return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

/**
 * Complete calendar months, newest last: the site's clicks and impressions each month, the change on the month before, and the pages
 * (and queries) that grew and fell most that month, beyond noise (the same test as the movers view).
 */
export function monthlyReport(site: Site, months = 6, perMonth = 5) {
	const end = site.synced_through;
	const first = firstStored(site.id);
	if (!end || !first) return { months: [] as ReturnType<typeof monthRow>[], note: 'No stored history yet.' };
	const all = completeMonths(first, end);
	if (all.length < 2) return { months: [], note: 'Needs two complete months of stored history.' };
	const keep = all.slice(-(Math.min(Math.max(months, 1), 24) + 1));
	const data = keep.map((m) => {
		const lo = `${m}-01`, hi = lastDayOf(m);
		return { month: m, totals: summary(site.id, lo, hi), pages: topPages(site.id, lo, hi, {}, 50_000), queries: topQueries(site.id, lo, hi, {}, 100_000) };
	});
	function monthRow(i: number) {
		const cur = data[i], prev = data[i - 1];
		const pm = computeMovers(keyedP(cur.pages), keyedP(prev.pages), { limit: perMonth });
		const qm = computeMovers(keyedQ(cur.queries), keyedQ(prev.queries), { limit: perMonth });
		const mv = (m: { key: string; clicks: number; prevClicks: number; change: number }) => ({ key: m.key, clicks: m.clicks, previous: m.prevClicks, change: m.change });
		return {
			month: cur.month, clicks: cur.totals.clicks, impressions: cur.totals.impressions, position: r2(cur.totals.position ?? 0),
			clicksChangePct: prev.totals.clicks ? r2(((cur.totals.clicks - prev.totals.clicks) / prev.totals.clicks) * 100) : null,
			pageWinners: pm.winners.map(mv), pageLosers: pm.losers.map(mv), queryWinners: qm.winners.map(mv), queryLosers: qm.losers.map(mv)
		};
	}
	return { months: data.slice(1).map((_, i) => monthRow(i + 1)), note: null as string | null };
}

/**
 * How many different searches the site was shown for, week by week (complete weeks ending on the newest stored day): all of them,
 * those that brought a click, and those with an average position in the top 10. A growing count with flat clicks usually means
 * new, still low rankings; a shrinking one is lost reach.
 */
export function queryCountReport(site: Site, weeks = 12) {
	const end = site.synced_through;
	if (!end) return { weeks: [] as { weekEnding: string; queries: number; withClicks: number; top10: number; complete: boolean }[] };
	const n = Math.min(Math.max(weeks, 2), 52);
	const start = addDays(end, -(7 * n) + 1);
	const first = firstStored(site.id);
	const rows = db().prepare(`SELECT wk, COUNT(*) queries, SUM(c > 0) withClicks, SUM(pos <= 10) top10 FROM (
			SELECT CAST((julianday(?) - julianday(date)) / 7 AS INTEGER) wk, query, SUM(clicks) c, SUM(position * impressions) * 1.0 / NULLIF(SUM(impressions), 0) pos
			FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY wk, query HAVING SUM(impressions) > 0
		) GROUP BY wk`).all(end, site.id, start, end) as { wk: number; queries: number; withClicks: number; top10: number }[];
	const byWk = new Map(rows.map((r) => [r.wk, r]));
	const out = [];
	for (let wk = n - 1; wk >= 0; wk--) {
		const weekEnding = addDays(end, -7 * wk);
		const r = byWk.get(wk);
		out.push({ weekEnding, queries: r?.queries ?? 0, withClicks: r?.withClicks ?? 0, top10: r?.top10 ?? 0, complete: !first || addDays(weekEnding, -6) >= first });
	}
	return { weeks: out };
}

/** Clicks and impressions by likely search intent (classifyIntent: English, rule-based), with the biggest searches of each. */
export function intentReport(site: Site, days: number, perIntent = 5) {
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const rows = topQueries(site.id, p.start, p.end, {}, 100_000);
	const groups = new Map<Intent, typeof rows>(INTENTS.map((i) => [i, []]));
	for (const r of rows) groups.get(classifyIntent(r.query, terms))!.push(r);
	const tc = rows.reduce((a, r) => a + r.clicks, 0) || 1, ti = rows.reduce((a, r) => a + r.impressions, 0) || 1;
	return {
		period: p,
		brandTermsSet: terms.length > 0,
		intents: INTENTS.map((intent) => {
			const g = groups.get(intent)!;
			const c = g.reduce((a, r) => a + r.clicks, 0), i = g.reduce((a, r) => a + r.impressions, 0);
			const pos = i ? g.reduce((a, r) => a + r.position * r.impressions, 0) / i : null;
			return { intent, queries: g.length, clicks: c, impressions: i, clickShare: r2((c / tc) * 100), impressionShare: r2((i / ti) * 100), ctr: i ? r2((c / i) * 100) : null, position: pos == null ? null : r2(pos), top: g.slice(0, perIntent).map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, position: r2(r.position) })) };
		})
	};
}

// ── Groups, topics, heatmap, locales ─────────────────────────────────────────
export function groupsReport(site: Site, days: number, depth = 1) {
	const p = periodFor(site, days);
	const cmp = comparability(site, p);
	const groups = groupPages(pageTotals(site.id, p.start, p.end, 50_000), cmp.comparable ? pageTotals(site.id, p.prevStart, p.prevEnd, 50_000) : [], depth);
	const terms = brandTerms(site);
	const topics = topicClusters(topQueries(site.id, p.start, p.end, {}, 20_000), { brandTerms: terms });
	return { period: p, comparable: cmp.comparable, reason: cmp.reason, groups, topics };
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
	const withHost = by === 'group' && spansHosts(cells.map((c) => c.page));
	const keyed = cells.map((c) => ({ key: by === 'group' ? urlSection(c.page, depth, withHost) : c.page, month: c.month, clicks: c.clicks }));
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
	const cmp = comparability(site, p);
	// Without a trustworthy previous period, "dead" and "fading" cannot be judged; the other classes only need this period.
	const prev = new Map((cmp.comparable ? topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000) : []).map((r) => [r.page, r]));
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
	return { period: p, comparable: cmp.comparable, reason: cmp.reason, counts, lostClicks: lost, rows: rows.filter((r) => r.cls !== 'healthy').sort((a, b) => b.prevClicks - a.prevClicks || b.impressions - a.impressions) };
}

// ── AI-assistant traffic ─────────────────────────────────────────────────────
export function aiTrafficReport(site: Site, days: number) {
	if (!linksFor(site.id).ga4) return { linked: false as const };
	const d = db();
	const s = d.prepare('SELECT ga4_periods_on periods, ga4_ai_on ai FROM sites WHERE id = ?').get(site.id) as { periods: string | null; ai: string | null };
	if (!s.periods) return { linked: true as const, status: 'pending' as const };
	// AI sessions were pulled for the `days` ending on the pull date, so the denominator must be the same window.
	const start = addDays(s.periods, -(days - 1));
	const total = (d.prepare('SELECT SUM(sessions) s FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, start, s.periods) as { s: number | null }).s ?? 0;
	if (!s.ai) return { linked: true as const, status: 'failed' as const };
	const rows = d.prepare('SELECT assistant, page, sessions, engaged_sessions engaged, key_events keyEvents FROM ga4_ai WHERE site_id = ? AND days = ? ORDER BY sessions DESC').all(site.id, days) as { assistant: string; page: string; sessions: number; engaged: number; keyEvents: number }[];
	const by = AI_ASSISTANTS.map((a) => {
		const mine = rows.filter((r) => r.assistant === a);
		return { assistant: a, sessions: mine.reduce((x, r) => x + r.sessions, 0), engaged: mine.reduce((x, r) => x + r.engaged, 0), keyEvents: r2(mine.reduce((x, r) => x + r.keyEvents, 0)), pages: mine.length };
	}).filter((x) => x.sessions > 0);
	const sessions = by.reduce((a, b) => a + b.sessions, 0);
	return {
		linked: true as const,
		status: 'ok' as const,
		window: { start, end: s.periods },
		sessions,
		shareOfAllSessions: total ? sessions / total : null,
		assistants: by,
		pages: rows.slice(0, 100).map((r) => ({ page: r.page, assistant: r.assistant, sessions: r.sessions, engaged: r.engaged, keyEvents: r2(r.keyEvents) }))
	};
}
