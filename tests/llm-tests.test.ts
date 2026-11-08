import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { setLink } from '../src/lib/server/links';
import { getSite } from '../src/lib/server/clients';
import { aiAssistantDaily } from '../src/lib/server/ga4';
import { ensureGa4AiDaily, ensureGa4TestData } from '../src/lib/server/ga4tests';
import { aiVerdict, countsDetectable, evaluateAi } from '../src/lib/server/llmtests';
import { createTest, evaluateTest, evaluateTestCached, listTests, mainResult } from '../src/lib/server/seotests';
import { demoAiPlant, demoGa4AiDaily, demoGa4AiTraffic } from '../src/lib/server/demo-channels';
import type { Ga4Source } from '../src/lib/server/channels';
import { parseScope, type LiftResult } from '../src/lib/experiments';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { queueDepth } from '../src/lib/server/jobs';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, MCP_TOOL_NAMES } from '../src/lib/server/mcp';
import { addDays, pacificToday } from '../src/lib/server/dates';

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
const dates = (from: string, to: string) => { const o: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) o.push(d.toISOString().slice(0, 10)); return o; };
const rng = (seed: number) => { let s = seed; const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296); return (l: number) => { if (l <= 0) return 0; const e = Math.exp(-l); let p = 1, n = 0; do { n++; p *= rnd(); } while (p > e); return n - 1; }; };
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

describe('GA4: AI-assistant sessions by day', () => {
	beforeEach(() => void (globalThis.__openSiteConsoleDb = openDb(':memory:')));
	it('asks for sessions by date, source and landing page with the AI-source filter, names the assistant, and merges query-string variants', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const row = (date: string, src: string, page: string, s: number) => ({ dimensionValues: [{ value: date }, { value: src }, { value: page }], metricValues: [{ value: String(s) }, { value: '0' }] });
		const f = (async (_u: string, init: RequestInit) => ((body = JSON.parse(String(init.body))), json({ rows: [row('20260101', 'chatgpt.com', '/a?utm_source=chatgpt.com', 3), row('20260101', 'chat.openai.com', '/a', 2), row('20260101', 'perplexity.ai', '/b/', 1), row('20260101', 'gemini.com', '/c', 9)] }))) as never;
		const r = await aiAssistantDaily(id, 'properties/1', '2026-01-01', '2026-01-01', { fetchImpl: f });
		expect(body.dimensions).toEqual([{ name: 'date' }, { name: 'sessionSource' }, { name: 'landingPagePlusQueryString' }]);
		expect(body.dimensionFilter.filter).toMatchObject({ fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP' } });
		expect(body.orderBys).toHaveLength(3); // stable order for offset paging
		// gemini.com (the exchange) is not an assistant and is dropped
		expect(r).toEqual([{ date: '2026-01-01', assistant: 'ChatGPT', page: '/a', sessions: 5, keyEvents: 0 }, { date: '2026-01-01', assistant: 'Perplexity', page: '/b', sessions: 1, keyEvents: 0 }]);
	});
});

describe('the metric is stored, validated and drives which GA4 data is loaded', () => {
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
	});
	it('defaults to search clicks; ai_sessions (optionally one assistant) makes an LLM test', () => {
		createTest(1, { name: 'Titles', kind: 'before_after', startDate: '2026-06-01', treatment: parseScope('/t/') });
		createTest(1, { name: 'FAQ for AI', kind: 'before_after', startDate: '2026-06-02', treatment: parseScope('/t/'), metric: 'ai_sessions' });
		createTest(1, { name: 'Schema for ChatGPT', kind: 'split', startDate: '2026-06-03', treatment: parseScope('/t/'), metric: 'ai_sessions', assistant: 'ChatGPT' });
		const [chat, faq, titles] = listTests(1);
		expect([titles.metric, titles.assistant]).toEqual(['clicks', null]);
		expect([faq.metric, faq.assistant]).toEqual(['ai_sessions', null]);
		expect([chat.metric, chat.assistant]).toEqual(['ai_sessions', 'ChatGPT']);
	});
	it('refuses an unknown metric, an unknown assistant, or an assistant on a clicks test', () => {
		const base = { name: 'x', kind: 'before_after' as const, startDate: '2026-06-01', treatment: parseScope('/t/') };
		expect(() => createTest(1, { ...base, metric: 'pageviews' as never })).toThrow(/search clicks or AI-assistant sessions/);
		expect(() => createTest(1, { ...base, metric: 'ai_sessions', assistant: 'Bard' as never })).toThrow(/Unknown AI assistant/);
		expect(() => createTest(1, { ...base, assistant: 'Claude' })).toThrow(/only be chosen for a test on AI-assistant sessions/);
		expect(listTests(1)).toEqual([]);
	});
	it('loads AI-assistant days only for LLM tests and organic landing days only for search tests', async () => {
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
		const calls: string[] = [];
		const src = { organicDaily: async () => (calls.push('organic'), []), aiDaily: async (_p: string, s: string) => (calls.push('ai'), [{ date: s, assistant: 'ChatGPT', page: '/a', sessions: 2, keyEvents: 0 }]) } as unknown as Ga4Source;
		const today = '2026-07-10';
		let r = await ensureGa4TestData(1, [{ start_date: '2026-06-01', window_days: 28, metric: 'clicks' }], src, today);
		expect(r.ai.skipped).toBe('no tests');
		expect(calls.every((c) => c === 'organic') && calls.length > 0).toBe(true);
		calls.length = 0;
		r = await ensureGa4TestData(1, [{ start_date: '2026-06-01', window_days: 28, metric: 'ai_sessions' }], src, today);
		expect(r.pages.skipped).toBe('no tests');
		expect(calls.every((c) => c === 'ai') && calls.length > 0).toBe(true);
		const m = db().prepare('SELECT from_date f, through_date t FROM ga4_ai_daily_meta WHERE site_id = 1').get();
		expect(m).toEqual({ f: addDays('2026-06-01', -140), t: today }); // back far enough for four earlier windows
		expect((db().prepare('SELECT COUNT(*) n FROM ga4_ai_daily').get() as { n: number }).n).toBeGreaterThan(0);
	});
	it('a GA4 failure is stored, not thrown, and shown on the test', async () => {
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
		const r = await ensureGa4AiDaily(1, [{ start_date: '2026-06-01', window_days: 28 }], { aiDaily: async () => { throw new Error('quota exhausted'); } } as unknown as Ga4Source, '2026-07-10');
		expect(r.error).toMatch(/quota/);
		createTest(1, { name: 'AI', kind: 'before_after', startDate: '2026-06-01', treatment: parseScope('/t/'), metric: 'ai_sessions' });
		const o = evaluateTest(getSite(1)!, listTests(1)[0]);
		expect(o.ai).toMatchObject({ status: 'error', sessions: null });
		expect(o.ai!.note).toMatch(/quota exhausted/);
		expect(o.conversions.status).toBe('unsupported'); // an LLM test is not judged on organic conversions
	});
});

