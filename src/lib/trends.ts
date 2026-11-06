/**
 * Trend analysis over stored Search Console history: movers, new / lost queries, position bands, trajectories,
 * question queries and a simple click projection. Pure functions, no I/O, unit-tested.
 */
import type { Metrics } from './analytics';

export interface Keyed extends Metrics { key: string }

// ── Winners & losers ─────────────────────────────────────────────────────────
export interface Mover {
	key: string;
	clicks: number;
	prevClicks: number;
	change: number;
	/** null when there was nothing before (a new arrival) */
	deltaPct: number | null;
	z: number;
	impressions: number;
	position: number;
	prevPosition: number;
}

/**
 * Keys whose clicks moved by more than noise. z is a Poisson-style test on the difference of two counts, the same
 * test the decay report uses, so a handful of clicks either way never shows up.
 */
export function computeMovers(now: Keyed[], prev: Keyed[], o: { minChange?: number; zThreshold?: number; limit?: number } = {}): { winners: Mover[]; losers: Mover[] } {
	const { minChange = 10, zThreshold = 2, limit = 50 } = o;
	const p = new Map(prev.map((r) => [r.key, r]));
	const n = new Map(now.map((r) => [r.key, r]));
	const out: Mover[] = [];
	for (const key of new Set([...n.keys(), ...p.keys()])) {
		const a = n.get(key);
		const b = p.get(key);
		const c = a?.clicks ?? 0;
		const pc = b?.clicks ?? 0;
		if (c + pc === 0 || Math.abs(c - pc) < minChange) continue;
		const z = (c - pc) / Math.sqrt(c + pc);
		if (Math.abs(z) < zThreshold) continue;
		out.push({ key, clicks: c, prevClicks: pc, change: c - pc, deltaPct: pc ? (c - pc) / pc : null, z, impressions: a?.impressions ?? 0, position: a?.position ?? 0, prevPosition: b?.position ?? 0 });
	}
	return {
		winners: out.filter((m) => m.change > 0).sort((x, y) => y.change - x.change).slice(0, limit),
		losers: out.filter((m) => m.change < 0).sort((x, y) => x.change - y.change).slice(0, limit)
	};
}

// ── New and lost queries ─────────────────────────────────────────────────────
/**
 * Queries that appear (or vanish) between two windows. Pass the full lists, not a top-N: a query missing from a
 * truncated list is not "lost".
 */
export function newAndLost(now: Keyed[], prev: Keyed[], o: { minImpressions?: number; limit?: number } = {}): { added: Keyed[]; lost: Keyed[] } {
	const { minImpressions = 10, limit = 100 } = o;
	const seenNow = new Set(now.filter((r) => r.impressions > 0).map((r) => r.key));
	const seenPrev = new Set(prev.filter((r) => r.impressions > 0).map((r) => r.key));
	const rank = (a: Keyed, b: Keyed) => b.clicks - a.clicks || b.impressions - a.impressions;
	return {
		added: now.filter((r) => r.impressions >= minImpressions && !seenPrev.has(r.key)).sort(rank).slice(0, limit),
		lost: prev.filter((r) => r.impressions >= minImpressions && !seenNow.has(r.key)).sort(rank).slice(0, limit)
	};
}

// ── Position bands ───────────────────────────────────────────────────────────
export const BANDS = [
	{ id: '1-3', label: 'Positions 1–3', max: 3 },
	{ id: '4-10', label: 'Positions 4–10', max: 10 },
	{ id: '11-20', label: 'Positions 11–20', max: 20 },
	{ id: '21-50', label: 'Positions 21–50', max: 50 },
	{ id: '51+', label: 'Positions 51+', max: Infinity }
] as const;
export type BandId = (typeof BANDS)[number]['id'];

export const bandOf = (position: number): BandId => BANDS.find((b) => Math.round(position) <= b.max)!.id;

export interface BandRow { id: BandId; label: string; queries: number; clicks: number; impressions: number }

/** How many queries (with at least `minImpressions`) sit in each average-position band, and what they earn. */
export function positionBands(rows: Metrics[], minImpressions = 1): BandRow[] {
	const out: BandRow[] = BANDS.map((b) => ({ id: b.id, label: b.label, queries: 0, clicks: 0, impressions: 0 }));
	for (const r of rows) {
		if (r.impressions < minImpressions || r.position <= 0) continue;
		const row = out.find((x) => x.id === bandOf(r.position))!;
		row.queries++;
		row.clicks += r.clicks;
		row.impressions += r.impressions;
	}
	return out;
}

// ── Weekly series, trajectory ────────────────────────────────────────────────
const DAY = 86_400_000;
const shiftDay = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

export interface WeekPoint { weekEnd: string; clicks: number; impressions: number; position: number }

/**
 * Whole 7-day blocks counted back from `end` (block 0 ends on `end`). Only complete blocks are returned, oldest first,
 * so a part-week never looks like a collapse; pass `firstDate` (the oldest stored day) to drop blocks that reach before it. Position is impression-weighted.
 */
