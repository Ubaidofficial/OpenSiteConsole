/** Pure analysis functions. No I/O, so they are cheap to unit test. */

export interface Metrics {
	clicks: number;
	impressions: number;
	position: number; // impression-weighted average
}
export interface QRow extends Metrics { query: string }
export interface PRow extends Metrics { page: string }
export interface QPRow extends Metrics { query: string; page: string }

export const ctrOf = (m: { clicks: number; impressions: number }) => (m.impressions ? m.clicks / m.impressions : 0);

/** Fallback CTR by position 1..20 (index 0 unused) used until a site has enough data of its own. */
export const DEFAULT_CTR: number[] = [0, 0.28, 0.15, 0.11, 0.08, 0.065, 0.05, 0.04, 0.032, 0.027, 0.023, 0.014, 0.012, 0.01, 0.009, 0.008, 0.007, 0.006, 0.005, 0.0045, 0.004];

export function weightedPosition(items: { impressions: number; position: number }[]): number {
	let w = 0;
	let s = 0;
	for (const i of items) {
		w += i.impressions;
		s += i.position * i.impressions;
	}
	return w ? s / w : 0;
}

export function sumMetrics(items: Metrics[]): Metrics {
	return {
		clicks: items.reduce((a, b) => a + b.clicks, 0),
		impressions: items.reduce((a, b) => a + b.impressions, 0),
		position: weightedPosition(items)
	};
}

export function pctChange(now: number, prev: number): number | null {
	return prev ? (now - prev) / prev : null;
}

/**
 * Percent change, but only when the baseline is big enough to mean something: going from 1 click to 3 is
 * "+200%" arithmetically and noise in practice. Below the floor we show nothing rather than a misleading number.
 */
export function pctChangeMin(now: number, prev: number, minPrev: number): number | null {
	return prev >= minPrev ? (now - prev) / prev : null;
}

/** Position change in places (negative = improved). Needs real impressions on both sides. */
export function positionShift(now: { position: number; impressions: number }, prev: { position: number; impressions: number }, minImpressions = 20): number | null {
	return now.impressions >= minImpressions && prev.impressions >= minImpressions ? now.position - prev.position : null;
}

// ── Branded split ────────────────────────────────────────────────────────────
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export function parseTerms(raw: string): string[] {
	return raw
		.split(/[,\n]/)
		.map((t) => squash(t))
		.filter((t) => t.length >= 3);
}

export function isBranded(query: string, terms: string[]): boolean {
	if (!terms.length) return false;
	const q = squash(query);
	return terms.some((t) => q.includes(t));
}

// ── URL normalisation (so /a, /a/, /a?utm=1, http://www.x/a count as one page) ─
export function normalizeUrl(u: string): string {
	try {
		const url = new URL(u);
		const host = url.hostname.toLowerCase().replace(/^www\./, '');
		const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : '/';
		return `${host}${path}`;
	} catch {
		return u;
	}
}

// ── CTR curve fitted to the site's own data ──────────────────────────────────
export interface CtrCurve {
	/** index 1..20 */
	curve: number[];
	/** which positions came from the site's data (rest fall back to DEFAULT_CTR) */
	fitted: boolean[];
	source: 'fitted' | 'mixed' | 'default';
}

export function fitCtrCurve(rows: Metrics[], minImpressionsPerBucket = 500): CtrCurve {
	const imp = new Array(21).fill(0);
	const clk = new Array(21).fill(0);
	for (const r of rows) {
		const b = Math.min(20, Math.max(1, Math.round(r.position)));
		imp[b] += r.impressions;
		clk[b] += r.clicks;
	}
	const curve = [0];
	const fitted = [false];
	for (let p = 1; p <= 20; p++) {
		const ok = imp[p] >= minImpressionsPerBucket;
		curve.push(ok ? clk[p] / imp[p] : DEFAULT_CTR[p]);
		fitted.push(ok);
	}
	// CTR cannot rise as position worsens; clamp so noisy buckets never invert the curve.
	for (let p = 2; p <= 20; p++) curve[p] = Math.min(curve[p], curve[p - 1]);
	const n = fitted.filter(Boolean).length;
	return { curve, fitted, source: n === 0 ? 'default' : n === 20 ? 'fitted' : 'mixed' };
}

export const ctrAtPosition = (c: CtrCurve, pos: number) => c.curve[Math.min(20, Math.max(1, Math.round(pos)))];

// ── Striking distance (positions 4-20) ranked by expected extra clicks ───────
export interface StrikingRow extends QRow {
	ctr: number;
	/** clicks/period you would gain by reaching position 3 */
	expectedGain: number;
	topPage?: string;
}

