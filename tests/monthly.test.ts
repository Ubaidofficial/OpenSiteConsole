import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { buildMonthSite, buildMonthlyReport, listDigests, reportMonth, runMonthlyReport } from '../src/lib/server/digest';
import { allSites } from '../src/lib/server/queries';
import { monthLabel, monthlyHeadline, monthSentence, perDayChange, renderMonthly, type MonthSite } from '../src/lib/digest';

const ms = (o: Partial<MonthSite> = {}): MonthSite => ({
	siteId: 1, name: 'a.example', complete: true, days: 31, clicks: 3100, impressions: 1, position: 5,
	prev: { days: 30, clicks: 3000, impressions: 1, position: 5 }, yearAgo: null,
	pageWinners: [], pageLosers: [], queryWinners: [], queryLosers: [], droppedPages: 0, decidedTests: [], updates: [], openActions: 0, blockingActions: 0, ...o
});

describe('monthly report wording', () => {
	it('compares per day, because months differ in length', () => {
		// 3,100 in 31 days against 3,000 in 30 days is exactly 100 a day both times: no change.
		expect(perDayChange(3100, 31, 3000, 30).change).toBeCloseTo(0, 10);
		expect(perDayChange(3100, 31, 3000, 30).significant).toBe(false);
		const up = perDayChange(4650, 31, 3000, 30); // 150 a day against 100
		expect(up.change).toBeCloseTo(0.5, 10);
		expect(up.significant).toBe(true);
		expect(perDayChange(10, 31, 0, 30)).toEqual({ change: null, significant: false });
	});
	it('a site sentence says "about the same" for wobble, names real changes, and the same month last year', () => {
		expect(monthSentence(ms(), '2026-10')).toBe('a.example: 3,100 clicks from Google in October, about the same as September (within normal variation).');
		const s = monthSentence(ms({ clicks: 4650, yearAgo: { days: 31, clicks: 3100 }, position: 4.2, prev: { days: 30, clicks: 3000, impressions: 1, position: 5.4 }, pageWinners: [{ key: '/guide', change: 900 }], pageLosers: [{ key: '/old', change: -120 }] }), '2026-10');
		expect(s).toContain('4,650 clicks from Google in October, up 50% a day on September and 50% above October last year.');
		expect(s).toContain('Average position improved from 5.4 to 4.2.');
		expect(s).toContain('Biggest gain: /guide (+900 clicks). Biggest loss: /old (-120 clicks).');
	});
	it('claims nothing for an incomplete month or a missing previous month; January compares with December', () => {
		expect(monthSentence(ms({ complete: false }), '2026-10')).toMatch(/does not reach the end of October yet, so no comparison is made/);
		expect(monthSentence(ms({ prev: null }), '2026-10')).toMatch(/September is not stored, so there is no comparison/);
		expect(monthSentence(ms(), '2027-01')).toMatch(/about the same as December/);
		expect(monthLabel('2026-10')).toBe('October 2026');
	});
	it('headline: portfolio total, blocking items, dropped pages, updates and partial sites', () => {
		const h = monthlyHeadline(
			[ms({ blockingActions: 1, droppedPages: 2, updates: [{ name: 'October 2026 core update', begin: '2026-10-10', end: null }] }), ms({ name: 'b.example', complete: false })],
			[{ key: 'k', type: 'robots', title: 'robots.txt blocks Googlebot from 3 pages', blocking: true, impact: 40, confidence: 'high', href: '/sites/1/sitemaps#robots', site: 'a.example', siteId: 1 }],
			'2026-10'
		).join(' ');
		expect(h).toContain('Across 1 site, Google sent 3,100 clicks in October, about the same a day as in September.');
		expect(h).toContain('1 blocking issue needs fixing first: a.example: robots.txt blocks Googlebot from 3 pages.');
		expect(h).toContain('2 pages were dropped from Google\'s index during October.');
		expect(h).toContain('October 2026 core update overlapped October');
		expect(h).toContain('1 site is not complete for October yet');
	});
	it('the chat message escapes text that came from websites', () => {
		const r = { createdAt: 0, month: '2026-10', label: 'October 2026', headline: [], sites: [ms({ name: '<!channel> x.example' })], top: [] };
		const t = renderMonthly(r, 'https://app.example');
		expect(t).toMatch(/^\*SEO report for October 2026\*/);
		expect(t).not.toContain('<!channel>');
	});
	it('the report month is the last complete calendar month', () => {
		expect(reportMonth('2026-11-08')).toBe('2026-10');
		expect(reportMonth('2027-01-04')).toBe('2026-12');
	});
});

