import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { queueDepth } from '../src/lib/server/jobs';
import { getSite } from '../src/lib/server/clients';
import { aiTrafficReport, countryCannibalReport, forecastReport, groupsReport, heatmapReport, localesReport, trajectories, trendsReport, urlClassesReport } from '../src/lib/server/insights';
import { createTest, deleteTest, evaluateTest, listTests, suggestControl } from '../src/lib/server/seotests';
import { indexSummary, monitorSite, recentEvents } from '../src/lib/server/indexmon';
import { checkUrls, fetchPage, storedChecks } from '../src/lib/server/onpage';
import { GoogleApiError, type GscClient } from '../src/lib/server/google';
import { parseScope } from '../src/lib/experiments';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { assistantOf } from '../src/lib/ai';
import { aiAssistantTraffic } from '../src/lib/server/ga4';
import { upsertGoogleAccount } from '../src/lib/server/accounts';

const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// ── demo-data reports ────────────────────────────────────────────────────────
describe('reports over demo data', () => {
	let key = '';
	const call = async (name: string, args: object = {}) => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
	};
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const id of [1, 2, 3]) {
			const client = new DemoClient('demo-a');
			let guard = 0;
			await syncSite(id, { client, backfillChunkDays: 120 });
			while (!getSite(id)!.backfill_done && guard++ < 12) await syncSite(id, { client, backfillChunkDays: 120 });
		}
		await autoMatchGa4();
		await drain();
		key = createApiKey('all', null).key;
	}, 120_000);
	const site = () => getSite(1)!;

	it('trends: movers are significant, bands add up, questions are questions', () => {
		const t = trendsReport(site(), 28);
		for (const m of [...t.queryMovers.winners, ...t.queryMovers.losers]) expect(Math.abs(m.z)).toBeGreaterThanOrEqual(2);
		expect(t.queryMovers.winners.every((m) => m.change > 0)).toBe(true);
		expect(t.bands.now.reduce((a, b) => a + b.queries, 0)).toBeGreaterThan(0);
		expect(t.questions.rows.every((r) => /^(who|what|when|where|why|how|which|can|could|should|would|will|do|does|did|is|are|was|were|has|have|may|am)\b/i.test(r.query) || r.query.includes('?'))).toBe(true);
	});
	it('forecast: 26 complete weeks, an 8-week damped projection, never negative', () => {
		const f = forecastReport(site());
		expect(f.weekly).toHaveLength(26);
		expect(f.projection!.points).toHaveLength(8);
		expect(f.weekly.every((w) => w.clicks > 0)).toBe(true); // a real history, not 26 empty weeks
		expect(f.projection!.points[0].clicks).toBeGreaterThan(0);
		expect(f.projection!.points.every((p) => p.low >= 0 && p.high >= p.clicks && p.clicks >= p.low)).toBe(true);
	});
	it('trajectories cover the top queries with a direction each', () => {
		const t = trajectories(site(), 5);
		expect(t).toHaveLength(5);
		expect(t.every((x) => x.weekly.length === 12 && typeof x.direction === 'string')).toBe(true);
	});
	it('groups: folders from URL paths, topics from queries, heatmap over complete months', () => {
		const g = groupsReport(site(), 90);
		expect(g.groups.map((x) => x.key)).toEqual(expect.arrayContaining(['/guides/', '/products/']));
		expect(g.groups.reduce((a, x) => a + x.clicks, 0)).toBeGreaterThan(0);
		expect(g.topics.clusters.length).toBeGreaterThan(0);
		const h = heatmapReport(site());
		expect(h.months.length).toBeGreaterThanOrEqual(6);
		expect(h.rows.length).toBeGreaterThan(0);
		expect(h.rows[0].months).toHaveLength(h.months.length);
		const hp = heatmapReport(site(), 'page');
		expect(hp.rows.every((r) => r.key.startsWith('http'))).toBe(true);
	});
	it('locales and country cannibalization run on data without locale folders', () => {
		expect(localesReport(site(), 28)).toEqual([]);
		const c = countryCannibalReport(site(), 28);
		expect(Array.isArray(c)).toBe(true);
		for (const g of c) expect(g.pages.length).toBeGreaterThanOrEqual(2);
	});
	it('url classes: every page is classed once and the counts add up', () => {
		const u = urlClassesReport(site(), 28);
		expect(Object.values(u.counts).reduce((a, b) => a + b, 0)).toBeGreaterThan(10);
		expect(u.rows.every((r) => r.cls !== 'healthy')).toBe(true);
	});
	it('AI traffic is stored per assistant after the GA4 sync, ChatGPT first', () => {
		const t = aiTrafficReport(site(), 28);
		expect(t.linked).toBe(true);
		if (!t.linked || t.status !== 'ok') throw new Error('expected a finished AI report, got ' + (t.linked ? t.status : 'unlinked'));
		expect(t.sessions).toBeGreaterThan(0);
		expect(t.assistants[0].assistant).toBe('ChatGPT');
		expect(t.shareOfAllSessions!).toBeLessThan(0.2);
		expect(aiTrafficReport(getSite(3)!, 28).linked).toBe(true);
	});

	it('MCP: every new tool answers, with the right shape', async () => {
		const get = async (name: string, args: object) => {
			const r = await call(name, { site: 'greenleaf.example', ...args });
			expect(r.isError, `${name} ${JSON.stringify(args)}: ${r.data}`).toBe(false);
			return r.data;
		};
		for (const view of ['movers', 'new_lost', 'bands', 'questions', 'trajectories', 'forecast']) await get('get_trends', { view });
		expect((await get('get_trends', { view: 'forecast' })).projection).toHaveLength(8);
		expect((await call('get_trends', { site: '1', view: 'nope' })).isError).toBe(true);
		for (const view of ['folders', 'topics', 'heatmap', 'locales', 'country_cannibalization']) await get('get_content_groups', { view });
		expect((await get('get_ai_traffic', {})).assistants.length).toBeGreaterThan(0);
		expect(await get('get_seo_tests', {})).toEqual([]);
		expect((await get('get_indexing_status', { view: 'summary' })).monitoring).toBe(false);
		expect(await get('get_indexing_status', { view: 'events' })).toEqual([]);
		expect((await get('get_indexing_status', { view: 'performance' })).counts).toBeDefined();
		expect((await get('get_onpage_check', {})).checked).toBe(0);
		const q = await get('get_top_queries', { questions: true, limit: 50 });
		expect(q.every((r: { query: string }) => /^(who|what|when|where|why|how|which|can|could|should|would|will|do|does|did|is|are|was|were|has|have|may|am)\b/i.test(r.query) || r.query.includes('?'))).toBe(true);
		expect((await call('get_trends', { site: '2', view: 'bands' })).isError).toBe(false);
	});
});