export function computeStriking(
	rows: QRow[],
	curve: CtrCurve,
	o: { minImpressions?: number; minPos?: number; maxPos?: number; targetPos?: number; limit?: number } = {}
): StrikingRow[] {
	const { minImpressions = 30, minPos = 4, maxPos = 20, targetPos = 3, limit = 200 } = o;
	const target = ctrAtPosition(curve, targetPos);
	return rows
		.filter((r) => r.position >= minPos && r.position <= maxPos && r.impressions >= minImpressions)
		.map((r) => ({
			...r,
			ctr: ctrOf(r),
			expectedGain: Math.max(0, r.impressions * (target - ctrAtPosition(curve, r.position)))
		}))
		.sort((a, b) => b.expectedGain - a.expectedGain)
		.slice(0, limit);
}

// ── Underperforming CTR vs the site's own curve ──────────────────────────────
export interface CtrGapRow extends QPRow {
	ctr: number;
	expectedCtr: number;
	missedClicks: number;
}

export function computeCtrGaps(rows: QPRow[], curve: CtrCurve, o: { minImpressions?: number; limit?: number } = {}): CtrGapRow[] {
	const { minImpressions = 100, limit = 200 } = o;
	return rows
		.filter((r) => r.position <= 10 && r.impressions >= minImpressions)
		.map((r) => {
			const expectedCtr = ctrAtPosition(curve, r.position);
			return { ...r, ctr: ctrOf(r), expectedCtr, missedClicks: Math.max(0, r.impressions * expectedCtr - r.clicks) };
		})
		.filter((r) => r.ctr < r.expectedCtr * 0.7 && r.missedClicks >= 3)
		.sort((a, b) => b.missedClicks - a.missedClicks)
		.slice(0, limit);
}

// ── Cannibalisation ──────────────────────────────────────────────────────────
export interface CannibalPage extends Metrics { page: string; share: number }
export interface CannibalGroup {
	query: string;
	totalClicks: number;
	totalImpressions: number;
	pages: CannibalPage[];
	winner: string;
	positionGap: number;
	/** Pages close in position and each carrying real share: the classic case worth fixing. */
	severity: 'high' | 'medium';
	/** Clicks/period at stake if the query were served by one page at its best position. */
	potentialClicks: number;
}

export function computeCannibalization(
	rows: QPRow[],
	curve: CtrCurve,
	o: { minQueryImpressions?: number; minPageShare?: number; minPageImpressions?: number; limit?: number } = {}
): CannibalGroup[] {
	const { minQueryImpressions = 40, minPageShare = 0.1, minPageImpressions = 10, limit = 200 } = o;
	const byQuery = new Map<string, Map<string, { url: string; items: Metrics[] }>>();
	for (const r of rows) {
		const pages = byQuery.get(r.query) ?? new Map();
		const key = normalizeUrl(r.page); // URL variants are one page, not a conflict
		const slot = pages.get(key) ?? { url: r.page, items: [] };
		slot.items.push(r);
		pages.set(key, slot);
		byQuery.set(r.query, pages);
	}
	const out: CannibalGroup[] = [];
	for (const [query, pages] of byQuery) {
		const merged = [...pages.values()].map((p) => ({ page: p.url, ...sumMetrics(p.items) }));
		const totalImpressions = merged.reduce((a, b) => a + b.impressions, 0);
		const totalClicks = merged.reduce((a, b) => a + b.clicks, 0);
		if (totalImpressions < minQueryImpressions) continue;
		const real = merged
			.filter((p) => p.impressions >= minPageImpressions && p.impressions / totalImpressions >= minPageShare)
			.map((p) => ({ ...p, share: p.impressions / totalImpressions }))
			.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);
		if (real.length < 2) continue;
		const best = Math.min(...real.map((p) => p.position));
		const worst = Math.max(...real.map((p) => p.position));
		const close = worst - best <= 3 && real.slice(0, 2).every((p) => p.share >= 0.25);
		out.push({
			query,
			totalClicks,
			totalImpressions,
			pages: real,
			winner: real[0].page,
			positionGap: worst - best,
			severity: close ? 'high' : 'medium',
			potentialClicks: Math.max(0, totalImpressions * ctrAtPosition(curve, best) - totalClicks)
		});
	}
	return out.sort((a, b) => b.potentialClicks - a.potentialClicks).slice(0, limit);
}

// ── Content decay with a significance test ───────────────────────────────────
export interface DecayRow {
	page: string;
	prevClicks: number;
	clicks: number;
	lostClicks: number;
	deltaPct: number;
	/** Page change minus site change: separates a page problem from a site-wide dip. */
	relativeDeltaPct: number;
	z: number;
	scope: 'page-specific' | 'site-wide';
	yoyDeltaPct: number | null;
	prevImpressions: number;
	impressions: number;
	positionNow: number;
	positionPrev: number;
}