describe('judging an LLM test', () => {
	const START = '2026-06-01';
	let seed = 7;
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
	});
	/** daily AI sessions for 5 test pages and 20 control pages (rates are per page a day), split 60/40 between ChatGPT and Perplexity */
	function load(o: { testRate: number; after: number; afterOnly?: 'ChatGPT' | 'Perplexity'; controlRate?: number; from?: string }) {
		const pois = rng(seed++);
		const d = db();
		d.prepare('DELETE FROM ga4_ai_daily').run();
		const ins = d.prepare('INSERT INTO ga4_ai_daily VALUES (1,?,?,?,?,0)');
		const from = o.from ?? '2025-12-01';
		d.transaction(() => {
			for (const day of dates(from, '2026-06-30')) {
				const post = day >= START;
				for (const [a, share] of [['ChatGPT', 0.6], ['Perplexity', 0.4]] as const) {
					const f = post && (!o.afterOnly || o.afterOnly === a) ? o.after : 1;
					for (let i = 0; i < 5; i++) { const n = pois(o.testRate * share * f); if (n) ins.run(day, a, `/t/${i}`, n); }
					for (let i = 0; i < 20; i++) { const n = pois((o.controlRate ?? 1) * share); if (n) ins.run(day, a, `/c/${i}`, n); }
				}
			}
		})();
		d.prepare("INSERT OR REPLACE INTO ga4_ai_daily_meta VALUES (1, ?, '2026-07-02', ?, NULL)").run(from, Date.now());
	}
	const test = (extra: Partial<Parameters<typeof evaluateAi>[1]> = {}) => ({ start_date: START, window_days: 28, treatment: parseScope('/t/'), control: { restOfSite: true as const }, meta: {}, ...extra });

	it('finds a clear lift, with a 95% range, a p-value and the smallest detectable change measured on earlier windows', () => {
		load({ testRate: 6, after: 1.8 });
		const r = evaluateAi(1, test());
		expect(r.status).toBe('ok');
		expect(r.verdict).toBe('positive');
		expect(r.sessions!.lift!).toBeGreaterThan(0.4);
		expect(r.sessions!.ciLow!).toBeGreaterThan(0);
		expect(r.sessions!.p!).toBeLessThan(0.05);
		expect(r.detectableBasis).toBe('calibrated');
		expect(r.sessions!.calibration.placebos).toBeGreaterThanOrEqual(3);
		expect([r.treatmentPages, r.controlPages]).toEqual([5, 20]);
		// the chart: 28 days before + 28 after, test in sessions a day, control scaled to the test pages' level before the change
		expect(r.series).toHaveLength(56);
		const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
		expect(avg(r.series.slice(0, 28).map((p) => p.control)) / avg(r.series.slice(0, 28).map((p) => p.treatment))).toBeCloseTo(1, 1);
		expect(avg(r.series.slice(35).map((p) => p.treatment))).toBeGreaterThan(avg(r.series.slice(35).map((p) => p.control)) * 1.4);
		// per assistant, sessions a day on the test pages, before and after
		expect(r.assistants.map((a) => a.assistant)).toEqual(['ChatGPT', 'Perplexity']);
		expect(r.assistants[0].after).toBeGreaterThan(r.assistants[0].before * 1.4);
	});

	it('no effect: never a gain or a loss', () => {
		load({ testRate: 6, after: 1 });
		const r = evaluateAi(1, test());
		expect(r.status).toBe('ok');
		expect(['inconclusive', 'too-little-ai-traffic']).toContain(r.verdict);
		expect(Math.abs(r.sessions!.lift!)).toBeLessThan(0.3);
	});

	it('too little AI traffic: says so with the smallest change it could see, instead of a verdict', () => {
		load({ testRate: 0.12, after: 2 }); // about 0.6 a day across the five test pages
		const r = evaluateAi(1, test());
		expect(r.sessions!.totals.tPre).toBeLessThan(30);
		expect(r.verdict).toBe('too-little-ai-traffic');
		expect(r.detectableBasis).toBe('counts');
		expect(r.detectable!).toBeGreaterThan(0.5);
		expect(r.note).toMatch(/^Too little AI traffic to tell: the test pages had \d+ AI-assistant sessions? before the change/);
		expect(r.note).toMatch(/only a change bigger than about ±\d+%/);
	});

	it('an inconclusive result that could only have seen a large change is reported as too little AI traffic, not "no effect"', () => {
		const base: LiftResult = { lift: 0.1, ciLow: -0.5, ciHigh: 1.2, p: 0.6, verdict: 'inconclusive', totals: { tPre: 40, tPost: 44, cPre: 300, cPost: 310 }, note: null, calibration: { placebos: 4, noiseSd: 0.3, detectable: 0.9 } };
		expect(aiVerdict(base, 28)).toMatchObject({ verdict: 'too-little-ai-traffic', detectable: 0.9, basis: 'calibrated' });
		expect(aiVerdict({ ...base, calibration: { ...base.calibration, detectable: 0.3 } }, 28).verdict).toBe('inconclusive');
		expect(aiVerdict({ ...base, verdict: 'positive', p: 0.01 }, 28).verdict).toBe('positive'); // a clear result stands, however wide
		// too few days after the change is "wait", not "too little traffic"
		expect(aiVerdict({ ...base, verdict: 'too-little-data', totals: { ...base.totals, tPre: 5 } }, 3).verdict).toBe('too-little-data');
		expect(countsDetectable(1000, 10000)).toBeLessThan(0.15);
		expect(countsDetectable(10, 1000)).toBeGreaterThan(1);
	});

	it('one assistant: the lift is measured on that assistant only', () => {
		load({ testRate: 8, after: 2.2, afterOnly: 'ChatGPT' });
		expect(evaluateAi(1, test({ assistant: 'ChatGPT' })).verdict).toBe('positive');
		const p = evaluateAi(1, test({ assistant: 'Perplexity' }));
		expect(['inconclusive', 'too-little-ai-traffic']).toContain(p.verdict);
		expect(p.assistant).toBe('Perplexity');
		expect(p.assistants.map((a) => a.assistant)).toEqual(['ChatGPT', 'Perplexity']); // the breakdown still shows every assistant
	});

	it('a matched control with almost no AI traffic falls back to the rest of the site, and says so; a named one is kept', () => {
		load({ testRate: 6, after: 1.8 });
		const thin = { prefixes: [], urls: ['https://greenleaf.example/c/0'] };
		const r = evaluateAi(1, test({ control: thin, meta: { controlMethod: 'sections' } }));
		expect(r.controlFallback).toMatch(/too few to compare against/);
		expect(r.controlPages).toBe(20);
		expect(r.verdict).toBe('positive');
		const named = evaluateAi(1, test({ control: thin, meta: { controlMethod: 'named' } }));
		expect(named.controlFallback).toBeNull();
		expect(named.verdict).toBe('too-little-ai-traffic'); // the control pages had too few sessions
		expect(named.note).toMatch(/control pages had \d+ AI-assistant sessions/);
	});

	it('says why there is no result: no GA4, still loading, or not enough history', () => {
		db().prepare('DELETE FROM site_links').run();
		expect(evaluateAi(1, test())).toMatchObject({ status: 'no-ga4' });
		setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
		expect(evaluateAi(1, test())).toMatchObject({ status: 'loading' });
		load({ testRate: 6, after: 1, from: '2026-05-20' });
		expect(evaluateAi(1, test())).toMatchObject({ status: 'partial' });
		expect(evaluateAi(1, test({ treatment: parseScope('https://other.example/t/') }))).toMatchObject({ status: 'unsupported' });
	});

	it('through evaluateTest: the test is judged on AI sessions, and a new GA4 load recomputes the cached result', () => {
		load({ testRate: 6, after: 1.8 });
		createTest(1, { name: 'AI rewrite', kind: 'before_after', startDate: START, treatment: parseScope('/t/'), metric: 'ai_sessions' });
		const site = getSite(1)!;
		const o = evaluateTestCached(site, listTests(1)[0]);
		expect(o.metric).toBe('ai_sessions');
		expect(mainResult(o)).toBe(o.ai!.sessions);
		expect(o.ai!.verdict).toBe('positive');
		db().prepare('UPDATE seo_test_results SET outcome = ?').run(JSON.stringify({ ...o, treatmentPages: 999 }));
		expect(evaluateTestCached(site, listTests(1)[0]).treatmentPages).toBe(999); // cached
		db().prepare('UPDATE ga4_ai_daily_meta SET pulled_at = pulled_at + 1').run();
		expect(evaluateTestCached(site, listTests(1)[0]).treatmentPages).not.toBe(999);
	});
});

