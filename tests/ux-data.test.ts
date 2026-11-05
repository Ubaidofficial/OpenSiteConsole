import { beforeEach, describe, expect, it } from 'vitest';
import { pctChangeMin, positionShift } from '../src/lib/analytics';
import { db, openDb } from '../src/lib/server/db';
import { dailySeries, fillDays, historyCoversPrevious, portfolioTotals, siteCards } from '../src/lib/server/queries';
import { addDays } from '../src/lib/server/dates';

describe('noise-floor deltas', () => {
	it('suppresses percentages computed from tiny baselines', () => {
		expect(pctChangeMin(3, 1, 10)).toBeNull(); // "+200%" from one click is noise
		expect(pctChangeMin(60, 20, 10)).toBeCloseTo(2);
		expect(pctChangeMin(0, 10, 10)).toBe(-1); // a real collapse is still shown
		expect(pctChangeMin(5, 0, 10)).toBeNull();
	});
	it('reports position change in places, only with enough impressions', () => {
		expect(positionShift({ position: 8.2, impressions: 100 }, { position: 12.2, impressions: 100 })).toBeCloseTo(-4);
		expect(positionShift({ position: 8, impressions: 5 }, { position: 40, impressions: 100 })).toBeNull();
	});
});

describe('calendar filling', () => {
	it('inserts zero days for gaps and keeps real days untouched', () => {
		const rows = [{ date: '2026-01-01', clicks: 4, impressions: 40, position: 9 }, { date: '2026-01-04', clicks: 1, impressions: 10, position: 20 }];
		const f = fillDays(rows, '2026-01-01', '2026-01-05');
		expect(f.map((r) => r.date)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04', '2026-01-05']);
		expect(f[1]).toEqual({ date: '2026-01-02', clicks: 0, impressions: 0, position: 0 });
		expect(f[3].clicks).toBe(1);
	});
});

describe('comparison readiness', () => {
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const d = db();
		d.prepare("INSERT INTO accounts (id, google_sub, email, created_at) VALUES (1,'s','a@b.c',1)").run();
		const mk = (id: number, url: string, done: number, backTo: string | null) =>
			d.prepare("INSERT INTO sites (id, account_id, site_url, permission, synced_through, backfill_done, backfilled_to, created_at) VALUES (?,1,?,'siteOwner','2026-11-03',?,?,1)").run(id, url, done, backTo);
		mk(1, 'sc-domain:loaded.example', 1, '2025-11-10');
		mk(2, 'sc-domain:loading.example', 0, '2026-10-20'); // only the last ~2 weeks downloaded so far
		for (const id of [1, 2]) d.prepare('INSERT INTO site_daily VALUES (?,?,?,?,?)').run(id, '2026-11-03', 10, 100, 5);
	});

	it('knows whether the previous period has been downloaded', () => {
		expect(historyCoversPrevious({ backfill_done: 1, backfilled_to: null }, '2026-01-01')).toBe(true);
		expect(historyCoversPrevious({ backfill_done: 0, backfilled_to: '2026-10-20' }, '2026-09-01')).toBe(false);
		expect(historyCoversPrevious({ backfill_done: 0, backfilled_to: '2026-08-01' }, '2026-09-01')).toBe(true);
		expect(historyCoversPrevious({ backfill_done: 0, backfilled_to: null }, '2026-09-01')).toBe(false);
	});

	it('marks cards and totals as not comparable while any counted site is still loading', () => {
		const cards = siteCards(28);
		expect(cards.find((c) => c.site.id === 1)!.comparable).toBe(true);
		expect(cards.find((c) => c.site.id === 2)!.comparable).toBe(false);
		const t = portfolioTotals(cards);
		expect(t.comparable).toBe(false);
		expect(t.loading).toBe(1);
	});

	it('sparklines are calendar-true: one value per day of the period', () => {
		const card = siteCards(7).find((c) => c.site.id === 1)!;
		expect(card.spark).toHaveLength(7);
		expect(dailySeries(1, addDays('2026-11-03', -6), '2026-11-03')).toHaveLength(7);
	});
});

import { fmtSigned } from '../src/lib/format';
describe('signed percent formatting', () => {
	it('formats normally, uses a real minus sign, and caps absurd increases', () => {
		expect(fmtSigned(0.123)).toBe('+12.3%');
		expect(fmtSigned(-0.5)).toBe('−50.0%');
		expect(fmtSigned(114.118)).toBe('>+999%'); // +11411.8% is noise, not information
		expect(fmtSigned(9.5)).toBe('+950.0%');
		expect(fmtSigned(null)).toBe('–');
	});
});

import { seriesTrend, trendOf } from '../src/lib/trend';
describe('trend colouring', () => {
	const ramp = (a: number, b: number, n = 28) => Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
	it('reads direction from the series when there is no reliable comparison', () => {
		expect(seriesTrend(ramp(2, 20))).toBe('up');
		expect(seriesTrend(ramp(20, 2))).toBe('down');
		expect(seriesTrend(ramp(10, 10.5))).toBe('flat');
		expect(seriesTrend([0, 1, 0, 0, 1, 0, 0, 0])).toBe('flat'); // two clicks never paint a card
		expect(seriesTrend([1, 2])).toBe('flat');
	});
	it('prefers the period-over-period change so the line agrees with the percentage next to it', () => {
		expect(trendOf(0.4, ramp(20, 2))).toBe('up'); // the delta wins over the series shape
		expect(trendOf(-0.2, ramp(2, 20))).toBe('down');
		expect(trendOf(0.012, ramp(20, 2))).toBe('up'); // +1.2% counts as growth, matching the green percentage
		expect(trendOf(0.002, ramp(2, 20))).toBe('flat'); // within ±0.5%
		expect(trendOf(null, ramp(2, 20))).toBe('up');
	});
});