export function computeDecay(
	now: PRow[],
	prev: PRow[],
	siteDeltaPct: number,
	yearAgo: PRow[] | null,
	o: { minPrevClicks?: number; minDrop?: number; minLoss?: number; zThreshold?: number; limit?: number } = {}
): DecayRow[] {
	const { minPrevClicks = 20, minDrop = 0.25, minLoss = 10, zThreshold = 2, limit = 200 } = o;
	const nowMap = new Map(now.map((r) => [normalizeUrl(r.page), r]));
	const yearMap = yearAgo ? new Map(yearAgo.map((r) => [normalizeUrl(r.page), r])) : null;
	const out: DecayRow[] = [];
	for (const p of prev) {
		if (p.clicks < minPrevClicks) continue;
		const n = nowMap.get(normalizeUrl(p.page));
		const clicks = n?.clicks ?? 0;
		const delta = (clicks - p.clicks) / p.clicks;
		// Poisson-style z for the difference of two counts: noise-level dips do not trigger.
		const z = (clicks - p.clicks) / Math.sqrt(clicks + p.clicks);
		if (delta > -minDrop || p.clicks - clicks < minLoss || z > -zThreshold) continue;
		const rel = delta - siteDeltaPct;
		const y = yearMap?.get(normalizeUrl(p.page));
		const yoyBase = y && n ? y.clicks : null;
		out.push({
			page: p.page,
			prevClicks: p.clicks,
			clicks,
			lostClicks: p.clicks - clicks,
			deltaPct: delta,
			relativeDeltaPct: rel,
			z,
			scope: siteDeltaPct <= -0.15 && Math.abs(rel) < 0.1 ? 'site-wide' : 'page-specific',
			yoyDeltaPct: yoyBase ? (clicks - yoyBase) / yoyBase : null,
			prevImpressions: p.impressions,
			impressions: n?.impressions ?? 0,
			positionNow: n?.position ?? 0,
			positionPrev: p.position
		});
	}
	return out.sort((a, b) => b.lostClicks - a.lostClicks).slice(0, limit);
}

// ── Anomaly detection on the daily series ────────────────────────────────────
export interface DayPoint { date: string; value: number }
export interface Anomaly {
	date: string;
	value: number;
	expected: number;
	deltaPct: number;
	z: number;
	direction: 'drop' | 'spike';
}

const median = (xs: number[]) => {
	if (!xs.length) return 0;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Day-of-week aware: expected = median of the same weekday over the previous 8 weeks.
 * Scale = robust spread (MAD) of how far recent days sit from their own expectation.
 */
export function detectAnomalies(series: DayPoint[], o: { zThreshold?: number; minChange?: number; minExpected?: number } = {}): Anomaly[] {
	const { zThreshold = 3.5, minChange = 0.2, minExpected = 20 } = o;
	const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
	const byDate = new Map(sorted.map((p) => [p.date, p.value]));
	const dayMs = 86_400_000;
	const shift = (date: string, days: number) => new Date(Date.parse(date) - days * dayMs).toISOString().slice(0, 10);
	const expectedFor = (date: string) => {
		const vals: number[] = [];
		for (let k = 1; k <= 8; k++) {
			const v = byDate.get(shift(date, 7 * k));
			if (v !== undefined) vals.push(v);
		}
		return vals.length >= 4 ? median(vals) : null;
	};
	const ratios: { date: string; value: number; expected: number; ratio: number }[] = [];
	for (const p of sorted) {
		const e = expectedFor(p.date);
		if (e !== null && e > 0) ratios.push({ date: p.date, value: p.value, expected: e, ratio: p.value / e });
	}
	const out: Anomaly[] = [];
	ratios.forEach((r, i) => {
		const window = ratios.slice(Math.max(0, i - 56), i).map((x) => x.ratio);
		if (window.length < 14) return;
		const med = median(window);
		const mad = median(window.map((x) => Math.abs(x - med)));
		const scale = Math.max(1.4826 * mad, 0.08);
		const z = (r.ratio - med) / scale;
		const change = r.ratio - 1;
		if (Math.abs(z) >= zThreshold && Math.abs(change) >= minChange && r.expected >= minExpected) {
			out.push({ date: r.date, value: r.value, expected: r.expected, deltaPct: change, z, direction: change < 0 ? 'drop' : 'spike' });
		}
	});
	return out;
}

/** Change in a scoped metric relative to a control (e.g. site total) across a change date. */
export function relativeLift(scopedBefore: number, scopedAfter: number, controlBefore: number, controlAfter: number): number | null {
	if (!scopedBefore || !controlBefore || !controlAfter) return null;
	return scopedAfter / scopedBefore / (controlAfter / controlBefore) - 1;
}
