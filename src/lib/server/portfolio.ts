import { db } from './db';
import { allSites, brandTerms, fittedCurve, pageTotals, periodFor, queryPageRows, summary, topQueries, dailySeries } from './queries';
import { computeCannibalization, computeDecay, computeStriking, detectAnomalies, isBranded, pctChange } from '../analytics';
import { addDays } from './dates';
import { displayName } from './clients';

type Kind = 'striking' | 'cannibalization' | 'decay' | 'anomalies';
const cache = new Map<string, { at: number; value: unknown }>();

function version(): string {
	const r = db().prepare('SELECT MAX(last_sync_at) m, COUNT(*) n, SUM(hidden) h FROM sites').get() as { m: number | null; n: number; h: number | null };
	return `${r.m}:${r.n}:${r.h}`;
}

/** Heavy cross-site computations are memoised until the next sync changes the data. */
function memo<T>(kind: Kind, days: number, fn: () => T): T {
	const key = `${kind}:${days}`;
	const v = version();
	const hit = cache.get(key);
	if (hit && hit.at.toString() === v) return hit.value as T;
	const value = fn();
	cache.set(key, { at: v as unknown as number, value });
	return value;
}

const live = () => allSites().filter((s) => s.synced_through && !['siteUnverifiedUser', 'none'].includes(s.permission));
const tag = (s: ReturnType<typeof live>[number]) => ({ siteId: s.id, site: s.label || displayName(s.site_url) });

export function portfolioStriking(days: number) {
	return memo('striking', days, () => {
		const minImpr = Math.max(10, Math.round((days / 28) * 30));
		return live()
			.flatMap((s) => {
				const p = periodFor(s, days);
				const terms = brandTerms(s);
				const curve = fittedCurve(queryPageRows(s.id, p.start, p.end), terms);
				return computeStriking(topQueries(s.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: minImpr, limit: 60 }).map((r) => ({ ...r, ...tag(s) }));
			})
			.sort((a, b) => b.expectedGain - a.expectedGain)
			.slice(0, 300);
	});
}

export function portfolioCannibalization(days: number) {
	return memo('cannibalization', days, () =>
		live()
			.flatMap((s) => {
				const p = periodFor(s, days);
				const rows = queryPageRows(s.id, p.start, p.end);
				const curve = fittedCurve(rows, brandTerms(s));
				return computeCannibalization(rows, curve, { minQueryImpressions: Math.max(20, Math.round((days / 28) * 40)), limit: 40 })
					.filter((g) => g.severity === 'high')
					.map((g) => ({ query: g.query, pageCount: g.pages.length, winner: g.winner, totalClicks: g.totalClicks, totalImpressions: g.totalImpressions, potentialClicks: g.potentialClicks, positionGap: g.positionGap, ...tag(s) }));
			})
			.sort((a, b) => b.potentialClicks - a.potentialClicks)
			.slice(0, 300)
	);
}

export function portfolioDecay(days: number) {
	return memo('decay', days, () =>
		live()
			.flatMap((s) => {
				const p = periodFor(s, days);
				const delta = pctChange(summary(s.id, p.start, p.end).clicks, summary(s.id, p.prevStart, p.prevEnd).clicks) ?? 0;
				return computeDecay(pageTotals(s.id, p.start, p.end), pageTotals(s.id, p.prevStart, p.prevEnd), delta, null, { minPrevClicks: Math.max(10, Math.round((days / 28) * 20)), limit: 40 }).map((r) => ({ ...r, ...tag(s) }));
			})
			.sort((a, b) => b.lostClicks - a.lostClicks)
			.slice(0, 300)
	);
}

export function portfolioAnomalies(days: number) {
	return memo('anomalies', days, () =>
		live()
			.flatMap((s) => {
				const p = periodFor(s, days);
				const series = dailySeries(s.id, addDays(p.end, -(days + 90)), p.end).map((d) => ({ date: d.date, value: d.clicks }));
				return detectAnomalies(series)
					.filter((a) => a.date >= p.start)
					.map((a) => ({ ...a, ...tag(s) }));
			})
			.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.deltaPct) - Math.abs(a.deltaPct))
	);
}
