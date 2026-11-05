import { describe, expect, it } from 'vitest';
import {
	DEFAULT_CTR, computeCannibalization, computeDecay, computeStriking, detectAnomalies, fitCtrCurve,
	isBranded, normalizeUrl, parseTerms, relativeLift, computeCtrGaps
} from '../src/lib/analytics';

const m = (clicks: number, impressions: number, position: number) => ({ clicks, impressions, position });

describe('normalizeUrl', () => {
	it('collapses variants of the same page', () => {
		const a = normalizeUrl('https://www.Example.com/shoes/');
		expect(normalizeUrl('http://example.com/shoes?utm_source=x')).toBe(a);
		expect(normalizeUrl('https://example.com/shoes#top')).toBe(a);
		expect(normalizeUrl('https://example.com/')).toBe('example.com/');
	});
});

describe('branded', () => {
	it('matches regardless of spacing/punctuation', () => {
		const t = parseTerms('Green Leaf, ab');
		expect(t).toEqual(['greenleaf']); // 2-char terms ignored
		expect(isBranded('green-leaf login', t)).toBe(true);
		expect(isBranded('garden tools', t)).toBe(false);
	});
});

describe('fitCtrCurve', () => {
	it('uses own data where a bucket is large enough, defaults elsewhere', () => {
		const c = fitCtrCurve([m(500, 1000, 1)], 500);
		expect(c.curve[1]).toBeCloseTo(0.5);
		expect(c.curve[2]).toBeCloseTo(Math.min(DEFAULT_CTR[2], 0.5));
		expect(c.source).toBe('mixed');
		expect(c.fitted[1]).toBe(true);
	});
	it('never lets CTR rise with worse position', () => {
		const c = fitCtrCurve([m(10, 1000, 1), m(300, 1000, 2)], 500);
		expect(c.curve[2]).toBeLessThanOrEqual(c.curve[1]);
	});
	it('reports default when there is no data', () => {
		expect(fitCtrCurve([]).source).toBe('default');
	});
});

describe('computeStriking', () => {
	const curve = fitCtrCurve([]);
	it('keeps positions 4-20 above the impression floor and ranks by expected gain', () => {
		const rows = [
			{ query: 'a', ...m(1, 1000, 8) },
			{ query: 'b', ...m(0, 5000, 12) },
			{ query: 'c', ...m(50, 1000, 2) }, // already top 3
			{ query: 'd', ...m(0, 10, 9) } // too few impressions
		];
		const r = computeStriking(rows, curve);
		expect(r.map((x) => x.query)).toEqual(['b', 'a']);
		expect(r[0].expectedGain).toBeGreaterThan(r[1].expectedGain);
	});
});

describe('computeCannibalization', () => {
	const curve = fitCtrCurve([]);
	it('flags two real pages and ignores URL variants of one page', () => {
		const rows = [
			{ query: 'x', page: 'https://a.com/p1', ...m(10, 200, 5) },
			{ query: 'x', page: 'https://a.com/p2', ...m(8, 150, 6) },
			{ query: 'y', page: 'https://a.com/p1', ...m(10, 200, 5) },
			{ query: 'y', page: 'https://a.com/p1/?utm=1', ...m(8, 150, 5.5) }
		];
		const g = computeCannibalization(rows, curve);
		expect(g.map((x) => x.query)).toEqual(['x']);
		expect(g[0].severity).toBe('high');
		expect(g[0].winner).toBe('https://a.com/p1');
	});
	it('ignores a negligible second page', () => {
		const rows = [
			{ query: 'z', page: 'https://a.com/p1', ...m(30, 500, 3) },
			{ query: 'z', page: 'https://a.com/p2', ...m(0, 12, 30) }
		];
		expect(computeCannibalization(rows, curve)).toHaveLength(0);
	});
});

describe('computeDecay', () => {
	const prev = [
		{ page: 'https://a.com/1', ...m(200, 4000, 4) },
		{ page: 'https://a.com/2', ...m(100, 2000, 5) },
		{ page: 'https://a.com/3', ...m(25, 500, 7) }
	];
	const now = [
		{ page: 'https://a.com/1', ...m(100, 3500, 6) }, // real drop
		{ page: 'https://a.com/2', ...m(95, 2000, 5) }, // noise
		{ page: 'https://a.com/3', ...m(15, 400, 8) } // -40% but tiny, z too small
	];
	it('flags significant drops only', () => {
		const r = computeDecay(now, prev, 0, null);
		expect(r.map((x) => x.page)).toEqual(['https://a.com/1']);
		expect(r[0].scope).toBe('page-specific');
		expect(r[0].lostClicks).toBe(100);
	});
	it('labels a page that falls with the whole site as site-wide', () => {
		const siteWide = [{ page: 'https://a.com/1', ...m(120, 3000, 4) }];
		const r = computeDecay(siteWide, [prev[0]], -0.4, null);
		expect(r[0].scope).toBe('site-wide');
	});
	it('treats a page that vanished as a full loss', () => {
		expect(computeDecay([], [prev[0]], 0, null)[0].deltaPct).toBe(-1);
	});
});

describe('detectAnomalies', () => {
	const day = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
	const base = (i: number) => {
		const dow = new Date(day(i)).getUTCDay();
		const weekend = dow === 0 || dow === 6 ? 60 : 100;
		return weekend + ((i * 7) % 5); // mild deterministic wobble
	};
	it('finds a drop that is not just a weekend', () => {
		const series = Array.from({ length: 90 }, (_, i) => ({ date: day(i), value: i === 80 ? 30 : base(i) }));
		const a = detectAnomalies(series);
		expect(a.map((x) => x.date)).toContain(day(80));
		expect(a.find((x) => x.date === day(80))!.direction).toBe('drop');
	});
	it('does not flag ordinary weekends', () => {
		const series = Array.from({ length: 90 }, (_, i) => ({ date: day(i), value: base(i) }));
		expect(detectAnomalies(series)).toHaveLength(0);
	});
});

describe('relativeLift', () => {
	it('subtracts site-wide movement', () => {
		expect(relativeLift(100, 150, 1000, 1000)).toBeCloseTo(0.5);
		expect(relativeLift(100, 100, 1000, 800)).toBeCloseTo(0.25);
		expect(relativeLift(0, 5, 10, 10)).toBeNull();
	});
});

describe('computeCtrGaps', () => {
	it('finds pages that under-deliver for their position', () => {
		const curve = fitCtrCurve([]);
		const r = computeCtrGaps([{ query: 'q', page: 'p', ...m(5, 1000, 3) }, { query: 'q2', page: 'p', ...m(110, 1000, 3) }], curve);
		expect(r.map((x) => x.query)).toEqual(['q']);
	});
});
