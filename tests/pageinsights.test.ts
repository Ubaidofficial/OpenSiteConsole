import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { autoMatchGa4, connectBingKey, connectClarity } from '../src/lib/server/connect';
import { syncClarity } from '../src/lib/server/channels';
import { queueDepth } from '../src/lib/server/jobs';
import { periodFor, topPages } from '../src/lib/server/queries';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';
import { originOf, pageInsights } from '../src/lib/server/pageinsights';
import { clarityPages, mergePages, pathKey, rollUp, type PageSources } from '../src/lib/pageinsights';
import { pullGa4Periods } from '../src/lib/server/channels';
import { retentionHorizon } from '../src/lib/server/dates';
import type { Ga4Source } from '../src/lib/server/channels';

describe('pathKey and rollUp', () => {
	it('reduces any spelling of a page to its path', () => {
		expect(pathKey('https://www.x.example/blog/post/?utm=1#top')).toBe('/blog/post');
		expect(pathKey('http://x.example/blog/post')).toBe('/blog/post');
		expect(pathKey('/blog/post/')).toBe('/blog/post');
		expect(pathKey('blog/post')).toBe('/blog/post');
		expect(pathKey('https://x.example')).toBe('/');
		expect(pathKey('https://x.example/')).toBe('/');
		expect(pathKey('/')).toBe('/');
		expect(pathKey('/a//')).toBe('/a');
		expect(pathKey('/blog/post?x=1#a')).toBe('/blog/post'); // a path that carries its own query
		expect(pathKey('blog/post/?x=1')).toBe('/blog/post');
		expect(pathKey('/Case/Kept')).toBe('/Case/Kept'); // paths are case-sensitive
	});
	it('counts a page once however many addresses it has: sums, impression-weighted position, the busiest address', () => {
		const m = rollUp([
			{ url: 'https://x.example/a', clicks: 10, impressions: 100, position: 8 },
			{ url: 'https://www.x.example/a/', clicks: 30, impressions: 300, position: 4 }, // the busiest address comes second
			{ url: 'https://x.example/b', clicks: 5, impressions: 50, position: 2 }
		]);
		expect(m.size).toBe(2);
		expect(m.get('/a')).toEqual({ url: 'https://www.x.example/a/', clicks: 40, impressions: 400, position: (4 * 300 + 8 * 100) / 400 });
	});
});

describe('mergePages', () => {
	const base: PageSources = { google: [], googlePrev: [], bing: null, bingPrev: null, ga4: null, ga4Prev: null, ai: null, aiPrev: null, clarity: null };
	const origin = (p: string) => 'https://site.example' + p;
	it('is the union of every source, null where a source knows nothing (never an assumed zero)', () => {
		const rows = mergePages({
			...base,
			google: [{ url: 'https://site.example/a', clicks: 10, impressions: 100, position: 3 }],
			bing: [{ url: 'https://site.example/b', clicks: 4, impressions: 40, position: 5 }],
			ga4: [{ page: '/c', sessions: 20, engagedSessions: 10, keyEvents: 2.25 }],
			clarity: [{ url: '/d', sessions: 7, rageClicks: 1, deadClicks: null }]
		}, origin);
		const by = (p: string) => rows.find((r) => r.path === p)!;
		expect(rows.map((r) => r.path).sort()).toEqual(['/a', '/b', '/c', '/d']);
		expect(by('/a')).toMatchObject({ gClicks: 10, bClicks: null, aSessions: null, cSessions: null, url: 'https://site.example/a' });
		expect(by('/b')).toMatchObject({ gClicks: null, bClicks: 4, bPos: 5 });
		expect(by('/c')).toMatchObject({ aSessions: 20, aEngaged: 0.5, aKeyEvents: 2.3, url: 'https://site.example/c' }); // GA4 has paths only: link built from the site's origin
		expect(by('/d')).toMatchObject({ cSessions: 7, cRage: 1, cDead: null });
	});
	it('changes: against the previous period when it is stored; a brand-new page has no percentage; "not stored" is not "zero"', () => {
		const withPrev = mergePages({
			...base,
			google: [{ url: '/a', clicks: 150, impressions: 1000, position: 3 }, { url: '/new', clicks: 5, impressions: 50, position: 9 }],
			googlePrev: [{ url: '/a', clicks: 100, impressions: 2000, position: 3 }]
		}, origin);
		expect(withPrev.find((r) => r.path === '/a')).toMatchObject({ gClicksD: 0.5, gImprD: -0.5 });
		expect(withPrev.find((r) => r.path === '/new')).toMatchObject({ gClicksD: null, gImprD: null });
		const noPrev = mergePages({ ...base, google: [{ url: '/a', clicks: 150, impressions: 1000, position: 3 }], googlePrev: null }, origin);
		expect(noPrev[0]).toMatchObject({ gClicks: 150, gClicksD: null, gImprD: null });
		const ga = mergePages({ ...base, ga4: [{ page: '/a', sessions: 60, engagedSessions: 30, keyEvents: 6 }], ga4Prev: [{ page: '/a', sessions: 40, engagedSessions: 20, keyEvents: 3 }] }, origin);
		expect(ga[0]).toMatchObject({ aSessionsD: 0.5, aKeyEventsD: 1 });
		const gaNo = mergePages({ ...base, ga4: [{ page: '/a', sessions: 60, engagedSessions: 30, keyEvents: 6 }], ga4Prev: null }, origin);
		expect(gaNo[0]).toMatchObject({ aSessions: 60, aSessionsD: null, aKeyEventsD: null });
		const bi = mergePages({ ...base, bing: [{ url: '/a', clicks: 30, impressions: 300, position: 4 }], bingPrev: [{ url: '/a', clicks: 20, impressions: 400, position: 4 }] }, origin);
		expect(bi[0]).toMatchObject({ bClicksD: 0.5, bImprD: -0.25 });
	});
	it('two addresses of one page are one row in every source, and rows sort by Google clicks with unknowns last', () => {
		const rows = mergePages({
			...base,
			google: [{ url: 'https://www.site.example/a/', clicks: 20, impressions: 200, position: 3 }, { url: 'https://site.example/a', clicks: 5, impressions: 50, position: 3 }, { url: '/z', clicks: 1, impressions: 10, position: 9 }],
			bing: [{ url: 'https://site.example/a?x=1', clicks: 3, impressions: 30, position: 4 }, { url: '/only-bing', clicks: 99, impressions: 100, position: 4 }]
		}, origin);
		expect(rows.map((r) => r.path)).toEqual(['/a', '/z', '/only-bing']);
		expect(rows[0]).toMatchObject({ gClicks: 25, bClicks: 3 });
	});
});

