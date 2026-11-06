import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { diffSitemaps, explainStatus, groupByHost, isValidKey } from '../src/lib/indexnow';
import { autoSubmit, backoffUntil, createKey, getKey, hostStatuses, indexNowStatus, recentSitemapUrls, setAuto, submitUrls, verifyHost } from '../src/lib/server/indexnow';
import { syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { GET as keyFile } from '../src/routes/sites/[id]/indexnow/key.txt/+server';
import type { GscClient } from '../src/lib/server/google';

describe('IndexNow rules (checked against indexnow.org)', () => {
	it('keys: 8 to 128 of a-z A-Z 0-9 and "-"', () => {
		for (const ok of ['abcdefgh', 'A1-b2-C3-d4', 'a'.repeat(128), '0123456789abcdef0123456789abcdef']) expect(isValidKey(ok), ok).toBe(true);
		for (const bad of ['short77', 'a'.repeat(129), 'under_score_key', 'has space key', 'ключключключ', '']) expect(isValidKey(bad), bad).toBe(false);
	});
	it('every documented HTTP answer is explained in its own terms', () => {
		expect(explainStatus(200)).toMatchObject({ ok: true });
		expect(explainStatus(202)).toMatchObject({ ok: true });
		expect(explainStatus(202).message).toMatch(/validating your key/);
		expect(explainStatus(200).message).toMatch(/not that the pages are indexed/);
		expect(explainStatus(400)).toMatchObject({ ok: false, message: expect.stringMatching(/invalid format/) });
		expect(explainStatus(403).message).toMatch(/key file was not found.*does not contain the key/);
		expect(explainStatus(422).message).toMatch(/do not belong to the host/);
		expect(explainStatus(429).message).toMatch(/at least an hour/);
		expect(explainStatus(0).ok).toBe(false);
		expect(explainStatus(503).message).toMatch(/503/);
	});
	it('groups by host as written, mixing http and https, de-duplicating and dropping junk', () => {
		const { byHost, invalid } = groupByHost(['https://Example.com/a', 'http://example.com/b', 'https://example.com/a', 'https://blog.example.com/c', 'ftp://x.com/d', 'not a url', '  ', 'javascript:alert(1)']);
		expect([...byHost.keys()].sort()).toEqual(['blog.example.com', 'example.com']);
		expect(byHost.get('example.com')).toEqual(['https://example.com/a', 'http://example.com/b']);
		expect(invalid).toEqual(['ftp://x.com/d', 'not a url', 'javascript:alert(1)']);
	});
	it('sitemap changes: new, moved-forward dates, removed; and a build-time stamp on everything is not "everything changed"', () => {
		const before = new Map<string, string | null>([['/a', '2026-01-01'], ['/b', '2026-01-01'], ['/c', null], ['/gone', '2026-01-01'], ['/older', '2026-05-01']]);
		const after = new Map<string, string | null>([['/a', '2026-02-01'], ['/b', '2026-01-01'], ['/c', '2026-02-01'], ['/new', '2026-02-01'], ['/older', '2026-04-01']]);
		expect(diffSitemaps(before, after)).toEqual({ added: ['/new'], updated: ['/a'], removed: ['/gone'], lastmodUnreliable: false }); // /c had no date before; /older went backwards
		const big = (m: string) => new Map<string, string | null>(Array.from({ length: 500 }, (_, i) => [`/p${i}`, m]));
		const stamped = diffSitemaps(big('2026-01-01'), new Map([...big('2026-02-01'), ['/fresh', '2026-02-01']]));
		expect(stamped).toMatchObject({ lastmodUnreliable: true, updated: [], added: ['/fresh'] });
	});
});

describe('submitting', () => {
	const site = () => getSite(1)!;
	const SITE = 'sc-domain:x.example';
	const calls: { url: string; body: any; init: RequestInit }[] = [];
	const answer = (status: number | ((n: number) => number) = 200) => (async (u: URL, init: RequestInit) => { calls.push({ url: String(u), body: JSON.parse(String(init.body)), init }); return new Response('', { status: typeof status === 'function' ? status(calls.length) : status }); }) as never;
	const verify = (host: string) => db().prepare('INSERT OR REPLACE INTO indexnow_hosts VALUES (1,?,?,1,?)').run(host, Date.now(), 'ok');

	beforeEach(async () => {
		calls.length = 0;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		db().prepare('UPDATE sites SET site_url = ? WHERE id = 1').run(SITE);
		db().prepare("INSERT INTO sa_rows VALUES (1,'2026-10-01','q','https://x.example/a','usa','MOBILE',5,50,5)").run();
		db().prepare("INSERT INTO sa_rows VALUES (1,'2026-10-01','q','https://www.x.example/b','usa','MOBILE',5,50,5)").run();
	});
	afterEach(() => { delete process.env.INDEXNOW_MAX_PER_DAY; delete process.env.INDEXNOW_ENDPOINT; });

	it('creates a valid key, keeps the auto setting, and forgets host verifications when the key changes', () => {
		const k1 = createKey(1);
		expect(isValidKey(k1)).toBe(true);
		expect(k1).toHaveLength(32);
		setAuto(1, true);
		verify('x.example');
		const k2 = createKey(1);
		expect(k2).not.toBe(k1);
		expect(getKey(1)).toMatchObject({ key: k2, auto: 1 });
		expect((db().prepare('SELECT COUNT(*) n FROM indexnow_hosts').get() as { n: number }).n).toBe(0);
	});

	it('verifies the key file on the host: found, missing, wrong content, a web page instead, or a foreign host', async () => {
		const key = createKey(1);
		const seen: string[] = [];
		const serve = (body: string | null, status = 200) => (async (u: string) => (seen.push(u), body === null ? new Response('nope', { status: 404 }) : new Response(body, { status, headers: { 'content-type': 'text/plain' } }))) as never;
		expect(await verifyHost(site(), 'x.example', serve('﻿' + key + '\n'))).toMatchObject({ ok: true }); // BOM and a trailing newline are fine
		expect(seen).toEqual([`https://x.example/${key}.txt`]);
		expect(await verifyHost(site(), 'x.example', serve(null))).toMatchObject({ ok: false, message: expect.stringContaining(`Not found at https://x.example/${key}.txt`) });
		expect((await verifyHost(site(), 'x.example', serve('some-other-key'))).message).toMatch(/does not contain the key/);
		expect((await verifyHost(site(), 'x.example', serve('<html><body>Home</body></html>'))).message).toMatch(/looks like a web page/);
		seen.length = 0;
		expect((await verifyHost(site(), 'evil.example', serve(key))).message).toMatch(/not part of this site/);
		expect(seen).toEqual([]); // never even fetched
		expect(hostStatuses(site()).find((h) => h.host === 'x.example')).toMatchObject({ ok: false }); // last answer wins
	});

	it('sends the documented request: POST JSON with host, key and urlList, no redirects, only to the shared endpoint', async () => {
		const key = createKey(1);
		verify('x.example');
		const r = await submitUrls(site(), ['https://x.example/a', 'https://x.example/b'], { fetchImpl: answer(202) });
		expect(r).toMatchObject({ accepted: 2, error: null });
		expect(calls).toHaveLength(1);
		expect(calls[0].url).toBe('https://api.indexnow.org/indexnow');
		expect(calls[0].init.method).toBe('POST');
		expect(calls[0].init.redirect).toBe('error');
		expect((calls[0].init.headers as Record<string, string>)['content-type']).toMatch(/application\/json/);
		expect(calls[0].body).toEqual({ host: 'x.example', key, urlList: ['https://x.example/a', 'https://x.example/b'] });
		expect(r.batches[0]).toMatchObject({ status: 202, ok: true });
	});

	it('sends only verified hosts and only this site\'s URLs', async () => {
		createKey(1);
		verify('x.example');
		const r = await submitUrls(site(), ['https://x.example/a', 'https://www.x.example/b', 'https://evil.example/c', 'http://127.0.0.1/d', 'nonsense'], { fetchImpl: answer() });
		expect(r.accepted).toBe(1);
		expect(calls.map((c) => c.body.host)).toEqual(['x.example']);
		const why = Object.fromEntries(r.skipped.map((s) => [s.reason, s.count]));
		expect(why).toMatchObject({ 'key file not verified on www.x.example': 1, 'not on this site (evil.example)': 1, 'not on this site (127.0.0.1)': 1, 'not a valid web address': 1 });
	});

	it('does not resend a URL within 24 hours unless forced, and enforces the daily cap', async () => {
		createKey(1);
		verify('x.example');
		const u = (n: number) => Array.from({ length: n }, (_, i) => `https://x.example/p${i}`);
		expect((await submitUrls(site(), u(2), { fetchImpl: answer() })).accepted).toBe(2);
		const again = await submitUrls(site(), u(2), { fetchImpl: answer() });
		expect(again.accepted).toBe(0);
		expect(again.skipped).toEqual([{ reason: 'already sent in the last 24 hours', count: 2 }]);
		expect((await submitUrls(site(), u(2), { force: true, fetchImpl: answer() })).accepted).toBe(2);
		expect((await submitUrls(site(), u(2), { fetchImpl: answer(), now: Date.now() + 25 * 3600_000 })).accepted).toBe(2); // a day later
		process.env.INDEXNOW_MAX_PER_DAY = '5';
		db().prepare('DELETE FROM indexnow_log').run();
		db().prepare('DELETE FROM indexnow_urls').run();
		const capped = await submitUrls(site(), u(8), { fetchImpl: answer() });
		expect(capped.accepted).toBe(5);
		expect(capped.skipped).toEqual([{ reason: 'over the daily limit', count: 3 }]);
		expect(indexNowStatus(site()).usedToday).toBe(5);
	});

	it('splits large lists at 10,000 URLs per request', async () => {
		createKey(1);
		verify('x.example');
		process.env.INDEXNOW_MAX_PER_DAY = '20000';
		const r = await submitUrls(site(), Array.from({ length: 10_001 }, (_, i) => `https://x.example/p${i}`), { fetchImpl: answer(), force: true });
		expect(calls.map((c) => c.body.urlList.length)).toEqual([10_000, 1]);
		expect(r.accepted).toBe(10_001);
	}, 30_000);

	it('rejections are explained and stop the run; 429 pauses sending for an hour; a dead endpoint is recorded as no answer', async () => {
		createKey(1);
		verify('x.example');
		const bad = await submitUrls(site(), ['https://x.example/a'], { fetchImpl: answer(403) });
		expect(bad).toMatchObject({ accepted: 0, error: expect.stringMatching(/key is not valid/) });
		expect((await submitUrls(site(), ['https://x.example/b'], { fetchImpl: answer(422) })).error).toMatch(/do not belong to the host/);
		const t0 = Date.now();
		const limited = await submitUrls(site(), ['https://x.example/c'], { fetchImpl: answer(429) });
		expect(limited.error).toMatch(/at least an hour/);
		expect(backoffUntil(1)).toBeGreaterThan(t0 + 3_500_000);
		calls.length = 0;
		const during = await submitUrls(site(), ['https://x.example/d'], { fetchImpl: answer(200) });
		expect(during.error).toMatch(/slow down/);
		expect(calls).toHaveLength(0); // nothing was sent while paused
		expect(indexNowStatus(site()).backoffUntil).not.toBeNull();
		db().prepare('DELETE FROM kv').run();
		const dead = await submitUrls(site(), ['https://x.example/e'], { fetchImpl: (async () => { throw new Error('offline'); }) as never });
		expect(dead.batches[0]).toMatchObject({ status: 0, ok: false });
		const log = db().prepare('SELECT status FROM indexnow_log ORDER BY id').all() as { status: number }[];
		expect(log.map((l) => l.status)).toEqual([403, 422, 429, 0]);
	});

	it('needs a key, and refuses a non-https endpoint', async () => {
		expect((await submitUrls(site(), ['https://x.example/a'], { fetchImpl: answer() })).error).toMatch(/Create a key/);
		createKey(1);
		verify('x.example');
		process.env.INDEXNOW_ENDPOINT = 'http://api.indexnow.org/indexnow';
		expect((await submitUrls(site(), ['https://x.example/a'], { fetchImpl: answer() })).error).toMatch(/https/);
		expect(calls).toHaveLength(0);
	});

	it('the key file downloads with exactly the key as its content and name', async () => {
		const key = createKey(1);
		const res = await keyFile({ params: { id: '1' } } as never);
		expect(await res.text()).toBe(key);
		expect(res.headers.get('content-disposition')).toBe(`attachment; filename="${key}.txt"`);
		expect(res.headers.get('content-type')).toMatch(/text\/plain/);
		let thrown: { status?: number } = {};
		try { keyFile({ params: { id: '2' } } as never); } catch (e) { thrown = e as { status?: number }; } // error() throws synchronously
		expect(thrown.status).toBe(404);
	});

	describe('automatic submission from the sitemap', () => {
		const xml = (urls: [string, string][]) => `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([u, m]) => `<url><loc>${u}</loc><lastmod>${m}</lastmod></url>`).join('')}</urlset>`;
		const gsc = { listSitemaps: async () => [{ path: 'https://x.example/s.xml' }] } as unknown as GscClient;
		const fetchXml = (urls: [string, string][]) => (async () => new Response(xml(urls), { status: 200, headers: { 'content-type': 'application/xml' } })) as never;

		it('the first read records a starting point; later reads report new and changed URLs; nothing is sent unless automatic mode is on and the host is verified', async () => {
			createKey(1);
			verify('x.example');
			const first = await syncSitemapUrls(1, { client: gsc, fetchImpl: fetchXml([['https://x.example/a', '2026-01-01'], ['https://x.example/b', '2026-01-01']]) });
			expect(first.changes).toBeNull();
			const second = await syncSitemapUrls(1, { client: gsc, fetchImpl: fetchXml([['https://x.example/a', '2026-02-01'], ['https://x.example/b', '2026-01-01'], ['https://x.example/new', '2026-02-01']]) });
			expect(second.changes).toMatchObject({ added: ['https://x.example/new'], updated: ['https://x.example/a'], removed: [] });
			expect(await autoSubmit(site(), second.changes, answer())).toBeNull(); // automatic mode is off
			setAuto(1, true);
			expect(await autoSubmit(site(), null, answer())).toBeNull(); // first read: no changes known
			const sent = await autoSubmit(site(), second.changes, answer());
			expect(sent!.accepted).toBe(2);
			expect(calls[0].body.urlList.sort()).toEqual(['https://x.example/a', 'https://x.example/new']);
			expect(db().prepare("SELECT source FROM indexnow_log").get()).toEqual({ source: 'auto' });
		});
		it('presets: sitemap URLs dated in the last week', async () => {
			await syncSitemapUrls(1, { client: gsc, fetchImpl: fetchXml([['https://x.example/old', '2026-01-01'], ['https://x.example/recent', '2026-11-03'], ['https://x.example/today', '2026-11-05']]) });
			expect(recentSitemapUrls(1, '2026-11-05')).toEqual(['https://x.example/today', 'https://x.example/recent']);
		});
	});

	it('status shows Bing against Google, and MCP exposes it read-only and within a key\'s sites', async () => {
		createKey(1);
		db().prepare("UPDATE sites SET synced_through = '2026-10-30' WHERE id = 1").run();
		db().prepare("INSERT INTO sa_rows VALUES (1,'2026-10-20','q','https://x.example/z','usa','MOBILE',95,500,5)").run();
		db().prepare("INSERT INTO site_daily VALUES (1,'2026-10-20',100,1000,5)").run();
		expect(indexNowStatus(site()).clicks28d).toEqual({ google: 100, bing: null, bingShare: null }); // Bing not connected: unknown, not zero
		db().prepare("INSERT INTO integrations (id, kind, label, meta, created_at) VALUES (1,'bing','b','{}',1)").run();
		db().prepare("INSERT INTO site_links (site_id, kind, integration_id, external_id, created_at) VALUES (1,'bing',1,'https://x.example/',1)").run();
		db().prepare("INSERT INTO bing_daily VALUES (1,'2026-10-20',25,300)").run();
		expect(indexNowStatus(site()).clicks28d).toEqual({ google: 100, bing: 25, bingShare: 0.2 });
		const key = createApiKey('only 1', [1]).key;
		const call = async (args: object) => (await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_indexnow_status', arguments: args } }) }))).json()).result;
		const own = JSON.parse((await call({ site: '1' })).content[0].text);
		expect(own).toMatchObject({ keyCreated: true, setUp: false, automaticSubmission: false, clicksLast28Days: { google: 100, bing: 25, bingShare: '20%' } });
		expect(own.note).toMatch(/Google does not take part/);
		expect((await call({ site: '2' })).isError).toBe(true);
	});
});
