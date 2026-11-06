import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { setLink } from '../src/lib/server/links';
import { getSite } from '../src/lib/server/clients';
import { organicLandingDaily } from '../src/lib/server/ga4';
import { conversionsFor, ensureGa4PageDaily, toPathScope } from '../src/lib/server/ga4tests';
import { createTest, evaluateTest, evaluateTestCached, listTests } from '../src/lib/server/seotests';
import { buildActions } from '../src/lib/server/actions';
import type { Ga4Source } from '../src/lib/server/channels';
import { parseScope } from '../src/lib/experiments';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { queueDepth } from '../src/lib/server/jobs';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const dates = (from: string, to: string) => { const o: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) o.push(d.toISOString().slice(0, 10)); return o; };
const rng = (seed: number) => { let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd()); const pois = (l: number) => { if (l <= 0) return 0; if (l > 50) return Math.max(0, Math.round(l + Math.sqrt(l) * gauss())); const e = Math.exp(-l); let p = 1, n = 0; do { n++; p *= rnd(); } while (p > e); return n - 1; }; return { pois }; };

describe('GA4 organic landing pages by day', () => {
	beforeEach(() => void (globalThis.__openSiteConsoleDb = openDb(':memory:')));
	const acct = () => upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
	const row = (date: string, page: string, s: number, k: number) => ({ dimensionValues: [{ value: date }, { value: page }], metricValues: [{ value: String(s) }, { value: String(k) }] });

	it('asks for organic sessions and key events by date and landing page, ordered, and merges query-string variants', async () => {
		const id = acct();
		let body: Record<string, any> = {};
		const f = (async (_u: string, init: RequestInit) => (body = JSON.parse(String(init.body)), json({ rows: [row('20260101', '/a?utm=1', 3, 1), row('20260101', '/a', 2, 0.5), row('20260102', '/b/', 4, 2)] }))) as never;
		const r = await organicLandingDaily(id, 'properties/1', '2026-01-01', '2026-01-02', { fetchImpl: f });
		expect(body.dimensions).toEqual([{ name: 'date' }, { name: 'landingPagePlusQueryString' }]);
		expect(body.metrics).toEqual([{ name: 'sessions' }, { name: 'keyEvents' }]);
		expect(body.dimensionFilter.filter).toMatchObject({ fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } });
		expect(body.orderBys).toHaveLength(2); // a stable order is required for offset paging
		expect(r).toEqual([{ date: '2026-01-01', page: '/a', sessions: 5, keyEvents: 1.5 }, { date: '2026-01-02', page: '/b', sessions: 4, keyEvents: 2 }]);
	});
	it('pages through results with offset until a short page', async () => {
		const id = acct();
		const offsets: number[] = [];
		const f = (async (_u: string, init: RequestInit) => {
			const b = JSON.parse(String(init.body));
			offsets.push(b.offset);
			return json({ rows: Array.from({ length: b.offset === 0 ? 100_000 : 7 }, (_, i) => row('20260101', `/p${b.offset + i}`, 1, 0)) });
		}) as never;
		const r = await organicLandingDaily(id, 'properties/1', '2026-01-01', '2026-01-01', { fetchImpl: f });
		expect(offsets).toEqual([0, 100_000]);
		expect(r).toHaveLength(100_007);
	}, 30_000);
	it('compares on paths: full URLs and prefixes become path-only scopes', () => {
		expect(toPathScope({ urls: ['https://www.x.com/a/b?x=1'], prefixes: ['https://x.com/blog/', '/guides/'] })).toEqual({ urls: ['https://ga4.local/a/b'], prefixes: ['https://ga4.local/blog/', '/guides/'] });
	});
});