describe('clarityPages', () => {
	it('reads sessions and click problems per URL, tolerates URL / Url / full addresses, and ignores rows it cannot place', () => {
		const out = clarityPages([
			{ metricName: 'Traffic', information: [{ URL: '/a', totalSessionCount: '100' }, { Url: 'https://x.example/b/?q=1', totalSessionCount: 50 }, { totalSessionCount: '5' }, { URL: '/c', totalSessionCount: 'n/a' }] },
			{ metricName: 'RageClickCount', information: [{ URL: '/a', sessionsCount: '7' }] },
			{ metricName: 'DeadClickCount', information: [{ URL: '/a/', sessionsCount: '3' }, { URL: '/b', sessionsCount: '1' }] },
			{ metricName: 'ScrollDepth', information: [{ URL: '/a', sessionsCount: '999' }] }
		]);
		const by = (u: string) => out.find((r) => r.url === u);
		expect(by('/a')).toEqual({ url: '/a', sessions: 100, rageClicks: 7, deadClicks: 3 });
		expect(by('/b')).toEqual({ url: '/b', sessions: 50, rageClicks: null, deadClicks: 1 });
		expect(by('/c')).toBeUndefined();
		expect(out).toHaveLength(2);
	});
});

describe('mergePages: AI assistants (GA4)', () => {
	const base: PageSources = { google: [], googlePrev: [], bing: null, bingPrev: null, ga4: null, ga4Prev: null, ai: null, aiPrev: null, clarity: null };
	const origin = (p: string) => 'https://site.example' + p;
	const ai = (page: string, assistant: string, sessions: number, engagedSessions = 0, keyEvents = 0) => ({ page, assistant, sessions, engagedSessions, keyEvents });
	it('sums assistants per page, keeps the split busiest first, and adds pages only AI knows', () => {
		const rows = mergePages({ ...base, google: [{ url: '/a', clicks: 10, impressions: 100, position: 3 }], ai: [ai('/a', 'Claude', 2, 1), ai('/a/', 'ChatGPT', 6, 3, 1.25), ai('/only-ai?x=1', 'Perplexity', 4, 4)] }, origin);
		const by = (p: string) => rows.find((r) => r.path === p)!;
		expect(by('/a')).toMatchObject({ aiSessions: 8, aiEngaged: 0.5, aiKeyEvents: 1.3, aiTop: 'ChatGPT', aiBy: [{ assistant: 'ChatGPT', sessions: 6 }, { assistant: 'Claude', sessions: 2 }] });
		expect(by('/only-ai')).toMatchObject({ gClicks: null, aiSessions: 4, aiTop: 'Perplexity', url: 'https://site.example/only-ai' });
	});
	it('null (not zero) for a page with no AI sessions, and no AI sort effect on pages that have none', () => {
		const rows = mergePages({ ...base, google: [{ url: '/a', clicks: 10, impressions: 100, position: 3 }, { url: '/b', clicks: 10, impressions: 100, position: 3 }], ai: [ai('/b', 'Gemini', 1)] }, origin);
		expect(rows.find((r) => r.path === '/a')).toMatchObject({ aiSessions: null, aiSessionsD: null, aiEngaged: null, aiTop: null, aiBy: null });
		expect(rows[0].path).toBe('/b'); // equal Google clicks: the page with AI sessions comes first
	});
	it('change against the previous window; a brand-new AI page has no percentage; no stored window means no change', () => {
		const withPrev = mergePages({ ...base, ai: [ai('/a', 'ChatGPT', 30), ai('/a', 'Claude', 30), ai('/new', 'ChatGPT', 5)], aiPrev: [ai('/a', 'ChatGPT', 40), ai('/gone', 'ChatGPT', 9)] }, origin);
		expect(withPrev.find((r) => r.path === '/a')).toMatchObject({ aiSessions: 60, aiSessionsD: 0.5 });
		expect(withPrev.find((r) => r.path === '/new')).toMatchObject({ aiSessions: 5, aiSessionsD: null });
		expect(withPrev.find((r) => r.path === '/gone')).toBeUndefined(); // only in the previous window: no row for it now
		const noPrev = mergePages({ ...base, ai: [ai('/a', 'ChatGPT', 30)], aiPrev: null }, origin);
		expect(noPrev[0]).toMatchObject({ aiSessions: 30, aiSessionsD: null });
	});
});

