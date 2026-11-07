import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { performanceBy, periodFor, summary } from '../src/lib/server/queries';
import { isRealDate, joinWindows, resolveWindows, sortRows, span } from '../src/lib/performance';

describe('performance windows (pure)', () => {
	const END = '2026-10-30';
	it('defaults to the last 28 stored days and clamps a window that runs past the data, with a note', () => {
		const w = resolveWindows({}, END) as Exclude<ReturnType<typeof resolveWindows>, { error: string }>;
		expect(w.main).toEqual({ start: '2026-10-03', end: END });
		expect(span(w.main)).toBe(28);
		const c = resolveWindows({ start: '2026-10-20', end: '2026-11-05' }, END) as typeof w;
		expect(c.main.end).toBe(END);
		expect(c.notes.join(' ')).toMatch(/cut back to 2026-10-30/);
	});
	it('refuses what it cannot answer honestly', () => {
		const err = (i: object) => (resolveWindows(i, END) as { error: string }).error;
		expect(err({ start: '2026-11-02', end: '2026-11-05' })).toMatch(/No data after 2026-10-30/);
		expect(err({ start: '2026-10-20' })).toMatch(/both/);
		expect(err({ start: '2026-02-30', end: '2026-03-02' })).toMatch(/real dates/);
		expect(err({ start: '2026-10-20', end: '2026-10-10' })).toMatch(/after/);
		expect(err({ days: 0 })).toMatch(/whole number/);
		expect(err({ days: 501 })).toMatch(/1 to 500/);
		expect(err({ start: '2024-01-01', end: '2026-01-01' })).toMatch(/at most 500/);
		expect(err({ compare: 'sideways' })).toMatch(/compare/);
		expect(err({ compare: 'custom', compareStart: '2026-09-01' })).toMatch(/compare_start/);
		expect(err({ compare: 'custom', compareStart: '2026-09-01', compareEnd: '2026-12-01' })).toMatch(/runs past/);
	});
	it('previous = the equally long window just before; custom windows warn about overlap and unequal lengths', () => {
		const p = resolveWindows({ days: 7, compare: 'previous' }, END) as Exclude<ReturnType<typeof resolveWindows>, { error: string }>;
		expect(p.main).toEqual({ start: '2026-10-24', end: END });
		expect(p.compare).toEqual({ start: '2026-10-17', end: '2026-10-23' });
		const o = resolveWindows({ days: 7, compare: 'custom', compareStart: '2026-10-20', compareEnd: '2026-10-26' }, END) as typeof p;
		expect(o.notes.join(' ')).toMatch(/overlap/);
		const l = resolveWindows({ days: 7, compare: 'custom', compareStart: '2026-09-01', compareEnd: '2026-09-30' }, END) as typeof p;
		expect(l.notes.join(' ')).toMatch(/differ in length \(7 and 30 days\)/);
		expect(isRealDate('2026-02-29')).toBe(false);
		expect(isRealDate('2028-02-29')).toBe(true);
	});
	it('joins windows on every key from either side; a missing side counts as zero; position change is now minus before', () => {
		const j = joinWindows(
			[{ key: 'a', clicks: 30, impressions: 300, position: 4 }, { key: 'new', clicks: 5, impressions: 50, position: 9 }],
			[{ key: 'a', clicks: 20, impressions: 400, position: 6 }, { key: 'gone', clicks: 8, impressions: 80, position: 3 }]
		);
		const by = (k: string) => j.find((r) => r.key === k)!;
		expect(by('a')).toMatchObject({ clicksChange: 0.5, impressionsChange: -0.25, positionChange: -2 });
		expect(by('new')).toMatchObject({ prev: null, clicksChange: null, positionChange: null });
		expect(by('gone')).toMatchObject({ clicks: 0, clicksChange: -1, positionChange: null });
		expect(j).toHaveLength(3);
	});
	it('sorts by the measure, best position first, unknowns last, stable by key', () => {
		const rows = joinWindows([{ key: 'b', clicks: 5, impressions: 100, position: 8 }, { key: 'a', clicks: 5, impressions: 50, position: 2 }, { key: 'c', clicks: 9, impressions: 90, position: 0 }], []);
		expect(sortRows(rows, 'clicks').map((r) => r.key)).toEqual(['c', 'a', 'b']);
		expect(sortRows(rows, 'ctr').map((r) => r.key)).toEqual(['c', 'a', 'b']); // 0.10 / 0.10 / 0.05: tie broken by clicks then key
		expect(sortRows(rows, 'position').map((r) => r.key)).toEqual(['a', 'b', 'c']); // c has no position: last
		expect(sortRows(rows, 'key').map((r) => r.key)).toEqual(['a', 'b', 'c']);
	});
});

