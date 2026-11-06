/**
 * PORT of a slice of src/lib/server/queries.ts: summary, typeBreakdown, dailySeries (+ fillDays), topQueries, queryPageRows,
 * anonymisedShare and siteCards. The SQL strings are copied unchanged; only the call style changes.
 *
 * siteCards is the interesting one: it is the dashboard's data function and, as written, issues 3 queries PER SITE.
 * `siteCards` below is the literal port (sequential awaits); `siteCardsBatched` shows the D1-shaped rewrite that needs
 * a single round trip.
 */
import type { Db, Stmt } from '../db';
import { q } from '../db';
import type { SiteRow } from '../../../../../src/lib/server/clients';
import { addDays, eachDay, makePeriod, pacificToday, type Period } from '../../../../../src/lib/server/dates';
import type { Metrics, QPRow, QRow } from '../../../../../src/lib/analytics';
import { type AnyType } from '../../../../../src/lib/searchTypes';
import { coverageMap } from '../../../../../src/lib/property';

const WPOS = 'SUM(position * impressions) * 1.0 / NULLIF(SUM(impressions), 0)';
const num = (n: unknown) => (typeof n === 'number' ? n : 0);

function metrics(r: { clicks: unknown; impressions: unknown; position: unknown } | undefined): Metrics {
	return { clicks: num(r?.clicks), impressions: num(r?.impressions), position: num(r?.position) };
}

export function siteEnd(site: Pick<SiteRow, 'id' | 'synced_through'>): string {
	return site.synced_through ?? addDays(pacificToday(), -2);
}
export function periodFor(site: Pick<SiteRow, 'id' | 'synced_through'>, days: number): Period {
	return makePeriod(siteEnd(site), days);
}

const SUMMARY_SQL = `SELECT SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ?`;
const DAILY_SQL = 'SELECT date, clicks, impressions, position FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date';

export async function summary(db: Db, siteId: number, start: string, end: string): Promise<Metrics> {
	return metrics(await db.get(SUMMARY_SQL, siteId, start, end));
}

export interface DayRow extends Metrics {
	date: string;
}

export function fillDays(rows: DayRow[], start: string, end: string): DayRow[] {
	const have = new Map(rows.map((r) => [r.date, r]));
	return eachDay(start, end).map((date) => have.get(date) ?? { date, clicks: 0, impressions: 0, position: 0 });
}

export async function dailySeries(db: Db, siteId: number, start: string, end: string, fill = true): Promise<DayRow[]> {
	const rows = await db.all<DayRow>(DAILY_SQL, siteId, start, end);
	return fill ? fillDays(rows, start, end) : rows;
}

export async function typeBreakdown(db: Db, siteId: number, start: string, end: string): Promise<Partial<Record<AnyType, Metrics>>> {
	const out: Partial<Record<AnyType, Metrics>> = { web: await summary(db, siteId, start, end) };
	const rows = await db.all<{ t: AnyType; clicks: number; impressions: number; position: number | null }>(
		`SELECT search_type t, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM site_daily_type WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY search_type`,
		siteId,
		start,
		end
	);
	for (const r of rows) out[r.t] = metrics(r);
	return out;
}

export interface Filters {
	country?: string;
	device?: string;
	search?: string;
	page?: string;
}
function where(f: Filters): { sql: string; args: string[] } {
	const parts: string[] = [];
	const args: string[] = [];
	if (f.country) (parts.push('country = ?'), args.push(f.country));
	if (f.device) (parts.push('device = ?'), args.push(f.device));
	if (f.page) (parts.push('page = ?'), args.push(f.page));
	if (f.search) (parts.push('(query LIKE ? OR page LIKE ?)'), args.push(`%${f.search}%`, `%${f.search}%`));
	return { sql: parts.length ? ' AND ' + parts.join(' AND ') : '', args };
}

export async function topQueries(db: Db, siteId: number, start: string, end: string, f: Filters = {}, limit = 500): Promise<QRow[]> {
	const w = where(f);
	return db.all<QRow>(
		`SELECT query, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?${w.sql} GROUP BY query ORDER BY clicks DESC, impressions DESC LIMIT ?`,
		siteId,
		start,
		end,
		...w.args,
		limit
	);
}