describe('demo data', () => {
	it('the daily and the whole-window AI reports agree, ChatGPT is the largest, and the planted page rises after the change date', () => {
		const prop = 'properties/10000';
		const plant = demoAiPlant('sc-domain:greenleaf.example');
		const end = addDays(pacificToday(), -2);
		const daily = demoGa4AiDaily(prop, addDays(end, -27), end);
		const sum = daily.reduce((a, r) => a + r.sessions, 0);
		return demoGa4AiTraffic(prop, addDays(end, -27), end).then((w) => {
			expect(w.reduce((a, r) => a + r.sessions, 0)).toBe(sum);
			const by = new Map<string, number>();
			for (const r of w) by.set(r.assistant, (by.get(r.assistant) ?? 0) + r.sessions);
			expect([...by].sort((a, b) => b[1] - a[1])[0][0]).toBe('ChatGPT');
			const perDay = (page: string, s: string, e: string) => demoGa4AiDaily(prop, s, e).filter((r) => r.page === page).reduce((a, r) => a + r.sessions, 0) / 28;
			const pre = (p: string) => perDay(p, addDays(plant.changeDate, -28), addDays(plant.changeDate, -1));
			const post = (p: string) => perDay(p, addDays(plant.changeDate, 7), addDays(plant.changeDate, 34));
			expect(post(plant.liftPage)).toBeGreaterThan(pre(plant.liftPage) * 1.8);
			expect(post(plant.flatPage) / pre(plant.flatPage)).toBeLessThan(1.3);
		});
	});
});