describe('monthly report from stored data', () => {
	const env = { ...process.env };
	afterEach(() => { process.env = { ...env }; });
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		let guard = 0;
		await syncSite(1, { client, backfillChunkDays: 120 });
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	}, 180_000);

	it('a complete month is compared with the stored month before; paths, not full URLs, name pages', () => {
		const ym = reportMonth(getSite(1)!.synced_through!);
		const s = buildMonthSite(getSite(1)!, ym);
		expect(s.complete).toBe(true);
		expect(s.clicks).toBeGreaterThan(0);
		expect(s.prev?.clicks).toBeGreaterThan(0);
		expect(s.days).toBe(Number(new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate()));
		for (const m of [...s.pageWinners, ...s.pageLosers]) expect(m.key.startsWith('/')).toBe(true);
		// A month the data does not reach the end of is not complete, so nothing is claimed about it.
		const later = buildMonthSite(getSite(1)!, '2099-01');
		expect(later.complete).toBe(false);
		expect(later.prev).toBeNull();
		const r = buildMonthlyReport(ym, [getSite(1)!]);
		expect(r.headline.length).toBeGreaterThan(0);
		expect(r.label).toBe(monthLabel(ym));
	});

	it('an automatic report waits for data that does not reach the month end, until the 10th; by hand it does not wait', async () => {
		delete process.env.DIGEST_WEBHOOK_URL;
		// Only site 1 is synced in this test; the other demo sites have no data at all, as on a fresh install.
		expect(allSites().some((s) => !s.synced_through)).toBe(true);
		const waiting = await runMonthlyReport({ today: '2026-11-05' });
		expect(waiting.created).toBe(false);
		expect(waiting.message).toMatch(/^Waiting for \d+ sites? to sync through 2026-10-31\.$/);
		expect(listDigests('monthly')).toHaveLength(0);
		const late = await runMonthlyReport({ today: '2026-11-10' });
		expect(late.created).toBe(true);
		expect(listDigests('monthly')[0].monthly!.sites.some((s) => !s.complete)).toBe(true); // the late ones are flagged, not hidden
		db().prepare("DELETE FROM digests WHERE kind = 'monthly'").run();
	});

	it('(from here on only the synced site is visible, as on an install whose sync has caught up)', () => {
		db().prepare('UPDATE sites SET hidden = 1 WHERE synced_through IS NULL').run();
		expect(allSites().every((s) => !!s.synced_through)).toBe(true);
	});

	it('is made once from the 4th, stored with its month, and not before', async () => {
		delete process.env.DIGEST_WEBHOOK_URL;
		expect((await runMonthlyReport({ today: '2026-11-03' })).created).toBe(false);
		const a = await runMonthlyReport({ today: '2026-11-04' });
		expect(a.created).toBe(true);
		expect(a.delivery).toBe('none');
		expect((await runMonthlyReport({ today: '2026-11-20' })).created).toBe(false); // already made for October
		const stored = listDigests('monthly');
		expect(stored).toHaveLength(1);
		expect(stored[0].weekKey).toBe('2026-10');
		expect(stored[0].monthly?.month).toBe('2026-10');
		expect(listDigests('weekly')).toHaveLength(0); // kept apart from the weekly digests
		process.env.DIGEST_MONTHLY = '0';
		expect((await runMonthlyReport({ today: '2026-12-05' })).created).toBe(false);
		expect((await runMonthlyReport({ today: '2026-12-05', force: true })).created).toBe(true); // by hand it still works
		db().prepare("DELETE FROM digests WHERE kind = 'monthly'").run();
	});

	it('delivers to the webhook and retries a failed delivery at most hourly', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/x';
		const bodies: string[] = [];
		let ok = false;
		const f = (async (_u: unknown, init: RequestInit) => { bodies.push(String(init.body)); return new Response('', { status: ok ? 200 : 500 }); }) as typeof fetch;
		expect((await runMonthlyReport({ today: '2026-11-05', fetchImpl: f })).delivery).toBe('failed');
		expect(JSON.parse(bodies[0]).text).toMatch(/^\*SEO report for October 2026\*/);
		ok = true;
		expect((await runMonthlyReport({ today: '2026-11-05', fetchImpl: f })).delivery).toBe('sent'); // first retry is allowed
		expect(listDigests('monthly')[0].delivery).toBe('sent');
	});
});