export function weeklyTotals(days: { date: string; clicks: number; impressions: number; position?: number }[], end: string, weeks: number, firstDate?: string): WeekPoint[] {
	const out: WeekPoint[] = [];
	const byDate = new Map(days.map((d) => [d.date, d]));
	for (let k = weeks - 1; k >= 0; k--) {
		const weekEnd = shiftDay(end, -7 * k);
		// A block that starts before the first stored day is partly (or wholly) missing data, not a week of zero clicks.
		if (firstDate && shiftDay(weekEnd, -6) < firstDate) continue;
		let clicks = 0;
		let impressions = 0;
		let posWeight = 0;
		for (let i = 0; i < 7; i++) {
			const d = byDate.get(shiftDay(weekEnd, -i));
			if (!d) continue;
			clicks += d.clicks;
			impressions += d.impressions;
			posWeight += (d.position ?? 0) * d.impressions;
		}
		out.push({ weekEnd, clicks, impressions, position: impressions ? posWeight / impressions : 0 });
	}
	return out;
}

const median = (xs: number[]) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Theil–Sen slope: the median of all pairwise slopes. Robust to a single odd week, unlike least squares. */
export function theilSen(ys: number[]): number {
	const slopes: number[] = [];
	for (let i = 0; i < ys.length; i++) for (let j = i + 1; j < ys.length; j++) slopes.push((ys[j] - ys[i]) / (j - i));
	return median(slopes);
}

export type Trajectory = 'rising' | 'falling' | 'flat' | 'volatile' | 'too-little-data';

/**
 * Direction of a query's (or page's) weekly clicks. The thresholds (±3% of the average per week, spread above the
 * average counted as volatile, 6 weeks minimum, 20 clicks in total) are my own heuristics, not a standard.
 */
export function trajectoryOf(weekly: number[]): { direction: Trajectory; weeklyChangePct: number | null } {
	const total = weekly.reduce((a, b) => a + b, 0);
	if (weekly.length < 6 || total < 20) return { direction: 'too-little-data', weeklyChangePct: null };
	const mean = total / weekly.length;
	const sd = Math.sqrt(weekly.reduce((a, b) => a + (b - mean) ** 2, 0) / weekly.length);
	const pct = theilSen(weekly) / mean;
	if (sd / mean > 1) return { direction: 'volatile', weeklyChangePct: pct };
	return { direction: pct > 0.03 ? 'rising' : pct < -0.03 ? 'falling' : 'flat', weeklyChangePct: pct };
}

// ── Question-style queries ───────────────────────────────────────────────────
const WH = /^(who|whom|whose|what|what's|whats|when|where|why|how|which)\b/i;
const AUX = /^(can|could|should|would|will|do|does|did|is|are|was|were|has|have|may|am)\b/i;

/**
 * Looks like a question. English only. A "?" always counts; a leading wh-word needs two words, and a leading auxiliary
 * verb three, so "will smith" or "do it yourself" style phrases are not swept in. A heuristic, not a classifier.
 */
export function isQuestionQuery(query: string): boolean {
	const q = query.trim();
	if (!q) return false;
	if (q.includes('?')) return true;
	const words = q.split(/\s+/).length;
	return (WH.test(q) && words >= 2) || (AUX.test(q) && words >= 3);
}

// ── Click projection ─────────────────────────────────────────────────────────
export interface ProjectionPoint { weekEnd: string; clicks: number; low: number; high: number }
export interface Projection {
	method: string;
	points: ProjectionPoint[];
	/** Projected clicks per week change at the start of the horizon, as a share of the recent level */
	weeklyTrendPct: number;
	basedOnWeeks: number;
}

/**
 * A plain projection of weekly clicks, deliberately simple: level = mean of the last 4 weeks, trend = Theil–Sen slope
 * over the last 12, damped (each further week keeps 90% of the previous week's slope), band = ±1.28 residual standard
 * deviations (about an 80% range if weeks were normally distributed, which they are not exactly).
 * It does NOT model seasonality or Google updates; treat it as "if recent behaviour continues", not a forecast.
 * Returns null with fewer than 8 complete weeks.
 */
export function projectClicks(weekly: WeekPoint[], horizon = 8): Projection | null {
	if (weekly.length < 8) return null;
	const recent = weekly.slice(-12);
	const ys = recent.map((w) => w.clicks);
	const slope = theilSen(ys);
	const level = ys.slice(-4).reduce((a, b) => a + b, 0) / Math.min(4, ys.length);
	// Residuals around the fitted line (anchored at the median level), for the band.
	const intercept = median(ys.map((y, i) => y - slope * i));
	const resid = ys.map((y, i) => y - (intercept + slope * i));
	const sd = Math.sqrt(resid.reduce((a, b) => a + b * b, 0) / Math.max(1, resid.length - 1));
	const phi = 0.9;
	let cum = 0;
	let damp = 1;
	const points: ProjectionPoint[] = [];
	for (let h = 1; h <= horizon; h++) {
		damp *= phi;
		cum += slope * damp;
		const clicks = Math.max(0, level + cum);
		// The band widens with the horizon: uncertainty about the trend compounds.
		const half = 1.28 * sd * Math.sqrt(1 + h / 4);
		points.push({ weekEnd: shiftDay(recent[recent.length - 1].weekEnd, 7 * h), clicks: Math.round(clicks), low: Math.max(0, Math.round(clicks - half)), high: Math.round(clicks + half) });
	}
	return { method: 'Level of the last 4 weeks plus a damped robust trend over the last 12. No seasonality or Google-update effects.', points, weeklyTrendPct: level ? slope / level : 0, basedOnWeeks: recent.length };
}