export async function queryPageRows(db: Db, siteId: number, start: string, end: string, minImpressions = 3, limit = 150_000): Promise<QPRow[]> {
	return db.all<QPRow>(
		`SELECT query, page, SUM(clicks) clicks, SUM(impressions) impressions, ${WPOS} position FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY query, page HAVING SUM(impressions) >= ? ORDER BY impressions DESC LIMIT ?`,
		siteId,
		start,
		end,
		minImpressions,
		limit
	);
}

export async function anonymisedShare(db: Db, siteId: number, start: string, end: string): Promise<number | null> {
	const total = (await summary(db, siteId, start, end)).clicks;
	const detail = num((await db.get<{ c: number | null }>('SELECT SUM(clicks) c FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ?', siteId, start, end))!.c);
	return total > 0 ? Math.max(0, (total - detail) / total) : null;
}

type SiteWithAccount = SiteRow & { account_email: string; account_label: string | null; account_status: string };
export async function allSites(db: Db, opts: { includeHidden?: boolean } = {}): Promise<SiteWithAccount[]> {
	return db.all<SiteWithAccount>(
		`SELECT s.*, a.email AS account_email, a.label AS account_label, a.status AS account_status
		 FROM sites s JOIN accounts a ON a.id = s.account_id
		 ${opts.includeHidden ? '' : "WHERE s.hidden = 0 AND s.permission != 'none'"} ORDER BY s.site_url`
	);
}

function historyCoversPrevious(site: Pick<SiteRow, 'backfill_done' | 'backfilled_to'>, prevStart: string): boolean {
	return !!site.backfill_done || (!!site.backfilled_to && site.backfilled_to <= prevStart);
}

export interface SiteCard {
	siteId: number;
	coveredBy: number | null;
	comparable: boolean;
	now: Metrics;
	prev: Metrics;
	spark: number[];
	period: Period;
}

/** Literal port: 3 awaited queries per site, sequentially: 3N+1 D1 round trips for N sites. */
export async function siteCards(db: Db, days: number): Promise<SiteCard[]> {
	const sites = await allSites(db);
	const cover = coverageMap(sites.filter((s) => !s.hidden));
	const out: SiteCard[] = [];
	for (const site of sites) {
		const period = periodFor(site, days);
		out.push({
			siteId: site.id,
			coveredBy: cover.get(site.id) ?? null,
			comparable: historyCoversPrevious(site, period.prevStart),
			period,
			now: await summary(db, site.id, period.start, period.end),
			prev: await summary(db, site.id, period.prevStart, period.prevEnd),
			spark: (await dailySeries(db, site.id, period.start, period.end)).map((r) => r.clicks)
		});
	}
	return out;
}

/** D1-shaped rewrite: all 3N reads travel in ONE batch() (one round trip, one query against the per-invocation limit). */
export async function siteCardsBatched(db: Db, days: number): Promise<SiteCard[]> {
	const sites = await allSites(db);
	const cover = coverageMap(sites.filter((s) => !s.hidden));
	const periods = sites.map((s) => periodFor(s, days));
	const stmts: Stmt[] = sites.flatMap((s, i) => [q(SUMMARY_SQL, s.id, periods[i].start, periods[i].end), q(SUMMARY_SQL, s.id, periods[i].prevStart, periods[i].prevEnd), q(DAILY_SQL, s.id, periods[i].start, periods[i].end)]);
	const res = await db.batch(stmts);
	return sites.map((site, i) => {
		const period = periods[i];
		const [now, prev, daily] = [res[i * 3], res[i * 3 + 1], res[i * 3 + 2]];
		return {
			siteId: site.id,
			coveredBy: cover.get(site.id) ?? null,
			comparable: historyCoversPrevious(site, period.prevStart),
			period,
			now: metrics(now.rows[0] as never),
			prev: metrics(prev.rows[0] as never),
			spark: fillDays(daily.rows as DayRow[], period.start, period.end).map((r) => r.clicks)
		};
	});
}