// ── SEO tests on controlled data ─────────────────────────────────────────────
describe('SEO tests', () => {
	const START = '2026-06-01';
	let seed = 99;
	const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
	const pois = (lam: number) => {
		if (lam <= 0) return 0;
		const l = Math.exp(-lam);
		let p = 1, n = 0;
		do { n++; p *= rnd(); } while (p > l);
		return n - 1;
	};
	const dates = (from: string, to: string) => { const o: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) o.push(d.toISOString().slice(0, 10)); return o; };

	/** pages: t = test pages, c = control pages; factor per arm after START */
	function load(o: { tMean: number; tAfter: number; cMean: number; cAfter: number; extra?: (ins: (date: string, page: string, clicks: number) => void) => void; endDate?: string }) {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		return ensureDemoAccounts().then(() => {
			const d = db();
			d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
			const ins = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','DESKTOP',?,?,5)");
			const put = (date: string, page: string, clicks: number) => ins.run(date, 'q ' + page, page, clicks, clicks * 20);
			const end = o.endDate ?? '2026-06-30';
			d.transaction(() => {
				for (const day of dates('2025-12-01', end)) {
					const post = day >= START;
					for (let i = 0; i < 5; i++) put(day, `https://x.example/t/${i}`, pois(o.tMean * (post ? o.tAfter : 1)));
					for (let i = 0; i < 20; i++) put(day, `https://x.example/c/${i}`, pois(o.cMean * (post ? o.cAfter : 1)));
				}
				o.extra?.(put);
			})();
			d.prepare('UPDATE sites SET synced_through = ?, backfill_done = 1 WHERE id = 1').run(end);
			return getSite(1)!;
		});
	}
	const scope = (s: string) => parseScope(s);

	it('finds a planted +40% lift on the test pages when the control is flat', async () => {
		const site = await load({ tMean: 8, tAfter: 1.4, cMean: 10, cAfter: 1 });
		const id = createTest(1, { name: 'New titles', kind: 'before_after', startDate: START, treatment: scope('/t/') });
		const out = evaluateTest(site, listTests(1)[0]);
		expect(id).toBeGreaterThan(0);
		expect(out.postDays).toBe(28); // 1 Jun .. 28 Jun: the 28-day window caps it, though data runs to 30 Jun
		expect(out.clicks.verdict).toBe('positive');
		expect(out.clicks.lift!).toBeGreaterThan(0.25);
		expect(out.clicks.lift!).toBeLessThan(0.6);
		expect(out.clicks.ciLow!).toBeGreaterThan(0);
		expect(out.treatmentPages).toBe(5);
		expect(out.controlPages).toBe(20);
		expect(out.series.length).toBe(28 + out.postDays);
		expect(out.series[27].treatment).toBeGreaterThan(70); // around 100 right before the change
	});

	it('does not credit a site-wide rise to the test pages', async () => {
		const site = await load({ tMean: 8, tAfter: 1.4, cMean: 10, cAfter: 1.4 });
		createTest(1, { name: 'Nothing special', kind: 'before_after', startDate: START, treatment: scope('/t/') });
		const out = evaluateTest(site, listTests(1)[0]);
		expect(out.clicks.verdict).toBe('inconclusive');
		expect(Math.abs(out.clicks.lift!)).toBeLessThan(0.2);
	});

	it('finds a planted drop', async () => {
		const site = await load({ tMean: 8, tAfter: 0.5, cMean: 10, cAfter: 1 });
		createTest(1, { name: 'Bad rewrite', kind: 'before_after', startDate: START, treatment: scope('/t/') });
		expect(evaluateTest(site, listTests(1)[0]).clicks.verdict).toBe('negative');
	});

	it('split test with an explicit control group, and suggested control pages match on traffic', async () => {
		const site = await load({ tMean: 8, tAfter: 1.4, cMean: 10, cAfter: 1, extra: (put) => { for (const day of dates('2025-12-01', '2026-06-30')) put(day, 'https://x.example/big', 500); } });
		const suggested = suggestControl(site, scope('/t/'), START);
		expect(suggested.length).toBeGreaterThanOrEqual(15);
		expect(suggested.slice(0, 15)).not.toContain('https://x.example/big'); // a 500/day page is a poor match for 8/day pages
		createTest(1, { name: 'Split', kind: 'split', startDate: START, treatment: scope('/t/'), control: { prefixes: [], urls: suggested } });
		const out = evaluateTest(site, listTests(1)[0]);
		expect(out.controlPages).toBe(suggested.filter((u) => u !== 'https://x.example/big').length + (suggested.includes('https://x.example/big') ? 1 : 0));
		expect(out.clicks.verdict).toBe('positive');
	});

	it('a control that overlaps the test pages never counts them twice', async () => {
		const site = await load({ tMean: 8, tAfter: 1.4, cMean: 10, cAfter: 1 });
		createTest(1, { name: 'Overlap', kind: 'split', startDate: START, treatment: scope('/t/'), control: scope('/') }); // "/" matches every page
		const out = evaluateTest(site, listTests(1)[0]);
		expect(out.treatmentPages).toBe(5);
		expect(out.controlPages).toBe(20); // the 5 test pages are not in the control
		expect(out.clicks.verdict).toBe('positive');
	});

	it('a redirect test measures old and new together, so moved traffic is not a loss', async () => {
		// /t/0-1 are "old" and go to zero at START; their traffic reappears at /n/ pages.
		const site = await load({
			tMean: 0, tAfter: 1, cMean: 10, cAfter: 1,
			extra: (put) => {
				for (const day of dates('2025-12-01', '2026-06-30')) {
					for (let i = 0; i < 4; i++) {
						put(day, `https://x.example/old/${i}`, day < START ? pois(8) : 0);
						put(day, `https://x.example/new/${i}`, day < START ? 0 : pois(8));
					}
				}
			}
		});
		createTest(1, { name: 'Move /old to /new', kind: 'switch', startDate: START, treatment: { prefixes: [], urls: [] }, old: scope('/old/'), new: scope('/new/') });
		const out = evaluateTest(site, listTests(1)[0]);
		expect(out.parts!.oldPost).toBe(0);
		expect(out.parts!.newPre).toBe(0);
		expect(out.parts!.newPost).toBeGreaterThan(500);
		expect(out.clicks.verdict).toBe('inconclusive');
		expect(Math.abs(out.clicks.lift!)).toBeLessThan(0.2);
	});

	it('a redirect that loses the traffic shows as a drop', async () => {
		const site = await load({
			tMean: 0, tAfter: 1, cMean: 10, cAfter: 1,
			extra: (put) => {
				for (const day of dates('2025-12-01', '2026-06-30')) for (let i = 0; i < 4; i++) {
					put(day, `https://x.example/old/${i}`, day < START ? pois(8) : 0);
					put(day, `https://x.example/new/${i}`, day < START ? 0 : pois(2));
				}
			}
		});
		createTest(1, { name: 'Lossy move', kind: 'switch', startDate: START, treatment: { prefixes: [], urls: [] }, old: scope('/old/'), new: scope('/new/') });
		expect(evaluateTest(site, listTests(1)[0]).clicks.verdict).toBe('negative');
	});

	it('too little time or data gives no verdict, and a test dated in the future is handled', async () => {
		const site = await load({ tMean: 8, tAfter: 1.4, cMean: 10, cAfter: 1, endDate: '2026-06-04' });
		createTest(1, { name: 'Fresh', kind: 'before_after', startDate: START, treatment: scope('/t/') });
		const fresh = evaluateTest(site, listTests(1)[0]);
		expect(fresh.postDays).toBe(4);
		expect(fresh.clicks.verdict).toBe('too-little-data');
		createTest(1, { name: 'Future', kind: 'before_after', startDate: '2026-12-01', treatment: scope('/t/') });
		const future = evaluateTest(site, listTests(1)[0]);
		expect(future.postDays).toBe(0);
		expect(future.postRange).toBeNull();
		expect(future.clicks.verdict).toBe('too-little-data');
	});

	it('validates input and deletes only within its own site', async () => {
		await load({ tMean: 8, tAfter: 1, cMean: 10, cAfter: 1 });
		expect(() => createTest(1, { name: ' ', kind: 'split', startDate: START, treatment: scope('/t/') })).toThrow(/name/);
		expect(() => createTest(1, { name: 'x', kind: 'split', startDate: 'yesterday', treatment: scope('/t/') })).toThrow(/YYYY-MM-DD/);
		expect(() => createTest(1, { name: 'x', kind: 'split', startDate: START, treatment: scope('') })).toThrow(/Say which pages/);
		expect(() => createTest(1, { name: 'x', kind: 'switch', startDate: START, treatment: scope(''), old: scope('/a/') })).toThrow(/old URLs and the new/);
		const id = createTest(1, { name: 'keep', kind: 'before_after', startDate: START, treatment: scope('/t/'), windowDays: 9999 });
		expect(listTests(1)[0].window_days).toBe(90); // clamped
		deleteTest(2, id);
		expect(listTests(1)).toHaveLength(1);
		deleteTest(1, id);
		expect(listTests(1)).toHaveLength(0);
	});
});

