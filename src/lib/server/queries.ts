import { db } from './db';
import { addDays, daysBetween, makePeriod, pacificToday, type Period } from './dates';
import { fitCtrCurve, isBranded, parseTerms, sumMetrics, type CtrCurve, type Metrics, type PRow, type QPRow, type QRow } from '../analytics';
import type { SiteRow } from './clients';

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

export function dailySeries(siteId: number, start: string, end: string): DayRow[] {
	return db().prepare('SELECT date, clicks, impressions, position FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(siteId, start, end) as DayRow[];
}

export interface Filters { country?: string; device?: string; search?: string; page?: string }

function where(f: Filters): { sql: string; args: string[] } {
	const parts: string[] = [];
	const args: string[] = [];
	if (f.country) (parts.push('country = ?'), args.push(f.country));
	if (f.device) (parts.push('device = ?'), args.push(f.device));
	if (f.page) (parts.push('page = ?'), args.push(f.page));
	if (f.search) (parts.push('(query LIKE ? OR page LIKE ?)'), args.push(`%${f.search}%`, `%${f.search}%`));
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
			 ${opts.includeHidden ? '' : 'WHERE s.hidden = 0'} ORDER BY s.site_url`
		)
		.all() as never;
}

export interface SiteCard {
	site: ReturnType<typeof allSites>[number];
	now: Metrics;
	prev: Metrics;
	spark: number[];
	period: Period;
}

export function siteCards(days: number, opts: { includeHidden?: boolean } = {}): SiteCard[] {
	return allSites(opts).map((site) => {
		const period = periodFor(site, days);
		return {
			site,
			period,
			now: summary(site.id, period.start, period.end),
			prev: summary(site.id, period.prevStart, period.prevEnd),
			spark: dailySeries(site.id, period.start, period.end).map((r) => r.clicks)
		};
	});
}

export function portfolioTotals(cards: SiteCard[]) {
	return { now: sumMetrics(cards.map((c) => c.now)), prev: sumMetrics(cards.map((c) => c.prev)), sites: cards.length };
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
			d.prepare(`SELECT SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? AND page LIKE ?`).get(site.id, s, e, `${a.page_prefix}%`) as never
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
