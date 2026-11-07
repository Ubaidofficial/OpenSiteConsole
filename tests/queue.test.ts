import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { connectBingKey } from '../src/lib/server/connect';
import { getSite } from '../src/lib/server/clients';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';
import { queueDepth } from '../src/lib/server/jobs';
import { BingApiError, type BingClient } from '../src/lib/server/bing';
import { addWatch, watchList } from '../src/lib/server/indexmon';
import {
	MAX_QUEUE, RECHECK_DAYS, clearQueue, drainQueue, queueStatus, quotaOverview, refreshBingQuota, runDueRechecks, runSubmissionWork, submissionStatus, submissionWorkDue, submissionsCsv, submitForIndexing, SubmitRefused
} from '../src/lib/server/submission';
import { enqueueSubmissionWork } from '../src/lib/server/jobs';

// URL Inspection is replaced by a switch, so every outcome (indexed, not indexed, Google refusing) can be produced exactly.
type Mode = 'indexed' | 'not' | 'fail' | 'real';
const mode = { v: 'real' as Mode, coverage: 'Crawled - currently not indexed' };
vi.mock('../src/lib/server/inspect', async (orig) => {
	const m = await orig<typeof import('../src/lib/server/inspect')>();
	return {
		...m,
		inspectUrls: async (siteId: number, urls: string[], force: boolean) => {
			if (mode.v === 'real') return m.inspectUrls(siteId, urls, force);
			if (mode.v === 'fail') throw new Error('Google refused');
			const put = (await import('../src/lib/server/db')).db().prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
			for (const u of urls) put.run(siteId, u, Date.now(), JSON.stringify({ indexStatusResult: mode.v === 'indexed' ? { verdict: 'PASS', coverageState: 'Submitted and indexed' } : { verdict: 'NEUTRAL', coverageState: mode.coverage } }));
			return { live: urls.length, cached: 0, outcomes: urls.map((url) => ({ url, fromCache: false })) };
		}
	};
});

const DAY = 86_400_000;
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const site = () => getSite(1)!;
const U = (p: string) => `https://greenleaf.example${p}`;
const many = (n: number, prefix = '/q') => Array.from({ length: n }, (_, i) => U(`${prefix}${i}`));

/** A Bing whose allowance and health can be changed between calls. */
const bing = (st: { daily: number | null; fail?: BingApiError } = { daily: 10_000 }) => {
	const calls: string[][] = [];
	const c: BingClient = {
		listSites: async () => [], dailyStats: async () => [], queryStats: async () => [], pageStats: async () => [],
		urlSubmissionQuota: async () => ({ daily: st.daily, monthly: 300_000 }),
		submitUrlBatch: async (_s, urls) => {
			if (st.fail) throw st.fail;
			calls.push(urls);
			if (st.daily != null) st.daily -= urls.length;
		}
	};
	return { c, calls, st };
};
const queued = (channel = 'bing') => db().prepare('SELECT url, release_at r FROM index_queue WHERE site_id = 1 AND channel = ? ORDER BY id').all(channel) as { url: string; r: number }[];

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await connectBingKey('demo', 'b');
	await drain();
}, 120_000);

beforeEach(() => {
	mode.v = 'real';
	mode.coverage = 'Crawled - currently not indexed';
	for (const t of ['index_submissions', 'index_watch', 'index_queue', 'index_rechecks', 'indexnow_keys', 'indexnow_hosts', 'indexnow_urls', 'indexnow_log', 'audit_log']) db().prepare(`DELETE FROM ${t}`).run();
	db().prepare("DELETE FROM kv WHERE key LIKE 'bing_quota:%' OR key LIKE 'submit:%' OR key LIKE 'indexingapi:%'").run();
});
afterEach(() => {
	delete process.env.READ_ONLY;
	delete process.env.GOOGLE_INCLUDE_INDEXING;
});

describe('the IndexNow wording', () => {
	it('names only the engines indexnow.org lists, not Amazon or the Internet Archive', () => {
		const t = readFileSync('src/routes/sites/[id]/indexnow/+page.svelte', 'utf8');
		expect(t).not.toMatch(/Amazon|Internet Archive/);
		expect(t).toMatch(/Bing, Naver, Seznam\.cz, Yandex and Yep/);
	});
});

