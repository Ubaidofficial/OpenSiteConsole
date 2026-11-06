import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { buildDigest, buildSiteDigest, dueWeekKey, listDigests, postWebhook, runUrgentAlerts, runWeeklyDigest, webhook } from '../src/lib/server/digest';
import { clicksSignificant, headlineOf, renderText, renderUrgent, type Digest, type SiteDigest } from '../src/lib/digest';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { queueFor } from '../src/lib/server/actions';

const site = (o: Partial<SiteDigest> = {}): SiteDigest => ({
	siteId: 1, name: 'a.example', week: { start: '2026-10-25', end: '2026-10-31' }, comparable: true,
	clicks: { now: 100, prev: 100, change: 0, significant: false }, impressions: { now: 1, prev: 1, change: 0 }, position: { now: 5, prev: 5 },
	queryWinners: [], queryLosers: [], pageWinners: [], pageLosers: [], events: [], updates: [], decidedTests: [], openActions: 0, blockingActions: 0, topActions: [], ...o
});
const top = (o: object = {}) => ({ key: 'k', type: 'blocked' as const, title: 'Pages blocked', blocking: true, impact: 120, confidence: 'high' as const, href: '/sites/1/indexing', site: 'a.example', siteId: 1, ...o });

describe('digest wording', () => {
	it('only calls a change real when it is beyond wobble', () => {
		expect(clicksSignificant(100, 98)).toBe(false);
		expect(clicksSignificant(130, 100)).toBe(false); // +30 on 100: z = 1.98, just under the bar
		expect(clicksSignificant(135, 100)).toBe(true); // +35: z = 2.28
		expect(clicksSignificant(110, 100)).toBe(false); // a 10% move on 100 clicks is wobble
		expect(clicksSignificant(1010, 1000)).toBe(false); // +10 clicks, z small
		expect(clicksSignificant(0, 0)).toBe(false);
		expect(clicksSignificant(400, 600)).toBe(true);
	});
	it('headline: blocking first, real gains and declines named, wobble never reported, unknowns admitted', () => {
		const h = headlineOf(
			[
				site({ name: 'up.example', clicks: { now: 200, prev: 100, change: 1, significant: true }, openActions: 2 }),
				site({ name: 'down.example', clicks: { now: 60, prev: 100, change: -0.4, significant: true }, blockingActions: 1, openActions: 3 }),
				site({ name: 'flat.example', clicks: { now: 101, prev: 100, change: 0.01, significant: false } }),
				site({ name: 'new.example', comparable: false, clicks: { now: 50, prev: 0, change: null, significant: false } })
			],
			[top({ site: 'down.example', title: 'Key pages blocked' })]
		);
		expect(h[0]).toMatch(/1 blocking issue need attention first: down\.example: Key pages blocked/);
		expect(h.join(' ')).toMatch(/Clicks across 3 sites: 361 this week against 300/);
		expect(h.join(' ')).toMatch(/Biggest real decline: down\.example -40%/);
		expect(h.join(' ')).toMatch(/Biggest real gain: up\.example \+100%/);
		expect(h.join(' ')).not.toMatch(/flat\.example/);
		expect(h.join(' ')).toMatch(/1 site is not compared yet/);
	});
	it('headline: calm weeks say so; updates and decided tests are included', () => {
		expect(headlineOf([site({ openActions: 0 })], [])[0]).toMatch(/Nothing needs doing across 1 site/);
		expect(headlineOf([site({ openActions: 4 })], [])[0]).toMatch(/Nothing is blocking. 4 open actions/);
		const h = headlineOf(
			[site({ updates: [{ name: 'May core update', kind: 'core', begin: '2026-10-26', end: null, startedThisWeek: true, endedThisWeek: false }], decidedTests: [{ name: 'Titles', verdict: 'positive', lift: 0.2 }], events: [{ kind: 'deindexed', url: 'u', detail: null }] })],
			[]
		).join(' | ');
		expect(h).toMatch(/started the May core update this week.*avoid sweeping changes/);
		expect(h).toMatch(/Test “Titles” \(a\.example\) likely worked \(\+20% vs control\)/);
		expect(h).toMatch(/1 page was dropped from Google's index/);
	});
	it('text for chat: readable, with absolute links, and honest about the numbers', () => {
		const d: Digest = { createdAt: 1, weekEnd: '2026-10-31', headline: ['Nothing is blocking.'], sites: [], top: [top(), top({ key: 'z', blocking: false, impact: null, title: 'Fix titles' })] };
		const t = renderText(d, 'https://seo.example');
		expect(t).toContain('*SEO digest, week ending 2026-10-31*');
		expect(t).toContain('1. 🛑 a.example: Pages blocked (≈120 clicks / 28 d, high confidence)');
		expect(t).toContain('https://seo.example/sites/1/indexing');
		expect(t).toContain('2. a.example: Fix titles\n');
		expect(t).toMatch(/not promises and not additive/);
		const two = renderUrgent(Array.from({ length: 8 }, (_, i) => ({ site: 's', title: 't' + i, why: 'w', href: '/h' })), '', 2);
		expect(two).toContain('10 blocking issues');
		expect(two).toContain('…and 2 more, to follow.');
	});
	it('picks the most recent digest weekday, today included', () => {
		expect(dueWeekKey('2026-11-02', 1)).toBe('2026-11-02'); // a Monday
		expect(dueWeekKey('2026-11-05', 1)).toBe('2026-11-02'); // Thursday catches up to Monday
		expect(dueWeekKey('2026-11-08', 1)).toBe('2026-11-02'); // Sunday still belongs to that week
		expect(dueWeekKey('2026-11-09', 1)).toBe('2026-11-09');
		expect(dueWeekKey('2026-11-05', 0)).toBe('2026-11-01'); // Sunday digests
		expect(dueWeekKey('2026-11-05', 4)).toBe('2026-11-05');
	});
});

describe('webhook delivery', () => {
	afterEach(() => { delete process.env.DIGEST_WEBHOOK_URL; delete process.env.DIGEST_WEBHOOK_FORMAT; });
	const spy = () => { const seen: { url: string; init: RequestInit }[] = []; return { seen, f: (async (u: URL, init: RequestInit) => (seen.push({ url: String(u), init }), new Response('ok', { status: 200 }))) as never }; };
	it('formats for Slack (default), Discord and raw JSON; never follows redirects', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		const s = spy();
		expect(await postWebhook('hello', { a: 1 }, s.f)).toMatchObject({ ok: true });
		expect(JSON.parse(String(s.seen[0].init.body))).toEqual({ text: 'hello' });
		expect(s.seen[0].init.redirect).toBe('error');
		process.env.DIGEST_WEBHOOK_FORMAT = 'discord';
		await postWebhook('x'.repeat(5000), {}, s.f);
		expect(JSON.parse(String(s.seen[1].init.body)).content).toHaveLength(1900);
		process.env.DIGEST_WEBHOOK_FORMAT = 'json';
		await postWebhook('hello', { a: 1 }, s.f);
		expect(JSON.parse(String(s.seen[2].init.body))).toEqual({ text: 'hello', digest: { a: 1 } });
		process.env.DIGEST_WEBHOOK_FORMAT = 'nonsense';
		expect(webhook().format).toBe('slack');
	});
	it('refuses unsafe or missing configuration and reports failures plainly', async () => {
		expect((await postWebhook('x', {})).message).toMatch(/No webhook/);
		for (const bad of ['http://hooks.example/x', 'ftp://x/y', 'not a url']) { process.env.DIGEST_WEBHOOK_URL = bad; expect(await postWebhook('x', {}, spy().f), bad).toMatchObject({ ok: false }); }
		process.env.DIGEST_WEBHOOK_URL = 'http://localhost:9999/hook';
		expect((await postWebhook('x', {}, spy().f)).ok).toBe(true); // a local receiver is fine
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		expect((await postWebhook('x', {}, (async () => new Response('no', { status: 500 })) as never)).message).toMatch(/HTTP 500/);
		expect((await postWebhook('x', {}, (async () => { throw Object.assign(new Error('t'), { name: 'TimeoutError' }); }) as never)).message).toMatch(/10 seconds/);
		expect((await postWebhook('x', {}, (async () => { throw new Error('boom'); }) as never)).message).toMatch(/Could not reach/);
	});
});