describe('combined pages on demo data', () => {
	let key = '';
	let scoped = '';
	const call = async (k: string, args: object) => {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_page_insights', arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
	};
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		let guard = 0;
		await syncSite(1, { client, backfillChunkDays: 120 });
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
		await syncSite(2, { client, mode: 'incremental' });
		await connectBingKey('demo', 'b');
		await autoMatchGa4();
		await connectClarity(1, 'demo');
		await syncClarity(1, { force: true });
		const end = Date.now() + 60_000;
		while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
		key = createApiKey('all', null).key;
		scoped = createApiKey('only 2', [2]).key;
	}, 180_000);

	it('every source shows up, with real previous-period changes where the history is stored', () => {
		const site = getSite(1)!;
		const r = pageInsights(site, 28);
		expect(r.google.comparable).toBe(true);
		expect(r.bing).toMatchObject({ linked: true, hasData: true });
		expect(r.ga4).toMatchObject({ linked: true, hasData: true, comparable: true });
		expect(r.clarity).toMatchObject({ linked: true, hasData: true });
		const top = r.rows[0];
		const p = periodFor(site, 28);
		const direct = topPages(1, p.start, p.end, {}, 50_000).filter((x) => pathKey(x.page) === top.path).reduce((a, x) => a + x.clicks, 0);
		const prevDirect = topPages(1, p.prevStart, p.prevEnd, {}, 50_000).filter((x) => pathKey(x.page) === top.path).reduce((a, x) => a + x.clicks, 0);
		expect(top.gClicks).toBe(direct);
		expect(top.gClicksD).toBeCloseTo((direct - prevDirect) / prevDirect, 10);
		expect(top.aSessions).not.toBeNull();
		expect(top.aSessionsD).not.toBeNull();
		expect(r.rows.some((x) => x.bClicks != null)).toBe(true);
		expect(r.rows.some((x) => x.cSessions != null)).toBe(true);
		for (let i = 1; i < r.rows.length && r.rows[i].gClicks != null; i++) expect(r.rows[i - 1].gClicks!).toBeGreaterThanOrEqual(r.rows[i].gClicks!); // sorted
	});
	it('GA4 pulls the window just before each period, and none where that is older than GA4 keeps data', () => {
		const n = (days: number) => (db().prepare('SELECT COUNT(*) n FROM ga4_landing_prev WHERE site_id = 1 AND days = ?').get(days) as { n: number }).n;
		expect(n(7)).toBeGreaterThan(0);
		expect(n(28)).toBeGreaterThan(0);
		expect(n(480)).toBe(0); // the window before 480 days reaches past the retention horizon
		const r = pageInsights(getSite(1)!, 480);
		expect(r.ga4.hasData).toBe(true);
		expect(r.ga4.comparable).toBe(false);
		expect(r.rows[0].aSessionsD).toBeNull(); // no change claimed without a stored previous window
	});
	it('AI assistants: GA4 sessions per page, with a previous window where one is stored', () => {
		const site = getSite(1)!;
		const r = pageInsights(site, 28);
		expect(r.ai).toMatchObject({ linked: true, status: 'ok', hasData: true, comparable: true });
		const withAi = r.rows.filter((x) => x.aiSessions != null);
		expect(withAi.length).toBeGreaterThan(0);
		const row = withAi[0];
		const stored = db().prepare('SELECT SUM(sessions) s FROM ga4_ai WHERE site_id = 1 AND days = 28 AND page = ?').get(row.path) as { s: number };
		expect(row.aiSessions).toBe(stored.s);
		expect(row.aiBy!.reduce((a, b) => a + b.sessions, 0)).toBe(row.aiSessions);
		expect(row.aiTop).toBe(row.aiBy![0].assistant);
		expect(withAi.some((x) => x.aiSessionsD != null)).toBe(true);
		expect(r.ai.hasData && pageInsights(site, 7).ai.comparable).toBe(true);
		const n = (days: number) => (db().prepare('SELECT COUNT(*) n FROM ga4_ai_prev WHERE site_id = 1 AND days = ?').get(days) as { n: number }).n;
		expect(n(28)).toBeGreaterThan(0);
		expect(n(480)).toBe(0); // the window before 480 days reaches past GA4's retention
		const long = pageInsights(site, 480);
		expect(long.ai).toMatchObject({ hasData: true, comparable: false });
		for (const x of long.rows) expect(x.aiSessionsD).toBeNull();
	});
	it('AI assistants: shown only when the AI report was pulled; a failed pull is not shown as zero AI traffic', () => {
		const site = getSite(1)!;
		const on = (db().prepare('SELECT ga4_ai_on v FROM sites WHERE id = 1').get() as { v: string }).v;
		db().prepare('UPDATE sites SET ga4_ai_on = NULL WHERE id = 1').run();
		const failed = pageInsights(site, 28);
		expect(failed.ai).toMatchObject({ status: 'failed', hasData: false });
		expect(failed.rows.every((x) => x.aiSessions == null)).toBe(true);
		db().prepare('UPDATE sites SET ga4_periods_on = NULL WHERE id = 1').run();
		expect(pageInsights(site, 28).ai.status).toBe('pending');
		db().prepare('UPDATE sites SET ga4_ai_on = ?, ga4_periods_on = ? WHERE id = 1').run(on, on);
		expect(pageInsights(site, 28).ai.status).toBe('ok');
	});
	it('Bing changes are only shown when its stored history reaches the previous period', () => {
		const site = getSite(1)!;
		const p = periodFor(site, 28);
		expect(pageInsights(site, 28).bing.comparable).toBe(true);
		const had = db().prepare('SELECT date FROM bing_daily WHERE site_id = 1 AND date < ?').all(p.prevStart.slice(0, 8) + '28') as { date: string }[];
		db().prepare('DELETE FROM bing_daily WHERE site_id = 1 AND date <= ?').run(p.prevStart);
		const r = pageInsights(site, 28);
		expect(r.bing).toMatchObject({ hasData: true, comparable: false });
		for (const row of r.rows) expect(row.bClicksD).toBeNull();
		expect(had.length).toBeGreaterThan(0);
	});
	it('no change is claimed while the previous period is still downloading', () => {
		const site = { ...getSite(1)!, backfill_done: 0, backfilled_to: periodFor(getSite(1)!, 28).start };
		const r = pageInsights(site, 28);
		expect(r.google.comparable).toBe(false);
		expect(r.rows[0].gClicks).not.toBeNull();
		expect(r.rows[0].gClicksD).toBeNull();
		expect(r.rows[0].gImprD).toBeNull();
	});
	it('sites with no other source connected show Google only, without empty bands', () => {
		db().prepare('DELETE FROM site_links WHERE site_id = 2').run(); // the demo links every source to every site: take them away
		const r = pageInsights(getSite(2)!, 28);
		expect(r.bing.linked || r.ga4.linked || r.clarity.linked).toBe(false);
		expect(r.bing.hasData || r.ga4.hasData || r.clarity.hasData).toBe(false);
		expect(r.rows.length).toBeGreaterThan(0);
		expect(r.rows[0].bClicks).toBeNull();
		expect(r.rows[0].aSessions).toBeNull();
		expect(r.rows[0].cSessions).toBeNull();
	});
	it('originOf builds a link for paths only GA4 knows', () => {
		expect(originOf('sc-domain:x.example')).toBe('https://x.example');
		expect(originOf('https://www.x.example/blog/')).toBe('https://www.x.example');
	});
	it('MCP get_page_insights: the same view for agents, filtered, sorted, limited, scoped', async () => {
		const r = await call(key, { site: '1', limit: 5 });
		expect(r.isError).toBe(false);
		expect(r.data.rows).toHaveLength(5);
		expect(r.data.sources).toMatchObject({ bing: { hasData: true }, ga4: { hasData: true, comparable: true }, clarity: { hasData: true, covers: 'last 24 hours only' } });
		const top = r.data.rows[0];
		expect(top.google.clicks).toBeGreaterThan(0);
		expect(top.google.clicksChange).toMatch(/%$/);
		expect(top.ga4.sessions).toBeGreaterThan(0);
		const filtered = await call(key, { site: '1', path_contains: 'BLOG', limit: 50 });
		expect(filtered.data.rows.length).toBeGreaterThan(0);
		expect(filtered.data.rows.every((x: { path: string }) => x.path.toLowerCase().includes('blog'))).toBe(true);
		expect(r.data.sources.ai).toMatchObject({ linked: true, status: 'ok', hasData: true });
		const byAi = await call(key, { site: '1', sort: 'ai_sessions', limit: 10 });
		const a = byAi.data.rows.map((x: { ai: { sessions: number } | null }) => x.ai?.sessions ?? -1);
		expect(a[0]).toBeGreaterThan(0);
		expect(a).toEqual([...a].sort((x: number, y: number) => y - x));
		const aiRow = byAi.data.rows[0].ai;
		expect(aiRow).toMatchObject({ topAssistant: expect.any(String), byAssistant: expect.any(Array) });
		expect(aiRow.engagedShare).toMatch(/%$/);
		const bySessions = await call(key, { site: '1', sort: 'ga4_sessions', limit: 10 });
		const s = bySessions.data.rows.map((x: { ga4: { sessions: number } | null }) => x.ga4?.sessions ?? -1);
		expect(s).toEqual([...s].sort((a: number, b: number) => b - a));
		expect((await call(key, { site: '1', sort: 'vibes' })).data).toMatch(/sort/);
		expect((await call(scoped, { site: '1' })).isError).toBe(true); // outside the key's scope
		expect((await call(scoped, { site: '2', limit: 3 })).isError).toBe(false);
	});
});

