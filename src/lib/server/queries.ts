import { db } from './db';
import { addDays, daysBetween, eachDay, makePeriod, pacificToday, type Period } from './dates';
import { fitCtrCurve, isBranded, parseTerms, sumMetrics, type CtrCurve, type Metrics, type PRow, type QPRow, type QRow } from '../analytics';
import type { SiteRow } from './clients';
import { coverageMap } from '../property';
import { ALL_TYPES, type AnyType } from '../searchTypes';

const WPOS = 'SUM(position * impressions) * 1.0 / NULLIF(SUM(impressions), 0)';
const num = (n: unknown) => (typeof n === 'number' ? n : 0);

function metrics(r: { clicks: unknown; impressions: unknown; position: unknown } | undefined): Metrics {
	return { clicks: num(r?.clicks), impressions: num(r?.impressions), position: num(r?.position) };
}

/** The "end" of every period for a site: the newest day we hold (never a day we have not synced). */
export function siteEnd(site: Pick<SiteRow, 'id' | 'synced_through'>): string {
	return site.synced_through ?? addDays(pacificToday(), -2);
}

export function periodFor(site: Pick<SiteRow, 'id' | 'synced_through'>, days: number): Period {
	return makePeriod(siteEnd(site), days);
}

export function summary(siteId: number, start: string, end: string): Metrics {
	return metrics(
		db()
			.prepare(`SELECT SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ?`)
			.get(siteId, start, end) as never
	);
}

export interface DayRow extends Metrics { date: string }

/** Totals per search type for a window. Web comes from site_daily; the others from site_daily_type. Missing = no traffic. */
export function typeBreakdown(siteId: number, start: string, end: string): Partial<Record<AnyType, Metrics>> {
	const out: Partial<Record<AnyType, Metrics>> = { web: summary(siteId, start, end) };
	const rows = db()
		.prepare(`SELECT search_type t, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM site_daily_type WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY search_type`)
		.all(siteId, start, end) as { t: AnyType; clicks: number; impressions: number; position: number | null }[];
	for (const r of rows) out[r.t] = metrics(r);
	return out;
}

/** Daily clicks per search type (calendar filled with zeros), for the small trend charts. */
export function typeSeries(siteId: number, start: string, end: string): Record<AnyType, number[]> {
	const days = eachDay(start, end);
	const idx = new Map(days.map((d, i) => [d, i]));
	const out = Object.fromEntries(ALL_TYPES.map((t) => [t, new Array(days.length).fill(0)])) as Record<AnyType, number[]>;
	for (const r of dailySeries(siteId, start, end, false)) out.web[idx.get(r.date)!] = r.clicks;
	const rows = db().prepare('SELECT search_type t, date, clicks FROM site_daily_type WHERE site_id = ? AND date BETWEEN ? AND ?').all(siteId, start, end) as { t: AnyType; date: string; clicks: number }[];
	for (const r of rows) if (out[r.t] && idx.has(r.date)) out[r.t][idx.get(r.date)!] = r.clicks;
	return out;
}

export interface AppearanceRow extends Metrics { appearance: string }
/** Latest search-appearance report for the window length, if one has been pulled. */
export function appearanceFor(siteId: number, days: number): { rows: AppearanceRow[]; pulledOn: string | null } {
	const rows = db()
		.prepare('SELECT appearance, clicks, impressions, position, pulled_on FROM site_appearance WHERE site_id = ? AND days = ? ORDER BY clicks DESC, impressions DESC')
		.all(siteId, days) as (AppearanceRow & { pulled_on: string })[];
	return { rows: rows.map((r) => ({ appearance: r.appearance, ...metrics(r) })), pulledOn: rows[0]?.pulled_on ?? null };
}

/**
 * Search Console returns no row for a day with no impressions, so small sites have gaps. Charts and anomaly
 * detection need a real calendar: fill the missing days with zeros (position 0 = "no data", drawn as a gap).
 */
export function fillDays(rows: DayRow[], start: string, end: string): DayRow[] {
	const have = new Map(rows.map((r) => [r.date, r]));
	return eachDay(start, end).map((date) => have.get(date) ?? { date, clicks: 0, impressions: 0, position: 0 });
}