describe('keeping the data fresh', () => {
	const calls: [string, string][] = [];
	const src = (rows: { date: string; page: string; sessions: number; keyEvents: number }[] = [], fail = false): Ga4Source => ({ organicDaily: async (_p: string, s: string, e: string) => { calls.push([s, e]); if (fail) throw new Error('quota exhausted'); return rows.filter((r) => r.date >= s && r.date <= e); } }) as never;
	beforeEach(async () => {
		calls.length = 0;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
	});
	const meta = () => db().prepare('SELECT from_date f, through_date t, error e FROM ga4_page_meta WHERE site_id = 1').get() as { f: string; t: string; e: string | null } | undefined;

	it('does nothing without GA4 or without tests (the data can be large)', async () => {
		expect((await ensureGa4PageDaily(1, [], src())).skipped).toBe('no tests');
		db().prepare('DELETE FROM site_links').run();
		expect((await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }], src())).skipped).toBe('GA4 is not linked');
		expect(calls).toEqual([]);
		expect(meta()).toBeUndefined();
	});
	it('first load covers what the calibration needs, in 45-day chunks; later loads refresh only the last days, and extend backwards only when a new test needs it', async () => {
		const today = '2026-11-05';
		await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }], src([{ date: '2026-10-01', page: '/a', sessions: 4, keyEvents: 1 }]), today);
		// 5 windows of 28 days before 1 Sep = 2026-04-14; clipped to GA4's usable range, then up to today in 45-day chunks
		expect(calls[0][0]).toBe('2026-04-14');
		expect(calls.at(-1)![1]).toBe(today);
		expect(calls.every(([s, e]) => (Date.parse(e) - Date.parse(s)) / 86400000 <= 44)).toBe(true);
		expect(meta()).toEqual({ f: '2026-04-14', t: today, e: null });
		expect((db().prepare('SELECT COUNT(*) n FROM ga4_page_daily').get() as { n: number }).n).toBe(1);
		calls.length = 0;
		await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }], src(), '2026-11-07');
		expect(calls).toEqual([['2026-10-26', '2026-11-07']]); // only the last 10 days of what was stored, to today
		calls.length = 0;
		await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }, { start_date: '2026-07-01', window_days: 28 }], src(), '2026-11-07');
		expect(calls[0][0]).toBe('2026-02-11'); // the new, earlier test asks for earlier data, in chunks, ending the day before what is stored
		expect(calls.some(([, e]) => e === '2026-04-13')).toBe(true);
		expect(calls.every(([s, e]) => (Date.parse(e) - Date.parse(s)) / 86400000 <= 44)).toBe(true);
		expect(meta()!.f).toBe('2026-02-11');
	});
	it('a failure is recorded, never thrown, and the earlier data stays', async () => {
		await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }], src([{ date: '2026-10-01', page: '/a', sessions: 4, keyEvents: 1 }]), '2026-11-05');
		const r = await ensureGa4PageDaily(1, [{ start_date: '2026-09-01', window_days: 28 }], src([], true), '2026-11-06');
		expect(r.error).toMatch(/quota/);
		expect(meta()).toMatchObject({ t: '2026-11-05', e: 'quota exhausted' });
		expect((db().prepare('SELECT COUNT(*) n FROM ga4_page_daily').get() as { n: number }).n).toBe(1);
	});
});