// ── indexing monitor ─────────────────────────────────────────────────────────
describe('indexing monitor', () => {
	const stub = (verdicts: Record<string, string>, calls: string[] = [], dflt = 'PASS'): GscClient =>
		({
			inspectUrl: async (_s: string, url: string) => {
				calls.push(url);
				const v = verdicts[url] ?? dflt;
				if (v === 'QUOTA') throw new GoogleApiError('quota', 429, 'RESOURCE_EXHAUSTED');
				if (v === 'BOOM') throw new Error('network');
				return { indexStatusResult: { verdict: v, coverageState: v === 'PASS' ? 'Indexed' : 'Crawled - currently not indexed', robotsTxtState: 'ALLOWED', pageFetchState: 'SUCCESSFUL', googleCanonical: url } };
			}
		}) as never;
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
	}, 60_000);

	it('records de-indexing, re-indexing and canonical swaps between runs, and never on the first look', async () => {
		const first = await monitorSite(1, { client: stub({}), limit: 200 }); // enough to cover every candidate page
		expect(first).toMatchObject({ events: 0, errors: 0 });
		const n = first.checked;
		expect(n).toBeGreaterThan(8);
		expect(recentEvents(1)).toEqual([]);
		const urls = (db().prepare('SELECT url FROM url_inspections WHERE site_id = 1').all() as { url: string }[]).map((r) => r.url);
		expect(urls).toHaveLength(n);
		const second = await monitorSite(1, { client: stub({ [urls[0]]: 'NEUTRAL' }), limit: 200, force: true });
		expect(second).toMatchObject({ checked: n, events: 1 });
		expect(recentEvents(1)[0]).toMatchObject({ url: urls[0], kind: 'deindexed' });
		expect(indexSummary(1)).toMatchObject({ checked: n, counts: { indexed: n - 1, not_indexed: 1 } });
		await monitorSite(1, { client: stub({}), limit: 200, force: true });
		expect(recentEvents(1)[0].kind).toBe('indexed');
		expect(db().prepare('SELECT index_checked_on c FROM sites WHERE id = 1').get()).toEqual({ c: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
	});

	it('checks the least recently inspected URLs first and respects the daily cache unless forced', async () => {
		const calls: string[] = [];
		await monitorSite(1, { client: stub({}, calls), limit: 5 });
		expect(calls).toHaveLength(5);
		const again: string[] = [];
		await monitorSite(1, { client: stub({}, again), limit: 5 });
		expect(again.filter((u) => calls.includes(u))).toEqual([]); // fresh results are not re-spent; new URLs are taken instead
		expect(again).toHaveLength(5);
	});

	it('a quota error stops the run, and a failed call keeps the last good result', async () => {
		await monitorSite(1, { client: stub({}), limit: 3 });
		const snapshot = () => db().prepare('SELECT url, result FROM url_inspections WHERE site_id = 1 ORDER BY url').all();
		const before = snapshot();
		expect(before).toHaveLength(3);
		const r = await monitorSite(1, { client: stub({}, [], 'BOOM'), limit: 200, force: true });
		expect(r.checked).toBe(0);
		expect(r.errors).toBeGreaterThan(3);
		expect(snapshot()).toEqual(before); // nothing was overwritten or added
		const calls: string[] = [];
		const q = await monitorSite(1, { client: stub({}, calls, 'QUOTA'), limit: 200, force: true });
		expect(q.stoppedEarly).toMatch(/quota/i);
		expect(calls.length).toBeLessThanOrEqual(6); // three workers each make at most one more call before they notice
	});
});

