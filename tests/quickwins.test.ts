import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { syncSitemapUrls, sitemapCoverage } from '../src/lib/server/sitemapcov';
import { brandTerms, periodFor } from '../src/lib/server/queries';
import { addDays } from '../src/lib/server/dates';
import { isBranded } from '../src/lib/analytics';
import { isQuestionQuery } from '../src/lib/trends';
import { quickWins } from '../src/lib/server/quickwins';
import { decayReport } from '../src/lib/server/decay';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';

const site = () => getSite(1)!;
const num = (s: string, re: RegExp) => Number(re.exec(s)?.[1]);

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	await syncSitemapUrls(1, { client });
}, 180_000);

describe('quick wins', () => {
	it('every group is low effort, cut to the top rows, with the full count and a tab to open', () => {
		const q = quickWins(site(), 28);
		expect(q.days).toBe(28);
		expect(q.groups.length).toBeGreaterThan(0);
		const keys = q.groups.map((g) => g.key);
		expect(new Set(keys).size).toBe(keys.length);
		for (const g of q.groups) {
			expect(['ctr', 'page-one', 'questions', 'sitemap', 'onpage', 'indexing']).toContain(g.key);
			expect(g.rows.length, g.key).toBeGreaterThan(0);
			expect(g.rows.length, g.key).toBeLessThanOrEqual(8);
			expect(g.total, g.key).toBeGreaterThanOrEqual(g.rows.length);
			expect(g.why.length).toBeGreaterThan(30);
			expect(g.how.length).toBeGreaterThan(30);
			expect(g.tab).toMatch(/^[a-z-]+$/);
		}
	});
	it('the title-rewrite list is the biggest click-rate gaps first, each a real gap in the top 10', () => {
		const g = quickWins(site(), 28).groups.find((x) => x.key === 'ctr');
		expect(g, 'the demo site has click-rate gaps').toBeDefined();
		const gains = g!.rows.map((r) => r.gain as number);
		expect(gains).toEqual([...gains].sort((a, b) => b - a));
		for (const r of g!.rows) {
			expect(r.gain).toBeGreaterThanOrEqual(3);
			expect(num(r.detail, /position ([\d.]+)/)).toBeLessThanOrEqual(10);
			const [, own, expected] = /([\d.]+)% click rate against about ([\d.]+)% expected/.exec(r.detail)!;
			expect(Number(own)).toBeLessThan(Number(expected) * 0.7 + 0.05); // far under what the site earns at that position
		}
	});
	it('"one push from page 1" stays between positions 8 and 15, and the question list holds only questions', () => {
		const q = quickWins(site(), 28);
		const near = q.groups.find((x) => x.key === 'page-one');
		if (near) for (const r of near.rows) { const pos = num(r.detail, /position ([\d.]+)/); expect(pos).toBeGreaterThanOrEqual(8); expect(pos).toBeLessThanOrEqual(15); }
		const asked = q.groups.find((x) => x.key === 'questions');
		if (asked) for (const r of asked.rows) { expect(isQuestionQuery(r.label), r.label).toBe(true); const pos = num(r.detail, /position ([\d.]+)/); expect(pos).toBeGreaterThanOrEqual(3); expect(pos).toBeLessThanOrEqual(20); }
	});
	it('branded searches are left out: ranking for your own name is not a quick win', () => {
		const terms = brandTerms(site());
		for (const g of quickWins(site(), 28).groups.filter((x) => ['ctr', 'page-one', 'questions'].includes(x.key))) for (const r of g.rows) expect(isBranded(r.label, terms), r.label).toBe(false);
	});
	it('pages that earn clicks but are missing from the sitemap are offered, with no invented click estimate', () => {
		const cov = sitemapCoverage(site());
		const g = quickWins(site(), 28).groups.find((x) => x.key === 'sitemap');
		if (cov.synced && cov.notInSitemap.count > 0) {
			expect(g).toBeDefined();
			expect(g!.total).toBe(cov.notInSitemap.count);
			expect(g!.rows.every((r) => r.gain === null)).toBe(true);
		} else expect(g).toBeUndefined();
	});
	it('a Request-list group appears when there are pages waiting, and not before', () => {
		expect(quickWins(site(), 28).groups.find((x) => x.key === 'indexing')).toBeUndefined();
		db().prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at) VALUES (1, 'https://greenleaf.example/new-page', 'pending', 1, 'New and not indexed', ?)").run(Date.now());
		const g = quickWins(site(), 28).groups.find((x) => x.key === 'indexing')!;
		expect(g.total).toBe(1);
		expect(g.rows[0]).toMatchObject({ label: '/new-page', detail: 'New and not indexed', gain: null });
		db().prepare('DELETE FROM index_requests').run();
	});
	it('the tab is registered under Findings, and the page offers a way to the whole list', () => {
		const t = readFileSync('src/routes/sites/[id]/quickwins/+page.svelte', 'utf8');
		expect(t).toMatch(/All of them in/);
		expect(t).toMatch(/not added up/);
		expect(readFileSync('src/lib/explain.ts', 'utf8')).toMatch(/\['Findings', \['\/quickwins', '\/actions'/);
	});
});

describe('content decay against the same time last year', () => {
	const rows = (page: string, dates: string[], clicks: number) => {
		const ins = db().prepare("INSERT INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (1,?,'q',?,'usa','MOBILE',?,?,5)");
		for (const d of dates) ins.run(d, page, Math.round(clicks / dates.length), Math.round((clicks / dates.length) * 20));
	};
	const PAGE = 'https://greenleaf.example/slow-slide';
	it('catches a slow slide that month-on-month hides, and says so when history does not reach back a year', () => {
		const s0 = site();
		const p = periodFor(s0, 28);
		const span = (start: string) => Array.from({ length: 4 }, (_, i) => addDays(start, i * 7));
		rows(PAGE, span(p.start), 48); // now
		rows(PAGE, span(p.prevStart), 56); // the period before: a mild dip, not decay
		rows(PAGE, span(addDays(p.start, -364)), 400); // the same time last year
		const noYear = decayReport({ ...s0, backfilled_to: addDays(p.start, -100) }, 28, 'yoy');
		expect(noYear).toMatchObject({ mode: 'yoy', hasYear: false, rows: [], siteDelta: 0 });
		const withYear = { ...s0, backfilled_to: addDays(p.start, -400) };
		expect(decayReport(withYear, 28, 'period').rows.map((r) => r.page)).not.toContain(PAGE);
		const yoy = decayReport(withYear, 28, 'yoy');
		expect(yoy.hasYear).toBe(true);
		const hit = yoy.rows.find((r) => r.page === PAGE)!;
		expect(hit).toBeDefined();
		expect(hit).toMatchObject({ prevClicks: 400, clicks: 48 });
		expect(hit.deltaPct).toBeCloseTo(-0.88, 3);
		expect(hit.lostClicks).toBe(352);
	});
	it('the Decay tab links both views and the MCP tool takes compare: year_ago', async () => {
		const t = readFileSync('src/routes/sites/[id]/decay/+page.svelte', 'utf8');
		expect(t).toMatch(/link\('yoy'\)/);
		expect(t).toMatch(/link\('period'\)/);
		expect(readFileSync('src/routes/sites/[id]/decay/+page.server.ts', 'utf8')).toMatch(/mode'\) === 'yoy'/);
		const key = createApiKey('qw', null).key;
		const ask = async () => {
			resetRateLimits();
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_opportunities', arguments: { site: '1', type: 'decay', compare: 'year_ago' } } }) }));
			return JSON.parse((await res.json()).result.content[0].text);
		};
		const p = periodFor(site(), 28);
		const had = (db().prepare('SELECT backfilled_to b FROM sites WHERE id = 1').get() as { b: string }).b;
		try {
			// history that does not reach back a year: it says so rather than showing an empty "all clear"
			db().prepare('UPDATE sites SET backfilled_to = ? WHERE id = 1').run(addDays(p.start, -100));
			const none = await ask();
			expect(none.rows).toEqual([]);
			expect(none.note).toMatch(/does not reach back a year/);
			// history that does: the slow slide from the test above shows up, labelled as a year-on-year comparison
			db().prepare('UPDATE sites SET backfilled_to = ? WHERE id = 1').run(addDays(p.start, -400));
			const some = await ask();
			expect(some.compared).toBe('same period one year earlier');
			expect(some.rows.find((r: { page: string }) => r.page === PAGE)).toMatchObject({ lostClicks: 352, change: '-88%' });
		} finally {
			db().prepare('UPDATE sites SET backfilled_to = ? WHERE id = 1').run(had);
		}
	});
});

describe('MCP get_quick_wins', () => {
	it('is read-only, and returns each group with its why, how, count and top rows', async () => {
		const key = createApiKey('qw-read', null).key;
		resetRateLimits();
		const call = async (name: string, args: object) => handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })).then(async (r) => (await r.json()).result);
		const r = await call('get_quick_wins', { site: '1' });
		expect(r.isError).toBeFalsy();
		const out = JSON.parse(r.content[0].text);
		expect(out.groups.length).toBeGreaterThan(0);
		for (const g of out.groups) expect(g).toMatchObject({ effort: 'low', found: expect.any(Number), why: expect.any(String), how: expect.any(String), top: expect.any(Array) });
		const list = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) })).then(async (x) => (await x.json()).result.tools);
		expect(list.find((t: { name: string }) => t.name === 'get_quick_wins').annotations.readOnlyHint).toBe(true);
	});
});