describe('the GA4 previous-window pull', () => {
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:'); // its own database: this test replaces the stored GA4 landing pages
		await ensureDemoAccounts();
	});
	it('asks GA4 for exactly the window before each period, and not at all where it would predate what GA4 keeps', async () => {
		const today = '2026-11-06';
		const calls: [string, string][] = [];
		const src = {
			usersByChannel: async () => [],
			aiTraffic: async () => [],
			landing: async (_p: string, s: string, e: string) => (calls.push([s, e]), [{ page: '/x', sessions: 1, engagedSessions: 1, keyEvents: 0 }])
		} as unknown as Ga4Source;
		expect((await pullGa4Periods(1, 'properties/1', src, today)).ok).toBe(true);
		const has = (s: string, e: string) => calls.some(([a, b]) => a === s && b === e);
		expect(has('2026-10-10', '2026-11-06')).toBe(true); // 28 days ending today
		expect(has('2026-09-12', '2026-10-09')).toBe(true); // the 28 days just before it: no gap, no overlap
		expect(has('2026-10-31', '2026-11-06')).toBe(true); // 7 days
		expect(has('2026-10-24', '2026-10-30')).toBe(true);
		const horizon = retentionHorizon(today);
		const prevStarts = calls.filter(([, e]) => e < '2026-11-06' && e !== '2026-11-06').map(([s]) => s);
		for (const s of prevStarts) expect(s >= horizon, `a previous window starting ${s} is older than ${horizon}`).toBe(true);
		const longest = calls.filter(([s, e]) => e === today).sort((a, b) => (a[0] < b[0] ? -1 : 1))[0]; // the 480-day (clamped) current window
		expect(calls.filter(([, e]) => e === (longest ? new Date(Date.parse(longest[0] + 'T00:00:00Z') - 86_400_000).toISOString().slice(0, 10) : '')).length).toBe(0); // nothing is requested before it
	});
});