// ── on-page fetch and check ──────────────────────────────────────────────────
describe('on-page fetching is confined to the site', () => {
	const SITE = 'sc-domain:greenleaf.example';
	const html = (body = '') => new Response(`<html lang="en"><head><title>Hello there world</title></head><body><h1>Hi</h1>${body}</body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });

	it('refuses other hosts, non-http schemes and cross-site redirects without fetching them', async () => {
		const f = vi.fn(async () => html());
		expect((await fetchPage('https://evil.example/', SITE, f as never)).error).toMatch(/not on this site/);
		expect((await fetchPage('http://169.254.169.254/latest/meta-data', SITE, f as never)).error).toMatch(/not on this site/);
		expect((await fetchPage('file:///etc/passwd', SITE, f as never)).error).toMatch(/http and https/);
		expect((await fetchPage('http://localhost:8080/', SITE, f as never)).error).toMatch(/not on this site/);
		expect(f).not.toHaveBeenCalled();
		const redirecting = vi.fn(async (u: string) => (u.includes('greenleaf') ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }) : html()));
		const r = await fetchPage('https://greenleaf.example/a', SITE, redirecting as never);
		expect(r.error).toMatch(/not part of this site/);
		expect(redirecting).toHaveBeenCalledTimes(1);
	});

	it('follows same-site redirects by hand, with a hop limit', async () => {
		const f = vi.fn(async (u: string) => (u.endsWith('/old') ? new Response(null, { status: 301, headers: { location: '/new' } }) : html()));
		const r = await fetchPage('https://www.greenleaf.example/old', SITE, f as never);
		expect(r.finalUrl).toBe('https://www.greenleaf.example/new');
		expect(r.html).toContain('Hello there world');
		expect((f.mock.calls[0] as unknown[])[1]).toMatchObject({ redirect: 'manual' });
		const loop = vi.fn(async () => new Response(null, { status: 302, headers: { location: '/again' } }));
		expect((await fetchPage('https://greenleaf.example/x', SITE, loop as never)).error).toMatch(/Too many redirects/);
	});

	it('handles errors, non-HTML, timeouts and enormous pages', async () => {
		expect((await fetchPage('https://greenleaf.example/', SITE, (async () => new Response('x', { status: 404 })) as never)).error).toMatch(/404/);
		expect((await fetchPage('https://greenleaf.example/', SITE, (async () => new Response('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })) as never)).error).toMatch(/Not an HTML/);
		expect((await fetchPage('https://greenleaf.example/', SITE, (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as never)).error).toMatch(/Timed out/);
		const huge = (async () => new Response('<html><title>t</title>' + 'x'.repeat(5_000_000), { status: 200, headers: { 'content-type': 'text/html' } })) as never;
		const r = await fetchPage('https://greenleaf.example/', SITE, huge);
		expect(r.html!.length).toBeLessThan(1_700_000);
	});
});

describe('on-page check end to end (demo pages)', () => {
	it('stores a check per page with the queries it ranks for, and reports failures per URL', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
		const pages = (db().prepare('SELECT page FROM sa_rows WHERE site_id = 1 GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 12').all() as { page: string }[]).map((r) => r.page);
		const r = await checkUrls(1, [...pages, 'https://elsewhere.example/'], { max: 20 });
		expect(r.ok + r.failed).toBe(13);
		expect(r.failed).toBeGreaterThanOrEqual(1); // the off-site URL at least
		const rows = storedChecks(1);
		expect(rows).toHaveLength(13);
		const offsite = rows.find((x) => x.url === 'https://elsewhere.example/')!;
		expect(offsite.error).toMatch(/not on this site/);
		expect(offsite.score).toBeNull();
		const good = rows.find((x) => x.parsed)!;
		expect(good.queries!.length).toBeGreaterThan(0);
		expect(good.queries![0]).toHaveProperty('title');
		expect(rows.some((x) => (x.issues ?? []).length > 0)).toBe(true);
		expect(rows.filter((x) => x.score != null).every((x) => x.score! >= 0 && x.score! <= 100)).toBe(true);
	});
});

// ── GA4 AI traffic parsing ───────────────────────────────────────────────────
describe('AI assistant traffic from GA4', () => {
	it('names assistants by referrer and leaves everything else out', () => {
		expect(assistantOf('chatgpt.com')).toBe('ChatGPT');
		expect(assistantOf('chat.openai.com')).toBe('ChatGPT');
		expect(assistantOf('perplexity.ai')).toBe('Perplexity');
		expect(assistantOf('gemini.google.com')).toBe('Gemini');
		expect(assistantOf('claude.ai')).toBe('Claude');
		expect(assistantOf('copilot.microsoft.com')).toBe('Copilot');
		for (const s of ['google', 'bing', '(direct)', 'newsletter', 'facebook.com', '']) expect(assistantOf(s), s).toBeNull();
	});
	it('sends a regex filter on session source, merges query-string variants and drops unrecognised rows', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		const row = (src: string, page: string, ...m: number[]) => ({ dimensionValues: [{ value: src }, { value: page }], metricValues: m.map((value) => ({ value: String(value) })) });
		let body: Record<string, any> = {};
		const f = vi.fn(async (_u: string, init: RequestInit) => {
			body = JSON.parse(String(init.body));
			return json({ rows: [row('chatgpt.com', '/guide?utm_source=chatgpt.com', 5, 3, 1), row('chatgpt.com', '/guide', 2, 1, 0), row('perplexity.ai', '/guide', 4, 4, 2), row('some-gemini-fan-site.example', '/x', 9, 9, 9), row('weird-copilotish', '/y', 1, 1, 0)] });
		});
		const r = await aiAssistantTraffic(id, 'properties/1', '2026-01-01', '2026-01-28', { fetchImpl: f as never });
		expect(body.dimensionFilter.filter.fieldName).toBe('sessionSource');
		expect(body.dimensionFilter.filter.stringFilter.matchType).toBe('PARTIAL_REGEXP');
		const chat = r.find((x) => x.assistant === 'ChatGPT' && x.page === '/guide')!;
		expect(chat).toMatchObject({ sessions: 7, engagedSessions: 4, keyEvents: 1 });
		expect(r.find((x) => x.assistant === 'Perplexity')!.sessions).toBe(4);
	});
});