describe('queueing what does not fit today', () => {
	it('what is over Bing\'s allowance is queued (and shown as queued), not lost; with queueOverflow off it is only skipped', async () => {
		const b = bing({ daily: 1 });
		const r = await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', bingClient: b.c });
		expect(r.channels[0]).toMatchObject({ accepted: 1, queued: 2, acceptedUrls: [many(3)[0]] });
		expect(queued().map((x) => x.url)).toEqual(many(3).slice(1));
		expect(queueStatus(1).byChannel.bing).toBe(2);
		clearQueue(1, 'app');
		const off = await submitForIndexing(site(), many(3, '/z'), { channels: ['bing'], source: 'app', bingClient: bing({ daily: 1 }).c, queueOverflow: false });
		expect(off.channels[0]).toMatchObject({ accepted: 1, queued: 0 });
		expect(queued()).toEqual([]);
	});

	it('a dry run says how many would be queued and writes nothing', async () => {
		const r = await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', dryRun: true, bingClient: bing({ daily: 1 }).c });
		expect(r.channels[0]).toMatchObject({ queued: 2, accepted: 0 });
		expect(r.channels[0].notes.join(' ')).toMatch(/would be queued/);
		expect(queued()).toEqual([]);
	});

	it('IndexNow over its daily cap queues the rest, and a channel that cannot be used queues nothing', async () => {
		process.env.INDEXNOW_MAX_PER_DAY = '2';
		try {
			db().prepare("INSERT INTO indexnow_keys (site_id, key, created_at, auto) VALUES (1, 'abcdef0123456789abcdef0123456789', ?, 0)").run(Date.now());
			db().prepare("INSERT INTO indexnow_hosts VALUES (1,'greenleaf.example',?,1,'ok')").run(Date.now());
			const f = (async () => new Response('', { status: 200 })) as typeof fetch;
			const r = await submitForIndexing(site(), many(5), { channels: ['indexnow'], source: 'app', fetchImpl: f });
			expect(r.channels[0]).toMatchObject({ accepted: 2, queued: 3 });
			expect(queued('indexnow').map((x) => x.url)).toEqual(many(5).slice(2));
			const off = await submitForIndexing(site(), many(2, '/g'), { channels: ['google_indexing_api'], source: 'app', fetchImpl: f });
			expect(off.channels[0]).toMatchObject({ available: false, queued: 0 });
		} finally {
			delete process.env.INDEXNOW_MAX_PER_DAY;
		}
	});

	it('the queue has a ceiling, and says how many did not fit', async () => {
		const ins = db().prepare("INSERT INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source) VALUES (1,?,'bing',?,?,?, 'app')");
		db().transaction(() => { for (let i = 0; i < MAX_QUEUE - 1; i++) ins.run(U('/fill' + i), Date.now(), Date.now() + 365 * DAY, Date.now() + 365 * DAY); })();
		const r = await submitForIndexing(site(), many(4), { channels: ['bing'], source: 'app', bingClient: bing({ daily: 0 }).c });
		expect(r.channels[0].queued).toBe(1);
		expect(r.channels[0].notes.join(' ')).toMatch(/queue is full.*3 were not queued/);
		expect(queueStatus(1).total).toBe(MAX_QUEUE);
	});

	it('URLs already waiting count as queued and keep their place; sending the same list again is not reported as "queue full"', async () => {
		const b = bing({ daily: 0 });
		const first = await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', bingClient: b.c });
		expect(first.channels[0].queued).toBe(3);
		const before = queued();
		const again = await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', bingClient: b.c });
		expect(again.channels[0].queued).toBe(3);
		expect(again.channels[0].notes.join(' ')).not.toMatch(/queue is full/);
		expect(queued()).toEqual(before); // nothing duplicated, release times untouched
		const dry = await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', dryRun: true, bingClient: b.c });
		expect(dry.channels[0].queued).toBe(3);
	});
});