describe('weekly digest and urgent alerts', () => {
	let key = '';
	beforeAll(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		for (const id of [1, 2]) {
			const client = new DemoClient('demo-a');
			let guard = 0;
			await syncSite(id, { client, backfillChunkDays: 120 });
			while (!getSite(id)!.backfill_done && guard++ < 12) await syncSite(id, { client, backfillChunkDays: 120 });
		}
		const page = (db().prepare('SELECT page FROM sa_rows WHERE site_id = 1 GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 1').get() as { page: string }).page;
		db().prepare('INSERT OR REPLACE INTO url_inspections VALUES (1,?,?,?)').run(page, Date.now(), JSON.stringify({ indexStatusResult: { verdict: 'NEUTRAL', robotsTxtState: 'DISALLOWED' } })); // a blocking problem
		key = createApiKey('only site 1', [1]).key;
	}, 120_000);
	afterEach(() => { delete process.env.DIGEST_WEBHOOK_URL; });

	it('builds a site\'s week with real movers and its top actions', () => {
		const s = buildSiteDigest(getSite(1)!);
		expect(s.comparable).toBe(true);
		expect(s.week.end).toBe(getSite(1)!.synced_through);
		expect(s.clicks.now).toBeGreaterThan(0);
		expect(s.blockingActions).toBeGreaterThanOrEqual(1);
		expect(s.topActions[0].blocking).toBe(true);
		expect(s.topActions.length).toBeLessThanOrEqual(5);
		expect(Math.abs(s.clicks.change ?? 0)).toBeLessThan(2);
	});
	it('claims nothing about a site whose previous week is not downloaded', () => {
		const copy = { ...getSite(2)!, backfill_done: 0, backfilled_to: getSite(2)!.synced_through! };
		const s = buildSiteDigest(copy);
		expect(s).toMatchObject({ comparable: false, clicks: { prev: 0, change: null, significant: false } });
		expect(s.queryWinners).toEqual([]);
	});
	it('the whole digest ranks blocking first and names the problem in its headline', () => {
		const d = buildDigest();
		expect(d.sites.length).toBeGreaterThanOrEqual(2);
		expect(d.sites.map((s) => s.siteId)).toEqual(expect.arrayContaining([1, 2]));
		expect(d.top[0].blocking).toBe(true);
		expect(d.headline[0]).toMatch(/blocking issue/);
	});

	it('makes one digest per week, catches up late in the week, and an extra by hand', async () => {
		const first = await runWeeklyDigest({ today: '2026-11-04' });
		expect(first).toMatchObject({ created: true, delivery: 'none' });
		expect(listDigests('weekly')[0].weekKey).toBe('2026-11-02');
		expect(await runWeeklyDigest({ today: '2026-11-06' })).toMatchObject({ created: false }); // same week
		expect(await runWeeklyDigest({ today: '2026-11-09' })).toMatchObject({ created: true }); // next Monday
		const manual = await runWeeklyDigest({ force: true });
		expect(manual.created).toBe(true);
		expect(listDigests('weekly').filter((d) => d.weekKey === null)).toHaveLength(1);
		expect(listDigests('weekly')).toHaveLength(3);
	});
	it('sends it when a webhook is set, and records a failure honestly', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		const sent: string[] = [];
		const ok = await runWeeklyDigest({ force: true, fetchImpl: (async (_u: URL, i: RequestInit) => (sent.push(JSON.parse(String(i.body)).text), new Response('ok'))) as never });
		expect(ok.delivery).toBe('sent');
		expect(sent[0]).toMatch(/SEO digest, week ending/);
		const bad = await runWeeklyDigest({ force: true, fetchImpl: (async () => new Response('x', { status: 502 })) as never });
		expect(bad).toMatchObject({ delivery: 'failed', message: expect.stringMatching(/502/) });
		expect(listDigests('weekly')[0]).toMatchObject({ delivery: 'failed' });
	});

	it('urgent alerts: announced once, again only after two weeks, and a failed delivery is retried', async () => {
		const blocking = queueFor(getSite(1)!).open.filter((a) => a.blocking).length;
		expect(blocking).toBeGreaterThan(0);
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		const down = (async () => new Response('x', { status: 500 })) as never;
		expect(await runUrgentAlerts({ fetchImpl: down })).toMatchObject({ alerted: 0, delivery: 'failed' });
		expect(await runUrgentAlerts({ fetchImpl: down })).toMatchObject({ alerted: 0, delivery: 'failed' });
		expect(listDigests('urgent').filter((d) => d.delivery === 'failed')).toHaveLength(1); // not a row per attempt
		const texts: string[] = [];
		const up = (async (_u: URL, i: RequestInit) => (texts.push(JSON.parse(String(i.body)).text), new Response('ok'))) as never;
		const r = await runUrgentAlerts({ fetchImpl: up });
		expect(r.delivery).toBe('sent');
		expect(r.alerted).toBeGreaterThanOrEqual(blocking);
		expect(texts[0]).toMatch(/SEO alert/);
		expect(await runUrgentAlerts({ fetchImpl: up })).toMatchObject({ alerted: 0 }); // already told
		db().prepare('UPDATE alerts_sent SET sent_at = ?').run(Date.now() - 15 * 86_400_000);
		expect((await runUrgentAlerts({ fetchImpl: up })).alerted).toBeGreaterThanOrEqual(blocking); // still open after two weeks: again
	});
	it('without a webhook alerts still appear in the app, once', async () => {
		db().prepare('DELETE FROM alerts_sent').run();
		const before = listDigests('urgent').length;
		expect((await runUrgentAlerts()).alerted).toBeGreaterThan(0);
		expect(listDigests('urgent')).toHaveLength(before + 1);
		expect(listDigests('urgent')[0]).toMatchObject({ delivery: 'none' });
		expect((await runUrgentAlerts()).alerted).toBe(0);
	});

	it('MCP: the digest covers only the sites the key may see', async () => {
		const r = (await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_digest', arguments: {} } }) }))).json()).result;
		expect(r.isError).toBeUndefined();
		const d = JSON.parse(r.content[0].text);
		expect(d.sites.map((s: { site: string }) => s.site)).toEqual(['greenleaf.example']);
		expect(d.doThisFirst.every((t: { site: string }) => t.site === 'greenleaf.example')).toBe(true);
		expect(d.headline[0]).toMatch(/blocking/);
	});
});