describe('MCP bridge tools on demo data', () => {
	let key = '';
	let scoped = '';
	const call = async (k: string, name: string, args: object = {}) => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		const text = r.content[0].text as string;
		return { isError: !!r.isError, data: r.isError ? text : JSON.parse(text) };
	};
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		let guard = 0;
		await syncSite(1, { client, backfillChunkDays: 120 });
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
		key = createApiKey('all', null).key;
		scoped = createApiKey('only 2', [2]).key;
	}, 120_000);

	it('get_performance: queries by default, exact site totals alongside, sorted by clicks', async () => {
		const r = await call(key, 'get_performance', { site: '1' });
		expect(r.isError).toBe(false);
		const site = getSite(1)!;
		const p = periodFor(site, 28);
		expect(r.data.window).toEqual({ start: p.start, end: p.end, days: 28 });
		expect(r.data.dimension).toBe('query');
		expect(r.data.totals.clicks).toBe(summary(1, p.start, p.end).clicks);
		const clicks = r.data.rows.map((x: { clicks: number }) => x.clicks);
		expect(clicks).toEqual([...clicks].sort((a: number, b: number) => b - a));
		expect(r.data.rows[0].query).toBe(performanceBy(1, p.start, p.end, 'query')[0].key);
		expect(r.data.notes.join(' ')).toMatch(/anonymised/);
	});
	it('every dimension works, device and country filters narrow the numbers, and totals are not claimed when filtered', async () => {
		const all = (await call(key, 'get_performance', { site: '1', dimension: 'device' })).data;
		expect(all.rows.map((x: { device: string }) => x.device)).toEqual(expect.arrayContaining(['MOBILE']));
		const mobile = (await call(key, 'get_performance', { site: '1', dimension: 'page', device: 'mobile', limit: 200 })).data;
		const desktop = (await call(key, 'get_performance', { site: '1', dimension: 'page', device: 'desktop', limit: 200 })).data;
		expect(mobile.totals).toBeNull();
		const sum = (d: { rows: { clicks: number }[] }) => d.rows.reduce((a, x) => a + x.clicks, 0);
		const mob = all.rows.find((x: { device: string }) => x.device === 'MOBILE').clicks;
		expect(sum(mobile)).toBeLessThanOrEqual(mob);
		expect(sum(mobile)).not.toBe(sum(desktop));
		const country = (await call(key, 'get_performance', { site: '1', dimension: 'country' })).data;
		const top = country.rows[0].country as string;
		const only = (await call(key, 'get_performance', { site: '1', dimension: 'query', country: top.toUpperCase(), limit: 200 })).data;
		expect(only.filters.country).toBe(top);
		expect(sum(only)).toBeLessThanOrEqual(country.rows[0].clicks);
		const dates = (await call(key, 'get_performance', { site: '1', dimension: 'date', days: 7 })).data;
		expect(dates.rows.map((x: { date: string }) => x.date)).toEqual([...dates.rows.map((x: { date: string }) => x.date)].sort()); // chronological
	});
	it('text filters are literal: a % or _ matches only itself', async () => {
		const r = await call(key, 'get_performance', { site: '1', query_contains: '%' });
		expect(r.data.rows).toEqual([]);
		const q = (await call(key, 'get_performance', { site: '1' })).data.rows[0].query as string;
		const word = q.split(' ')[0];
		const hit = (await call(key, 'get_performance', { site: '1', query_contains: word.toUpperCase(), limit: 50 })).data;
		expect(hit.rows.length).toBeGreaterThan(0);
		expect(hit.rows.every((x: { query: string }) => x.query.toLowerCase().includes(word.toLowerCase()))).toBe(true);
	});
	it('comparison: matches a direct computation; refuses to claim a change while history is missing', async () => {
		const site = getSite(1)!;
		const p = periodFor(site, 28);
		const r = (await call(key, 'get_performance', { site: '1', dimension: 'page', compare: 'previous', sort: 'clicks_change', limit: 5 })).data;
		expect(r.comparison).toMatchObject({ available: true, start: p.prevStart, end: p.prevEnd });
		expect(r.totals.previous.clicks).toBe(summary(1, p.prevStart, p.prevEnd).clicks);
		const row = r.rows[0];
		const now = performanceBy(1, p.start, p.end, 'page').find((x) => x.key === row.page)!;
		const before = performanceBy(1, p.prevStart, p.prevEnd, 'page').find((x) => x.key === row.page);
		expect(row.clicks).toBe(now.clicks);
		expect(row.previous?.clicks ?? null).toBe(before?.clicks ?? null);
		// history that has not been downloaded yet: no change is claimed
		db().prepare("UPDATE sites SET backfill_done = 0, backfilled_to = ? WHERE id = 1").run(p.start);
		const blocked = (await call(key, 'get_performance', { site: '1', compare: 'previous' })).data;
		expect(blocked.comparison.available).toBe(false);
		expect(blocked.comparison.reason).toMatch(/still downloading/);
		expect(blocked.rows[0]).not.toHaveProperty('clicksChange');
		expect(blocked.totals).not.toHaveProperty('previous');
		db().prepare("UPDATE sites SET backfill_done = 1 WHERE id = 1").run();
	});
	it('rejects bad input with a clear message, and a scoped key cannot read another site', async () => {
		for (const [args, msg] of [
			[{ dimension: 'ip' }, /dimension/], [{ country: 'us' }, /3-letter/], [{ device: 'watch' }, /device/], [{ sort: 'vibes' }, /sort/], [{ start: '2026-13-01', end: '2026-13-02' }, /real dates/]
		] as [object, RegExp][]) {
			const r = await call(key, 'get_performance', { site: '1', ...args });
			expect(r.isError, JSON.stringify(args)).toBe(true);
			expect(r.data).toMatch(msg);
		}
		expect((await call(scoped, 'get_performance', { site: '1' })).isError).toBe(true);
		expect((await call(scoped, 'inspect_url', { site: '1', urls: ['https://x/'] })).isError).toBe(true);
		expect((await call(scoped, 'get_sitemaps', { site: '1' })).isError).toBe(true);
	});
	it('inspect_url: only URLs inside the property, max 5, cached for 12 hours, refresh asks Google again', async () => {
		const site = getSite(1)!;
		const page = performanceBy(1, periodFor(site, 28).start, periodFor(site, 28).end, 'page')[0].key;
		const first = (await call(key, 'inspect_url', { site: '1', urls: [page] })).data;
		expect(first.results).toHaveLength(1);
		expect(first.results[0]).toMatchObject({ url: page, fromCache: false });
		expect(first.results[0].verdict ?? first.results[0].error).toBeTruthy();
		const again = (await call(key, 'inspect_url', { site: '1', urls: [page] })).data;
		expect(again.results[0].fromCache).toBe(true);
		const fresh = (await call(key, 'inspect_url', { site: '1', urls: [page], refresh: true })).data;
		expect(fresh.results[0].fromCache).toBe(false);
		const out = await call(key, 'inspect_url', { site: '1', urls: ['https://elsewhere.example/page'] });
		expect(out.isError).toBe(true);
		expect(out.data).toMatch(/outside the property/);
		expect((await call(key, 'inspect_url', { site: '1', urls: Array.from({ length: 6 }, (_, i) => page + '?' + i) })).data).toMatch(/At most 5/);
		expect((await call(key, 'inspect_url', { site: '1', urls: ['not a url'] })).isError).toBe(true);
		expect((await call(key, 'inspect_url', { site: '1' })).isError).toBe(true);
	});
	it('get_sitemaps: Google\'s own status per sitemap', async () => {
		const r = (await call(key, 'get_sitemaps', { site: '1' })).data;
		expect(r.count).toBe(r.sitemaps.length);
		expect(r.sitemaps.length).toBeGreaterThan(0);
		expect(r.sitemaps[0]).toEqual(expect.objectContaining({ path: expect.any(String), pending: expect.any(Boolean), warnings: expect.any(Number), errors: expect.any(Number), contents: expect.any(Array) }));
		expect(r.note).toMatch(/pending/);
	});
	it('the tools are listed with their schemas', async () => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
		const names = (await res.json()).result.tools.map((t: { name: string }) => t.name);
		for (const n of ['get_performance', 'inspect_url', 'get_sitemaps']) expect(names).toContain(n);
		expect(names).toHaveLength(41);
		expect(names).toContain('get_page_insights');
	});
});