describe('end to end on demo data, and through MCP', () => {
	let writer = '';
	beforeAll(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
		await autoMatchGa4();
		await drain();
		writer = createApiKey('writer', null, null, true).key;
	}, 120_000);
	const call = async (name: string, args: object) => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${writer}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		const text = r.content[0].text as string;
		return { isError: !!r.isError, text, data: r.isError ? text : JSON.parse(text) };
	};

	it('an LLM test on the planted page is positive; on the unchanged page it is not', async () => {
		const plant = demoAiPlant(getSite(1)!.site_url);
		createTest(1, { name: 'Rewritten for AI answers', kind: 'before_after', startDate: plant.changeDate, treatment: parseScope(plant.liftPage), metric: 'ai_sessions' });
		createTest(1, { name: 'FAQ added', kind: 'before_after', startDate: plant.changeDate, treatment: parseScope(plant.flatPage), metric: 'ai_sessions' });
		const r = await ensureGa4TestData(1, listTests(1));
		expect(r.ai.error).toBeNull();
		expect(r.ai.pulled).toBeGreaterThan(100);
		const site = getSite(1)!;
		const [faq, rewrite] = listTests(1).sort((a, b) => a.id - b.id).reverse();
		const up = evaluateTest(site, rewrite).ai!;
		expect(up.status).toBe('ok');
		expect(up.verdict).toBe('positive');
		expect(up.sessions!.lift!).toBeGreaterThan(0.5);
		const flat = evaluateTest(site, faq).ai!;
		expect(flat.status).toBe('ok');
		expect(['inconclusive', 'too-little-ai-traffic']).toContain(flat.verdict);
	}, 60_000);

	it('start_seo_test takes the metric and an assistant; get_seo_tests returns them with the AI result; the tool count is unchanged', async () => {
		const plant = demoAiPlant(getSite(1)!.site_url);
		const before = MCP_TOOL_NAMES.length;
		const bad = await call('start_seo_test', { site: '1', name: 'x', startDate: plant.changeDate, pages: [plant.liftPage], metric: 'pageviews' });
		expect(bad.isError).toBe(true);
		expect(bad.text).toMatch(/clicks or ai_sessions/);
		expect((await call('start_seo_test', { site: '1', name: 'x', startDate: plant.changeDate, pages: [plant.liftPage], assistant: 'ChatGPT' })).text).toMatch(/needs metric ai_sessions/);
		expect((await call('start_seo_test', { site: '1', name: 'x', startDate: plant.changeDate, pages: [plant.liftPage], metric: 'ai_sessions', assistant: 'Bard' })).text).toMatch(/must be one of/);
		const t = await call('start_seo_test', { site: '1', name: 'ChatGPT only', startDate: plant.changeDate, pages: [plant.liftPage], metric: 'ai_sessions', assistant: 'ChatGPT' });
		expect(t.data).toMatchObject({ ok: true, metric: 'ai_sessions', assistant: 'ChatGPT' });
		await drain(); // the GA4 AI-assistant days load in the background
		const tests = (await call('get_seo_tests', { site: '1' })).data as Record<string, any>[];
		const mine = tests.find((x) => x.id === t.data.testId)!;
		expect(mine).toMatchObject({ metric: 'ai_sessions', assistant: 'ChatGPT' });
		expect(mine.aiSessions.verdict).toBe('positive');
		expect(mine.aiSessions.smallestDetectableChange).toMatch(/^±\d/);
		expect(mine.aiSessions.caveat).toMatch(/referrer/);
		const clicksTest = (await call('start_seo_test', { site: '1', name: 'Guides titles', startDate: plant.changeDate, pages: ['/guides/'] })).data;
		expect(clicksTest.metric).toBe('clicks');
		const again = (await call('get_seo_tests', { site: '1' })).data as Record<string, any>[];
		const ct = again.find((x) => x.id === clicksTest.testId)!;
		expect(ct.metric).toBe('clicks');
		expect(ct).not.toHaveProperty('aiSessions');
		expect(MCP_TOOL_NAMES.length).toBe(before);
	}, 60_000);
});