describe('judging a test on conversions', () => {
	const START = '2026-06-01';
	let seed = 31;
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
	});
	/** GSC clicks and GA4 daily data for 5 test pages and 20 control pages; each arm's post-change factor is set per metric */
	function load(o: { clicksAfter: number; keAfter: number; sessionsAfter?: number; ga4From?: string; ga4: boolean }) {
		const { pois } = rng(seed++);
		const d = db();
		d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
		d.prepare('DELETE FROM ga4_page_daily').run();
		const gsc = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','MOBILE',?,?,5)");
		const ga = d.prepare('INSERT OR REPLACE INTO ga4_page_daily VALUES (1,?,?,?,?)');
		const from = o.ga4From ?? '2025-12-01';
		d.transaction(() => {
			for (const day of dates('2025-12-01', '2026-06-30')) {
				const post = day >= START;
				for (let i = 0; i < 5; i++) {
					gsc.run(day, `q t${i}`, `https://x.example/t/${i}`, pois(8 * (post ? o.clicksAfter : 1)), 160);
					if (o.ga4 && day >= from) ga.run(day, `/t/${i}`, pois(9 * (post ? o.sessionsAfter ?? o.clicksAfter : 1)), pois(3 * (post ? o.keAfter : 1)));
				}
				for (let i = 0; i < 20; i++) {
					gsc.run(day, `q c${i}`, `https://x.example/c/${i}`, pois(10), 200);
					if (o.ga4 && day >= from) ga.run(day, `/c/${i}`, pois(11), pois(1.4));
				}
			}
		})();
		d.prepare("UPDATE sites SET synced_through = '2026-06-30', backfill_done = 1, last_sync_at = 5 WHERE id = 1").run();
		if (o.ga4) {
			setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
			d.prepare("INSERT OR REPLACE INTO ga4_page_meta VALUES (1, ?, '2026-06-30', ?, NULL)").run(from, Date.now());
		}
		createTest(1, { name: 'Titles', kind: 'before_after', startDate: START, treatment: parseScope('/t/') });
		return getSite(1)!;
	}
	const conv = (site: ReturnType<typeof getSite>) => evaluateTest(site!, listTests(1)[0]).conversions;

	it('says why there is no conversion result: no GA4, still loading, a read error, or not enough history', () => {
		let site = load({ clicksAfter: 1.4, keAfter: 1, ga4: false });
		expect(conv(site)).toMatchObject({ status: 'no-ga4', keyEvents: null });
		expect(conv(site).note).toMatch(/Link a GA4/);
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
		expect(conv(site)).toMatchObject({ status: 'loading' });
		db().prepare("INSERT INTO ga4_page_meta VALUES (1, NULL, NULL, 1, 'quota exhausted')").run();
		expect(conv(site)).toMatchObject({ status: 'error' });
		expect(conv(site).note).toMatch(/quota exhausted/);
		site = load({ clicksAfter: 1.4, keAfter: 1, ga4: true, ga4From: '2026-05-15' });
		expect(conv(site)).toMatchObject({ status: 'partial' });
		expect(conv(site).note).toMatch(/does not cover the 28 days before the change/);
	});

	it('finds a planted +50% change in key events with sessions flat, and reports the rate', () => {
		const site = load({ clicksAfter: 1, keAfter: 1.5, sessionsAfter: 1, ga4: true });
		const c = conv(site);
		expect(c.status).toBe('ok');
		expect(c.keyEvents!.verdict).toBe('positive');
		expect(c.keyEvents!.lift!).toBeGreaterThan(0.3);
		expect(c.sessions!.verdict).toBe('inconclusive'); // sessions did not move
		expect(c.rate!.after!).toBeGreaterThan(c.rate!.before! * 1.3);
		expect(c.coverage).toEqual({ from: '2025-12-01', through: '2026-06-30' });
	});

	it('does not credit a change when key events and the control move together', () => {
		const site = load({ clicksAfter: 1, keAfter: 1, ga4: true });
		expect(conv(site).keyEvents!.verdict).toBe('inconclusive');
	});

	it('when clicks rise but key events fall, says so loudly (the case that matters most) and queues a warning instead of a roll-out', () => {
		const site = load({ clicksAfter: 1.5, keAfter: 0.5, sessionsAfter: 1.5, ga4: true });
		const o = evaluateTest(site, listTests(1)[0]);
		expect(o.clicks.verdict).toBe('positive');
		expect(o.conversions.keyEvents!.verdict).toBe('negative');
		const items = buildActions(site).filter((i) => i.type === 'test');
		expect(items.map((i) => i.key)).toEqual([`test:${listTests(1)[0].id}:conflict`]); // no "roll out" item
		expect(items[0].title).toMatch(/more clicks, fewer conversions/);
		expect(items[0].how).toMatch(/Do not roll it out on clicks alone/);
	});

	it('a change in the stored GA4 data recomputes a cached test', () => {
		const site = load({ clicksAfter: 1, keAfter: 1.5, ga4: true });
		const first = evaluateTestCached(site, listTests(1)[0]);
		expect(first.conversions.keyEvents!.verdict).toBe('positive');
		db().prepare("UPDATE seo_test_results SET outcome = ?").run(JSON.stringify({ ...first, treatmentPages: 999 }));
		expect(evaluateTestCached(site, listTests(1)[0]).treatmentPages).toBe(999); // cached
		db().prepare("UPDATE ga4_page_meta SET pulled_at = pulled_at + 1").run(); // GA4 was read again
		expect(evaluateTestCached(site, listTests(1)[0]).treatmentPages).toBe(5);
	});
});

describe('end to end on demo data', () => {
	it('creating a test loads GA4 for it and judges it on conversions', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		let guard = 0;
		await syncSite(1, { client, backfillChunkDays: 120 });
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
		await autoMatchGa4();
		const end = Date.now() + 30_000;
		while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
		createTest(1, { name: 'Guides', kind: 'before_after', startDate: '2026-09-20', treatment: parseScope('/guides/') });
		const r = await ensureGa4PageDaily(1, listTests(1).map((t) => ({ start_date: t.start_date, window_days: t.window_days })));
		expect(r.error).toBeNull();
		expect(r.pulled).toBeGreaterThan(100);
		const c = evaluateTest(getSite(1)!, listTests(1)[0]).conversions;
		expect(c.status).toBe('ok');
		expect(c.sessions!.totals.tPre).toBeGreaterThan(50);
		expect(c.keyEvents).toHaveProperty('verdict');
	}, 120_000);
});
