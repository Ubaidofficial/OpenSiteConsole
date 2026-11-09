import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleRest } from '../src/lib/server/rest';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { classifyIntent, safeRegex } from '../src/lib/trends';

let key = '';
const call = async (tool: string, q: string) => {
	const r = await handleRest(new Request(`http://x/api/v1/${tool}?${q}`, { headers: { authorization: `Bearer ${key}` } }), tool);
	return { status: r.status, body: (await r.json()) as any };
};

beforeAll(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	key = createApiKey('parity', null).key;
}, 120_000);

describe('search intent', () => {
	it('classifies by wording, brand first, and leaves the rest unclassified rather than guessing', () => {
		const brand = ['greenleaf'];
		expect(classifyIntent('greenleaf', brand)).toBe('navigational');
		expect(classifyIntent('greenleaf login', brand)).toBe('navigational');
		expect(classifyIntent('buy monstera online', brand)).toBe('transactional');
		expect(classifyIntent('plant shop near me')).toBe('transactional');
		expect(classifyIntent('best indoor plants for low light')).toBe('commercial');
		expect(classifyIntent('greenleaf vs bloomscape reviews', ['x'])).toBe('commercial');
		expect(classifyIntent('how to repot a snake plant')).toBe('informational');
		expect(classifyIntent('monstera care guide')).toBe('informational');
		expect(classifyIntent('monstera deliciosa')).toBe('unclassified');
		expect(classifyIntent('  ')).toBe('unclassified');
	});
});

describe('regex filters', () => {
	it('accepts ordinary patterns, case-insensitive', () => {
		const r = safeRegex('^how (to|do)');
		expect('re' in r && r.re.test('How to water')).toBe(true);
	});
	it('refuses patterns that can run away, back-references, lookarounds, bad syntax and long input', () => {
		const bad = ['(a+)+$', '(.*)*x', '(\\w+\\s?){2,}$', '((a+))+$', '(a|a?)+$', '.*.*.*.*.*.*x', 'a*b*c*', '(?=a)b', '(?<!x)y', '(a|b)\\1', '([a-z', '[a-z', '', 'x'.repeat(201), 'a?'.repeat(9)];
		for (const p of bad) expect('error' in safeRegex(p), p).toBe(true);
	});
	it('still accepts the patterns people write', () => {
		const good = ['^how (to|do) ', 'garden\\s+tools?', '^/blog/', '(best|top) [a-z]+ tools$', 'shoe.*?size', '^https://[^/]+/products/', 'colou?r', '\\d{4}', '(?:red|blue) shoes', '[(]draft[)]'];
		for (const p of good) expect('re' in safeRegex(p), p).toBe(true);
	});
	it('a pattern that is accepted stays fast on long text', () => {
		const r = safeRegex('.*x.*y');
		expect('re' in r).toBe(true);
		const t = Date.now();
		if ('re' in r) for (let i = 0; i < 200; i++) r.re.test('a'.repeat(500));
		expect(Date.now() - t).toBeLessThan(2000);
	});
});

describe('MCP parity: get_trends and get_performance', () => {
	it('monthly: complete months, newest last, each with its change and the winners and losers of that month', async () => {
		const { status, body } = await call('get_trends', 'site=1&view=monthly&limit=3');
		expect(status).toBe(200);
		const months = body.data.months as { month: string; clicks: number; clicksChangePct: number | null; pageWinners: unknown[]; pageLosers: unknown[] }[];
		expect(months.length).toBe(3);
		expect([...months].map((m) => m.month)).toEqual([...months.map((m) => m.month)].sort());
		for (const m of months) {
			expect(m.month).toMatch(/^\d{4}-\d{2}$/);
			expect(m.clicks).toBeGreaterThan(0);
			expect(Array.isArray(m.pageWinners) && Array.isArray(m.pageLosers)).toBe(true);
		}
	});

	it('query_count: one row per week, oldest first, with all searches, those with clicks and those in the top 10', async () => {
		const { body } = await call('get_trends', 'site=1&view=query_count&limit=8');
		const w = body.data.weeks as { weekEnding: string; queries: number; withClicks: number; top10: number }[];
		expect(w.length).toBe(8);
		expect(w[0].weekEnding < w[7].weekEnding).toBe(true);
		for (const x of w) {
			expect(x.queries).toBeGreaterThan(0);
			expect(x.withClicks).toBeLessThanOrEqual(x.queries);
			expect(x.top10).toBeLessThanOrEqual(x.queries);
		}
	});

	it('intent: every intent listed, shares adding up to 100%, and a caution about the method', async () => {
		const { body } = await call('get_trends', 'site=1&view=intent');
		const intents = body.data.intents as { intent: string; clickShare: number; impressionShare: number }[];
		expect(intents.map((i) => i.intent)).toEqual(['navigational', 'transactional', 'commercial', 'informational', 'unclassified']);
		expect(intents.reduce((a, i) => a + i.impressionShare, 0)).toBeCloseTo(100, 0);
		expect(body.data.caution).toMatch(/English/);
	});

	it('get_performance filters by regex and by exclusion, and refuses a runaway pattern with the reason', async () => {
		const all = (await call('get_performance', 'site=1&dimension=query&limit=500')).body.data.rows as { query: string }[];
		const re = (await call('get_performance', 'site=1&dimension=query&limit=500&query_regex=' + encodeURIComponent('^(how|what) '))).body.data.rows as { query: string }[];
		expect(re.length).toBeGreaterThan(0);
		expect(re.length).toBeLessThan(all.length);
		for (const r of re) expect(r.query).toMatch(/^(how|what) /i);
		const word = re[0].query.split(' ')[0];
		const ex = (await call('get_performance', `site=1&dimension=query&limit=500&exclude_query=${encodeURIComponent(word)}`)).body.data.rows as { query: string }[];
		for (const r of ex) expect(r.query.toLowerCase()).not.toContain(word.toLowerCase());
		const bad = await call('get_performance', 'site=1&query_regex=' + encodeURIComponent('(a+)+'));
		expect(bad.status).toBe(400);
		expect(bad.body.error.message).toMatch(/query_regex.*quantifier on a group/);
	});
});