describe('draining the queue', () => {
	it('sends what is due once the allowance is back, keeps what still does not fit, and logs it as the queue\'s own', async () => {
		const b = bing({ daily: 1 });
		await submitForIndexing(site(), many(4), { channels: ['bing'], source: 'mcp', keyId: 7, bingClient: b.c });
		expect(queued()).toHaveLength(3);
		b.st.daily = 2;
		const d1 = await drainQueue(site(), { bingClient: b.c });
		expect(d1).toMatchObject({ sent: 2, remaining: 1 });
		b.st.daily = 10_000;
		const d2 = await drainQueue(site(), { bingClient: b.c });
		expect(d2).toMatchObject({ sent: 1, remaining: 0 });
		expect(db().prepare("SELECT COUNT(*) n FROM index_submissions WHERE source = 'queue' AND ok = 1").get()).toEqual({ n: 3 });
		expect(watchList(1)).toHaveLength(4);
		expect(db().prepare("SELECT COUNT(*) n FROM index_rechecks WHERE site_id = 1").get()).toEqual({ n: 4 });
		expect(db().prepare("SELECT detail FROM audit_log WHERE action = 'index.queue_drain' ORDER BY id LIMIT 1").get()).toEqual({ detail: '2 sent' });
	});

	it('a whole-channel failure waits 3 hours instead of dropping or hammering; an unusable channel keeps its rows; READ_ONLY sends nothing', async () => {
		const b = bing({ daily: 0 });
		await submitForIndexing(site(), many(2), { channels: ['bing'], source: 'app', bingClient: b.c });
		const now = Date.now();
		b.st.daily = 100;
		b.st.fail = new BingApiError('Bing is down', 500);
		const r = await drainQueue(site(), { bingClient: b.c, now });
		expect(r.sent).toBe(0);
		expect(queued().map((x) => x.url)).toEqual(many(2));
		expect(queued().every((x) => x.r >= now + 3 * 3600_000 - 1000)).toBe(true);
		b.st.fail = undefined;
		expect((await drainQueue(site(), { bingClient: b.c, now: now + 1000 })).sent).toBe(0); // not due yet
		expect((await drainQueue(site(), { bingClient: b.c, now: now + 4 * 3600_000 })).sent).toBe(2);
		db().prepare("INSERT INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source) VALUES (1,?,'indexnow',?,?,?,'app')").run(U('/n'), Date.now(), Date.now(), Date.now());
		await drainQueue(site(), { now: Date.now() + 1000 });
		expect(queued('indexnow')).toHaveLength(1); // no IndexNow key: it stays
		process.env.READ_ONLY = '1';
		db().prepare("UPDATE index_queue SET release_at = 0").run();
		expect((await drainQueue(site(), { bingClient: bing().c })).sent).toBe(0);
		expect(queued('indexnow')).toHaveLength(1);
	});

	it('drops what is still unsent 7 days after it was due, and says so in the log; URLs no longer inside the site are dropped quietly', async () => {
		const now = Date.now();
		const ins = db().prepare("INSERT INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source) VALUES (1,?,'bing',?,?,?, 'app')");
		ins.run(U('/old'), now - 9 * DAY, now + 2 * DAY, now - 8 * DAY); // first due 8 days ago, pushed back by failures since
		ins.run(U('/later-drip-day'), now - 1 * DAY, now + 20 * DAY, now + 20 * DAY); // queued yesterday for day 20: must not expire
		ins.run('https://elsewhere.example/x', now, now, now);
		const r = await drainQueue(site(), { bingClient: bing().c, now });
		expect(r.expired).toBe(1);
		expect(queued().map((x) => x.url)).toEqual([U('/later-drip-day')]);
		expect(db().prepare("SELECT ok, message FROM index_submissions WHERE url = ?").get(U('/old'))).toEqual({ ok: 0, message: 'Dropped from the queue: 7 days after it was due it still had not been sent.' });
	});

	it('clearing the queue removes it (all, or one channel) and is audited', () => {
		const ins = db().prepare("INSERT INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source) VALUES (1,?,?,?,?,?, 'app')");
		ins.run(U('/a'), 'bing', 1, 1, 1); ins.run(U('/b'), 'indexnow', 1, 1, 1);
		expect(clearQueue(1, 'app', 'bing')).toBe(1);
		expect(queueStatus(1).total).toBe(1);
		expect(clearQueue(1, 'mcp')).toBe(1);
		expect(clearQueue(1, 'mcp')).toBe(0);
		expect((db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'index.queue_cleared'").get() as { n: number }).n).toBe(2);
	});
});

describe('drip: spread over days', () => {
	it('sends an even share now and releases the same share each following day', async () => {
		const b = bing();
		const now = Date.now();
		const r = await submitForIndexing(site(), many(10), { channels: ['bing'], source: 'app', dripDays: 5, bingClient: b.c, now });
		expect(r.channels[0]).toMatchObject({ accepted: 2, queued: 8 });
		expect(r.channels[0].notes.join(' ')).toMatch(/Spread over 5 days: 2 now, 8 queued, 2 released a day/);
		const days = queued().map((x) => Math.round((x.r - now) / DAY));
		expect(days).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
		expect((await drainQueue(site(), { bingClient: b.c, now: now + 1000 })).sent).toBe(0); // nothing is due yet
		expect((await drainQueue(site(), { bingClient: b.c, now: now + DAY + 1000 })).sent).toBe(2);
		expect((await drainQueue(site(), { bingClient: b.c, now: now + 2 * DAY + 1000 })).sent).toBe(2);
		expect(queueStatus(1, now + 2 * DAY).total).toBe(4);
		expect((await drainQueue(site(), { bingClient: b.c, now: now + 9 * DAY })).sent).toBe(4);
		expect(b.calls.flat()).toEqual(many(10));
	});

	it('a drip needs the queue, so it holds even if queueing was switched off; one day is just "all now"', async () => {
		const r = await submitForIndexing(site(), many(6), { channels: ['bing'], source: 'app', dripDays: 3, queueOverflow: false, bingClient: bing().c });
		expect(r.channels[0]).toMatchObject({ accepted: 2, queued: 4 });
		clearQueue(1, 'app');
		const all = await submitForIndexing(site(), many(6, '/y'), { channels: ['bing'], source: 'app', dripDays: 1, bingClient: bing().c });
		expect(all.channels[0]).toMatchObject({ accepted: 6, queued: 0 });
	});
});

describe('automatic re-checks at day 1, 3 and 5', () => {
	const submitOne = async (url = U('/page'), now = Date.now()) => {
		await submitForIndexing(site(), [url], { channels: ['bing'], source: 'app', bingClient: bing().c, now });
		return now;
	};
	const row = (url = U('/page')) => db().prepare('SELECT step, due_at d, attempts a FROM index_rechecks WHERE site_id = 1 AND url = ?').get(url) as { step: number; d: number; a: number } | undefined;

	it('every accepted URL gets a first check due in a day; a URL nobody accepted gets none', async () => {
		const t = await submitOne();
		expect(row()).toEqual({ step: 0, d: t + DAY, a: 0 });
		await submitForIndexing(site(), [U('/refused')], { channels: ['bing'], source: 'app', bingClient: bing({ daily: 100, fail: new BingApiError('no', 400) }).c });
		expect(row(U('/refused'))).toBeUndefined();
		expect(submissionWorkDue(1, t)).toBe(false);
		expect(submissionWorkDue(1, t + DAY + 1)).toBe(true);
	});

	it('not due yet: nothing is asked of Google', async () => {
		const t = await submitOne();
		mode.v = 'fail';
		expect(await runDueRechecks(site(), { now: t + 1000 })).toEqual({ checked: 0, indexed: 0, stillNot: 0, postponed: 0 });
	});

	it('indexed at the first check: finished, off the watch list, and the table says indexed', async () => {
		const t = await submitOne();
		expect(watchList(1)).toEqual([U('/page')]);
		mode.v = 'indexed';
		const r = await runDueRechecks(site(), { now: t + DAY + 1000 });
		expect(r).toMatchObject({ checked: 1, indexed: 1 });
		expect(row()).toBeUndefined();
		expect(watchList(1)).toEqual([]);
		const st = submissionStatus(1, 10, t + 2 * DAY)[0];
		expect(st).toMatchObject({ verdict: 'indexed', nextCheckAt: null });
	});

	it('not indexed: it moves through day 3 and day 5, then is reported as still not indexed and comes off the watch list; a pinned URL stays pinned', async () => {
		addWatch(1, [U('/pinned')]);
		const t = await submitOne(U('/pinned'));
		const t2 = await submitOne(U('/page'));
		mode.v = 'not';
		const r1 = await runDueRechecks(site(), { now: t + DAY + 1000 });
		expect(r1).toMatchObject({ checked: 2, indexed: 0, stillNot: 0 });
		expect(row()).toMatchObject({ step: 1, d: t2 + 3 * DAY });
		await runDueRechecks(site(), { now: t + 2 * DAY }); // nothing due between the steps
		expect(row()).toMatchObject({ step: 1 });
		expect(await runDueRechecks(site(), { now: t + 3 * DAY + 1000 })).toMatchObject({ checked: 2, stillNot: 0 });
		expect(row()).toMatchObject({ step: 2, d: t2 + 5 * DAY });
		const last = await runDueRechecks(site(), { now: t + 5 * DAY + 1000 });
		expect(last).toMatchObject({ checked: 2, stillNot: 2 });
		expect(row()).toBeUndefined();
		expect(watchList(1)).toEqual([U('/pinned')]);
		const by = Object.fromEntries(submissionStatus(1, 10, t + 5 * DAY + 5000).map((x) => [x.url, x]));
		expect(by[U('/page')]).toMatchObject({ verdict: 'still_not_indexed', daysSince: 5, google: { state: 'not_indexed', coverage: 'Crawled - currently not indexed', checkedAfterSubmit: true } });
		expect(submissionStatus(1, 10, t + 2 * DAY).every((x) => x.verdict === 'waiting')).toBe(true); // too early to say
	});

	it('if Google cannot be asked, it tries again in 6 hours and gives up on that step only after 4 tries', async () => {
		const t = await submitOne();
		mode.v = 'fail';
		let now = t + DAY + 1000;
		for (let i = 1; i <= 3; i++) {
			expect(await runDueRechecks(site(), { now })).toMatchObject({ checked: 0, postponed: 1 });
			expect(row()).toMatchObject({ step: 0, a: i, d: now + 6 * 3600_000 });
			now += 7 * 3600_000;
		}
		await runDueRechecks(site(), { now });
		expect(row()).toMatchObject({ step: 1, a: 0 }); // moved on, not stuck
	});

	it('the status table counts a check made before the submission as not yet checked', async () => {
		const t = await submitOne(U('/early'), Date.now());
		db().prepare("INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)").run(U('/early'), t - 5000, JSON.stringify({ indexStatusResult: { verdict: 'PASS' } }));
		expect(submissionStatus(1, 5, t + 6 * DAY)[0]).toMatchObject({ verdict: 'waiting', google: { state: 'indexed', checkedAfterSubmit: false } });
	});

	it('runSubmissionWork does both jobs, and the scheduler runs it for sites that have either', async () => {
		const b = bing({ daily: 0 });
		const t = Date.now();
		await submitForIndexing(site(), many(2), { channels: ['bing'], source: 'app', bingClient: b.c, now: t });
		expect(readFileSync('src/lib/server/jobs.ts', 'utf8')).toMatch(/if \(submissionWorkDue\(s\.id\)\) enqueueSubmissionWork\(s\.id\)/);
		expect(enqueueSubmissionWork(1)).toBe(true);
		await drain();
		expect(typeof runSubmissionWork).toBe('function');
	});
});

describe('the limits overview', () => {
	it('reports each channel from stored data: Bing\'s last figure, inspections stored today, the queue', async () => {
		const empty = quotaOverview(site());
		expect(empty.bing).toMatchObject({ linked: true, daily: null, checkedAt: null });
		expect(empty.indexnow).toMatchObject({ ready: false, used24h: 0 });
		expect(empty.googleIndexingApi).toMatchObject({ enabled: false, usedToday: 0, cap: 200 });
		expect(empty.urlInspection.approxDailyLimit).toBe(2000);
		await submitForIndexing(site(), many(2), { channels: ['bing'], source: 'app', dryRun: true, bingClient: bing({ daily: 77 }).c });
		expect(quotaOverview(site()).bing).toMatchObject({ daily: 77, monthly: 300_000 }); // a dry run reads Bing's figure and remembers it
		const r = await refreshBingQuota(site(), bing({ daily: 5 }).c);
		expect(r.daily).toBe(5);
		expect(quotaOverview(site()).bing.daily).toBe(5);
		const before = quotaOverview(site()).urlInspection.storedToday;
		db().prepare("INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,'{}')").run(U('/today'), Date.now());
		db().prepare("INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,'{}')").run(U('/lastweek'), Date.now() - 7 * DAY);
		expect(quotaOverview(site()).urlInspection.storedToday).toBe(before + 1);
		await submitForIndexing(site(), many(3), { channels: ['bing'], source: 'app', bingClient: bing({ daily: 1 }).c });
		expect(quotaOverview(site()).queue).toMatchObject({ total: 2, byChannel: { bing: 2 }, releasableNow: 2 });
	});

	it('refreshing Bing needs Bing to be linked, and a Bing error is explained rather than thrown raw', async () => {
		await expect(refreshBingQuota(site(), { ...bing().c, urlSubmissionQuota: async () => { throw new BingApiError('Bing rejected this API key.', 400); } })).rejects.toThrow(/Could not read Bing's quota: Bing rejected this API key/);
		const saved = db().prepare('SELECT * FROM site_links WHERE site_id = 1 AND kind = ?').get('bing') as Record<string, unknown>;
		db().prepare("DELETE FROM site_links WHERE site_id = 1 AND kind = 'bing'").run();
		await expect(refreshBingQuota(site(), bing().c)).rejects.toBeInstanceOf(SubmitRefused);
		const cols = Object.keys(saved);
		db().prepare(`INSERT INTO site_links (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => saved[c]));
	});
});

describe('CSV of the status table', () => {
	it('has one row per URL with the verdict, and defuses spreadsheet formulas in Google\'s text', async () => {
		const t = Date.now() - 6 * DAY;
		await submitForIndexing(site(), [U('/a'), U('/b')], { channels: ['bing'], source: 'app', bingClient: bing().c, now: t });
		mode.v = 'not';
		mode.coverage = '=HYPERLINK("http://evil.example","x")';
		await runDueRechecks(site(), { now: t + 6 * DAY });
		const lines = submissionsCsv(1, t + 6 * DAY).split('\r\n');
		expect(lines[0]).toBe('url,submitted_at,days_since,verdict,channels,google_state,google_coverage,last_checked,checked_after_submit,next_check');
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain(',6,');
		expect(lines.join('\n')).toContain(`"'=HYPERLINK(""http://evil.example"",""x"")"`);
		expect(lines[1]).toContain('bing:accepted');
		expect(lines[1]).toContain('not_indexed');
	});
});

describe('MCP', () => {
	let readKey = '', submitKey = '';
	const call = async (k: string, name: string, args: object = {}) => {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
	};
	beforeAll(() => {
		readKey = createApiKey('q-read', null).key;
		submitKey = createApiKey('q-submit', null, null, 'submit').key;
	});

	it('drip_days and queue_overflow are validated; the answer says what was queued', async () => {
		for (const bad of [0, 31, 1.5, 'x']) expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a')], drip_days: bad })).data, String(bad)).toMatch(/drip_days.*1 to 30/);
		const r = await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: many(6), channels: ['bing'], drip_days: 3 });
		expect(r.isError).toBe(false);
		expect(r.data.channels[0]).toMatchObject({ accepted: 2, queuedForLater: 4 });
		const st = await call(readKey, 'get_submission_status', { site: '1' });
		expect(st.data.queue).toMatchObject({ waiting: 4, byChannel: { bing: 4 } });
		expect(st.data.submissions[0]).toMatchObject({ verdict: 'waiting', daysSince: 0 });
		expect(st.data.note).toMatch(/day 1, 3, 5/);
		expect(st.data).toHaveProperty('stillNotIndexedAfter5Days', 0);
	});

	it('quotas are readable with a read-only key; refresh_bing asks Bing; cancelling the queue needs the submit permission', async () => {
		const q = await call(readKey, 'get_indexing_quotas', { site: '1' });
		expect(q.isError).toBe(false);
		expect(q.data).toMatchObject({ indexnow: { ready: false }, googleIndexingApi: { enabled: false }, urlInspection: { approxDailyLimit: 2000 }, queue: { waiting: expect.any(Number) } });
		const fresh = await call(readKey, 'get_indexing_quotas', { site: '1', refresh_bing: true });
		expect(fresh.data.bing).toMatchObject({ urlsLeftToday: 10_000, urlsLeftThisMonth: 300_000 }); // the demo Bing
		expect((await call(readKey, 'cancel_indexing_queue', { site: '1' })).data).toMatch(/"submit" permission/);
		expect((await call(submitKey, 'cancel_indexing_queue', { site: '1', channel: 'telegram' })).data).toMatch(/channel.*must be one of/);
		const before = queueStatus(1).total;
		const c = await call(submitKey, 'cancel_indexing_queue', { site: '1' });
		expect(c.data).toMatchObject({ removed: before, remaining: 0 });
	});
});