export function dailySeries(siteId: number, start: string, end: string, fill = true): DayRow[] {
	const rows = db().prepare('SELECT date, clicks, impressions, position FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(siteId, start, end) as DayRow[];
	return fill ? fillDays(rows, start, end) : rows;
}

/** True once the stored history reaches back over the whole previous comparison period. */
export function historyCoversPrevious(site: Pick<SiteRow, 'backfill_done' | 'backfilled_to'>, prevStart: string): boolean {
	return !!site.backfill_done || (!!site.backfilled_to && site.backfilled_to <= prevStart);
}

export interface Filters { country?: string; device?: string; search?: string; page?: string }

/** A LIKE pattern that matches the text literally anywhere: % and _ in the text are not wildcards. */
export const likeOf = (s: string) => `%${s.replace(/[\\%_]/g, (c) => '\\' + c)}%`;

function where(f: Filters): { sql: string; args: string[] } {
	const parts: string[] = [];
	const args: string[] = [];
	if (f.country) (parts.push('country = ?'), args.push(f.country));
	if (f.device) (parts.push('device = ?'), args.push(f.device));
	if (f.page) (parts.push('page = ?'), args.push(f.page));
	if (f.search) (parts.push("(query LIKE ? ESCAPE '\\' OR page LIKE ? ESCAPE '\\')"), args.push(likeOf(f.search), likeOf(f.search)));
	return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

export function topQueries(siteId: number, start: string, end: string, f: Filters = {}, limit = 500): QRow[] {
	const w = where(f);
	return db()
		.prepare(`SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?${w.sql} GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT ?`)
		.all(siteId, start, end, ...w.args, limit) as QRow[];
}

export function topPages(siteId: number, start: string, end: string, f: Filters = {}, limit = 500): PRow[] {
	const w = where(f);
	return db()
		.prepare(`SELECT page, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?${w.sql} GROUP BY page ORDER BY clicks DESC, impressions DESC LIMIT ?`)
		.all(siteId, start, end, ...w.args, limit) as PRow[];
}

export type PerfDim = 'query' | 'page' | 'country' | 'device' | 'date';
export interface PerfFilters { country?: string; device?: string; queryContains?: string; pageContains?: string; queryRegex?: string; pageRegex?: string; queryExcludes?: string; pageExcludes?: string }
const PERF_DIMS: readonly string[] = ['query', 'page', 'country', 'device', 'date'];
const like = likeOf;

/** Web-search performance grouped by one dimension, from the query-level rows (so anonymised queries are not in it). */
export function performanceBy(siteId: number, start: string, end: string, dim: PerfDim, f: PerfFilters = {}, limit = 50_000): (Metrics & { key: string })[] {
	if (!PERF_DIMS.includes(dim)) throw new Error(`Unknown dimension ${dim}`);
	const parts: string[] = [];
	const args: (string | number)[] = [];
	if (f.country) (parts.push('country = ?'), args.push(f.country));
	if (f.device) (parts.push('device = ?'), args.push(f.device));
	if (f.queryContains) (parts.push("query LIKE ? ESCAPE '\\'"), args.push(like(f.queryContains)));
	if (f.pageContains) (parts.push("page LIKE ? ESCAPE '\\'"), args.push(like(f.pageContains)));
	if (f.queryExcludes) (parts.push("query NOT LIKE ? ESCAPE '\\'"), args.push(like(f.queryExcludes)));
	if (f.pageExcludes) (parts.push("page NOT LIKE ? ESCAPE '\\'"), args.push(like(f.pageExcludes)));
	// REGEXP calls the regexp() function registered in openDb, which refuses patterns that could run away (safeRegex).
	if (f.queryRegex) (parts.push('query REGEXP ?'), args.push(f.queryRegex));
	if (f.pageRegex) (parts.push('page REGEXP ?'), args.push(f.pageRegex));
	const extra = parts.length ? ' AND ' + parts.join(' AND ') : '';
	return db()
		.prepare(`SELECT ${dim} AS key, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?${extra} GROUP BY ${dim} ORDER BY clicks DESC, impressions DESC LIMIT ?`)
		.all(siteId, start, end, ...args, limit) as (Metrics & { key: string })[];
}

export function queryPageRows(siteId: number, start: string, end: string, minImpressions = 3, limit = 150_000): QPRow[] {
	return db()
		.prepare(`SELECT query, page, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query, page HAVING SUM(impressions) >= ? ORDER BY impressions DESC LIMIT ?`)
		.all(siteId, start, end, minImpressions, limit) as QPRow[];
}

export function pageTotals(siteId: number, start: string, end: string, limit = 50_000): PRow[] {
	return topPages(siteId, start, end, {}, limit);
}

export function breakdown(siteId: number, start: string, end: string, dim: 'country' | 'device') {
	return db()
		.prepare(`SELECT ${dim} AS key, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY ${dim} ORDER BY clicks DESC`)
		.all(siteId, start, end) as (Metrics & { key: string })[];
}

export function queryHistory(siteId: number, query: string, start: string, end: string): DayRow[] {
	return db()
		.prepare(`SELECT date, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND query = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`)
		.all(siteId, query, start, end) as DayRow[];
}

export function pageHistory(siteId: number, page: string, start: string, end: string): DayRow[] {
	return db()
		.prepare(`SELECT date, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND page = ? AND date BETWEEN ? AND ? GROUP BY date ORDER BY date`)
		.all(siteId, page, start, end) as DayRow[];
}

/** Share of clicks Google did not attribute to any query (anonymised), from totals vs detail rows. */
export function anonymisedShare(siteId: number, start: string, end: string): number | null {
	const total = summary(siteId, start, end).clicks;
	const detail = num(
		(db().prepare('SELECT SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?').get(siteId, start, end) as { c: number | null }).c
	);
	return total > 0 ? Math.max(0, (total - detail) / total) : null;
}

export function brandTerms(site: Pick<SiteRow, 'brand_terms' | 'site_url'>): string[] {
	const terms = parseTerms(site.brand_terms);
	if (terms.length) return terms;
	// Default guess: the registrable-ish name of the domain (greenleaf.example -> greenleaf)
	const host = site.site_url.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
	const label = host.split('.')[0];
	return label.length >= 4 ? [label.toLowerCase().replace(/[^a-z0-9]/g, '')] : [];
}

/** CTR curve fitted on non-branded query/page rows (brand CTR is far higher and would distort it). */
export function fittedCurve(rows: QPRow[], terms: string[]): CtrCurve {
	return fitCtrCurve(rows.filter((r) => !isBranded(r.query, terms)));
}

export function allSites(opts: { includeHidden?: boolean } = {}): (SiteRow & { account_email: string; account_label: string | null; account_status: string })[] {
	return db()
		.prepare(
			`SELECT s.*, a.email AS account_email, a.label AS account_label, a.status AS account_status
			 FROM sites s JOIN accounts a ON a.id = s.account_id
			 ${opts.includeHidden ? '' : "WHERE s.hidden = 0 AND s.permission != 'none'"} ORDER BY s.site_url`
		)
		.all() as never;
}

export interface SiteCard {
	site: ReturnType<typeof allSites>[number];
	/** id of the Domain property that already contains this URL-prefix property's data, if any */
	coveredBy: number | null;
	/** previous-period comparisons are only trustworthy once that period has been downloaded */
	comparable: boolean;
	now: Metrics;
	prev: Metrics;
	spark: number[];
	period: Period;
}

export function siteCards(days: number, opts: { includeHidden?: boolean } = {}): SiteCard[] {
	const sites = allSites(opts);
	const cover = coverageMap(sites.filter((s) => !s.hidden && s.permission !== 'none'));
	return sites.map((site) => {
		const period = periodFor(site, days);
		return {
			site,
			coveredBy: cover.get(site.id) ?? null,
			comparable: historyCoversPrevious(site, period.prevStart),
			period,
			now: summary(site.id, period.start, period.end),
			prev: summary(site.id, period.prevStart, period.prevEnd),
			spark: dailySeries(site.id, period.start, period.end).map((r) => r.clicks)
		};
	});
}

/** Each site is counted once: URL-prefix properties already inside a Domain property are left out. */
export function portfolioTotals(cards: SiteCard[]) {
	const counted = cards.filter((c) => c.coveredBy === null);
	return {
		now: sumMetrics(counted.map((c) => c.now)),
		prev: sumMetrics(counted.map((c) => c.prev)),
		sites: cards.length,
		duplicates: cards.length - counted.length,
		/** false while any counted site is still downloading the history the comparison needs */
		comparable: counted.every((c) => c.comparable),
		loading: counted.filter((c) => !c.comparable).length
	};
}

// ── Annotations & before/after ───────────────────────────────────────────────
export interface Annotation { id: number; site_id: number; date: string; title: string; note: string | null; kind: string; page_prefix: string | null }

export function annotationsFor(siteId: number): Annotation[] {
	return db().prepare('SELECT id, site_id, date, title, note, kind, page_prefix FROM annotations WHERE site_id = ? ORDER BY date DESC').all(siteId) as Annotation[];
}

export interface ExperimentResult {
	windowDays: number;
	afterDays: number;
	tooEarly: boolean;
	before: { clicksPerDay: number; impressionsPerDay: number; position: number };
	after: { clicksPerDay: number; impressionsPerDay: number; position: number };
	controlBeforeClicksPerDay: number;
	controlAfterClicksPerDay: number;
}

/** Compare the N days before a change with the N days from it, for a page scope, against the whole site. */
export function experiment(site: Pick<SiteRow, 'id' | 'synced_through'>, a: Pick<Annotation, 'date' | 'page_prefix'>, windowDays = 28): ExperimentResult {
	const end = siteEnd(site);
	const afterDays = Math.max(0, Math.min(windowDays, daysBetween(a.date, end) + 1));
	const bStart = addDays(a.date, -windowDays);
	const bEnd = addDays(a.date, -1);
	const aEnd = addDays(a.date, afterDays - 1);
	const d = db();
	const scoped = (s: string, e: string) => {
		if (!a.page_prefix) return metrics(summary(site.id, s, e));
		return metrics(
			d.prepare(`SELECT SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND page LIKE ? ESCAPE '\\'`).get(site.id, s, e, likeOf(a.page_prefix).slice(0, -1).slice(1) + '%') as never
		);
	};
	const per = (m: Metrics, days: number) => ({ clicksPerDay: days ? m.clicks / days : 0, impressionsPerDay: days ? m.impressions / days : 0, position: m.position });
	return {
		windowDays,
		afterDays,
		tooEarly: afterDays < 7,
		before: per(scoped(bStart, bEnd), windowDays),
		after: per(afterDays ? scoped(a.date, aEnd) : { clicks: 0, impressions: 0, position: 0 }, afterDays),
		controlBeforeClicksPerDay: summary(site.id, bStart, bEnd).clicks / windowDays,
		controlAfterClicksPerDay: afterDays ? summary(site.id, a.date, aEnd).clicks / afterDays : 0
	};
}
