import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit as _audit, db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { connectBingKey } from '../src/lib/server/connect';
import { getSite } from '../src/lib/server/clients';
import { createApiKey, authenticate } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';
import { queueDepth } from '../src/lib/server/jobs';
import { BING_MAX_URLS_PER_CALL, BingApiError, RealBingClient, type BingClient } from '../src/lib/server/bing';
import { eligibilityFromHtml, jsonLdTypes, publishUrls } from '../src/lib/server/indexingapi';
import { CHANNELS, SubmitRefused, cleanUrls, deleteSitemapFrom, resubmitSitemaps, submissionStatus, submitForIndexing, submitSitemapTo } from '../src/lib/server/submission';
import { watchList } from '../src/lib/server/indexmon';
import { scopes } from '../src/lib/server/google';
import { listAccounts } from '../src/lib/server/accounts';
import { getVerificationToken, methodsFor, propertyFor, verifyAndAdd } from '../src/lib/server/siteverify';

void _audit;
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

const ld = (o: unknown) => `<html><head><script type="application/ld+json">${JSON.stringify(o)}</script></head><body>x</body></html>`;
const JOB = ld({ '@context': 'https://schema.org', '@type': 'JobPosting', title: 'Dev' });
const PLAIN = '<html><head><title>x</title></head><body>hi</body></html>';

interface Seen { url: string; method: string; body?: string }
/** One fake network: pages by URL, IndexNow, and Google's Indexing API. */
const net = (pages: Record<string, string>, seen: Seen[], o: { indexNow?: number; google?: number } = {}) =>
	(async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		seen.push({ url, method: init?.method ?? 'GET', body: init?.body ? String(init.body) : undefined });
		if (url.includes('/indexnow')) return new Response('', { status: o.indexNow ?? 200 });
		if (url.includes('indexing.googleapis.com')) return new Response(o.google && o.google >= 400 ? JSON.stringify({ error: { message: 'denied', status: 'PERMISSION_DENIED' } }) : '{}', { status: o.google ?? 200 });
		const p = pages[url];
		return p ? new Response(p, { status: 200, headers: { 'content-type': 'text/html' } }) : new Response('nf', { status: 404 });
	}) as typeof fetch;

const fakeBing = (o: { daily?: number | null; fail?: BingApiError } = {}) => {
	const calls: { siteUrl: string; urls: string[] }[] = [];
	const c: BingClient = {
		listSites: async () => [], dailyStats: async () => [], queryStats: async () => [], pageStats: async () => [],
		urlSubmissionQuota: async () => ({ daily: o.daily === undefined ? 10_000 : o.daily, monthly: 300_000 }),
		submitUrlBatch: async (siteUrl, urls) => {
			if (o.fail) throw o.fail;
			calls.push({ siteUrl, urls });
		}
	};
	return { c, calls };
};

const site = () => getSite(1)!;
const U = (p: string) => `https://greenleaf.example${p}`;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await connectBingKey('demo', 'b');
	await drain();
}, 120_000);

beforeEach(() => {
	delete process.env.READ_ONLY;
	delete process.env.GOOGLE_INCLUDE_INDEXING;
	delete process.env.INDEXING_API_MAX_PER_DAY;
	delete process.env.GOOGLE_INCLUDE_SITE_VERIFICATION;
	db().prepare('DELETE FROM index_submissions').run();
	db().prepare('DELETE FROM index_watch').run();
	db().prepare('DELETE FROM indexnow_keys').run();
	db().prepare('DELETE FROM indexnow_hosts').run();
	db().prepare('DELETE FROM indexnow_urls').run();
	db().prepare("DELETE FROM kv WHERE key LIKE 'indexingapi:%' OR key LIKE 'submit:%' OR key LIKE 'indexnow_backoff:%'").run();
});
afterEach(() => {
	delete process.env.READ_ONLY;
	delete process.env.GOOGLE_INCLUDE_INDEXING;
	delete process.env.INDEXING_API_MAX_PER_DAY;
});

describe('cleanUrls', () => {
	it('keeps one spelling per page, only http(s) inside the property, and says why the rest was dropped', () => {
		const r = cleanUrls([U('/a#top'), U('/a'), ' ' + U('/b') + ' ', 'https://other.example/x', 'ftp://greenleaf.example/f', 'not a url', '', 'https://www.greenleaf.example/c'], site());
		expect(r.urls).toEqual([U('/a'), U('/b'), 'https://www.greenleaf.example/c']);
		expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringMatching(/outside this site/), expect.stringMatching(/full http/), expect.stringMatching(/full http/)]);
	});
});

describe('Indexing API eligibility', () => {
	it('only JobPosting and BroadcastEvent count, wherever they sit in the JSON-LD', () => {
		expect(eligibilityFromHtml(JOB).eligible).toBe(true);
		expect(eligibilityFromHtml(ld({ '@graph': [{ '@type': 'WebSite' }, { '@type': ['Thing', 'JobPosting'] }] })).eligible).toBe(true);
		expect(eligibilityFromHtml(ld({ '@type': 'VideoObject', publication: { '@type': 'BroadcastEvent', isLiveBroadcast: true } })).eligible).toBe(true);
		expect(eligibilityFromHtml(ld({ '@type': 'https://schema.org/JobPosting' })).eligible).toBe(true);
		for (const html of [PLAIN, ld({ '@type': 'Product' }), ld({ '@type': 'Article' }), '<script type="application/ld+json">{broken</script>']) {
			const e = eligibilityFromHtml(html);
			expect(e.eligible).toBe(false);
			expect(e.reason).toMatch(/JobPosting or BroadcastEvent/);
		}
		expect([...jsonLdTypes(JOB)]).toEqual(['jobposting']);
	});
});

describe('Bing URL submission client', () => {
	const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
	const makeClient = async (f: (u: string, init?: RequestInit) => Promise<Response>) => {
		await connectBingKey('demo', 'b'); // demo integration row exists; use its id with a real client over a fake network
		const id = (db().prepare('SELECT id FROM integrations ORDER BY id LIMIT 1').get() as { id: number }).id;
		db().prepare("UPDATE integrations SET secret_enc = ? WHERE id = ?").run(null, id);
		return new RealBingClient(id, { fetchImpl: f as never, sleepImpl: async () => {} });
	};
	it('posts siteUrl and urlList to SubmitUrlBatch, and reads the quota', async () => {
		const { encrypt } = await import('../src/lib/server/crypto');
		const seen: { url: string; init?: RequestInit }[] = [];
		const c = await makeClient(async (u, init) => (seen.push({ url: u, init }), json({ d: u.includes('GetUrlSubmissionQuota') ? { DailyQuota: 7, MonthlyQuota: 70 } : null })));
		const id = (db().prepare('SELECT id FROM integrations ORDER BY id LIMIT 1').get() as { id: number }).id;
		db().prepare('UPDATE integrations SET secret_enc = ? WHERE id = ?').run(encrypt(JSON.stringify({ apiKey: 'K' })), id);
		await c.submitUrlBatch('https://x.example/', ['https://x.example/a', 'https://x.example/b']);
		expect(seen[0].url).toContain('/SubmitUrlBatch?');
		expect(seen[0].init?.method).toBe('POST');
		expect(JSON.parse(String(seen[0].init?.body))).toEqual({ siteUrl: 'https://x.example/', urlList: ['https://x.example/a', 'https://x.example/b'] });
		expect(await c.urlSubmissionQuota('https://x.example/')).toEqual({ daily: 7, monthly: 70 });
		expect(seen[1].init?.method).toBeUndefined(); // the quota call is a GET
		await expect(c.submitUrlBatch('https://x.example/', Array.from({ length: BING_MAX_URLS_PER_CALL + 1 }, (_, i) => `https://x.example/${i}`))).rejects.toThrow(/At most 500/);
	});
	it('an answer without a quota is "unknown", never zero', async () => {
		const { encrypt } = await import('../src/lib/server/crypto');
		const c = await makeClient(async () => json({ d: null }));
		const id = (db().prepare('SELECT id FROM integrations ORDER BY id LIMIT 1').get() as { id: number }).id;
		db().prepare('UPDATE integrations SET secret_enc = ? WHERE id = ?').run(encrypt(JSON.stringify({ apiKey: 'K' })), id);
		expect(await c.urlSubmissionQuota('https://x.example/')).toEqual({ daily: null, monthly: null });
	});
});

describe('submitForIndexing', () => {
	it('a dry run shows each channel\'s plan, sends nothing and logs nothing', async () => {
		const bing = fakeBing();
		const seen: Seen[] = [];
		const r = await submitForIndexing(site(), [U('/a'), U('/b')], { dryRun: true, source: 'app', bingClient: bing.c, fetchImpl: net({}, seen) });
		expect(r.dryRun).toBe(true);
		expect(r.channels.map((c) => c.channel)).toEqual(CHANNELS);
		const by = Object.fromEntries(r.channels.map((c) => [c.channel, c]));
		expect(by.indexnow).toMatchObject({ available: false, reason: expect.stringMatching(/No IndexNow key/) });
		expect(by.bing).toMatchObject({ available: true, attempted: 2, accepted: 0 });
		expect(by.google_indexing_api).toMatchObject({ available: false, reason: expect.stringMatching(/job-posting and livestream pages only/) });
		expect(bing.calls).toEqual([]);
		expect(seen).toEqual([]);
		expect(db().prepare('SELECT COUNT(*) n FROM index_submissions').get()).toEqual({ n: 0 });
		expect(watchList(1)).toEqual([]);
	});

	it('Bing: sends, logs per URL, adds the URLs to the watch list, and writes the audit log', async () => {
		const bing = fakeBing();
		const r = await submitForIndexing(site(), [U('/a'), U('/b')], { channels: ['bing'], source: 'app', bingClient: bing.c });
		expect(r.channels).toHaveLength(1);
		expect(r.channels[0]).toMatchObject({ channel: 'bing', accepted: 2, attempted: 2, error: null });
		expect(bing.calls).toHaveLength(1);
		expect(bing.calls[0].urls).toEqual([U('/a'), U('/b')]);
		expect(db().prepare('SELECT channel, ok, source FROM index_submissions ORDER BY id').all()).toEqual([{ channel: 'bing', ok: 1, source: 'app' }, { channel: 'bing', ok: 1, source: 'app' }]);
		expect(watchList(1).sort()).toEqual([U('/a'), U('/b')]);
		expect(r.watching).toBe(2);
		expect((db().prepare("SELECT detail FROM audit_log WHERE action = 'index.submit'").get() as { detail: string }).detail).toMatch(/bing:2 \(app\)/);
	});

	it('Bing: stays within the quota Bing reports, and a refusal is logged as failed and not added to the watch list', async () => {
		const small = fakeBing({ daily: 1 });
		const r = await submitForIndexing(site(), [U('/a'), U('/b'), U('/c')], { channels: ['bing'], source: 'app', bingClient: small.c });
		expect(r.channels[0]).toMatchObject({ attempted: 1, accepted: 1, skipped: [{ reason: expect.stringMatching(/daily allowance/), count: 2 }] });
		expect(small.calls[0].urls).toEqual([U('/a')]);
		const bad = fakeBing({ fail: new BingApiError('Bing rejected this API key.', 400) });
		const r2 = await submitForIndexing(site(), [U('/z')], { channels: ['bing'], source: 'app', bingClient: bad.c });
		expect(r2.channels[0]).toMatchObject({ accepted: 0, error: 'Bing rejected this API key.' });
		expect(db().prepare("SELECT ok, message FROM index_submissions WHERE url = ?").get(U('/z'))).toEqual({ ok: 0, message: 'Bing rejected this API key.' });
		expect(watchList(1)).not.toContain(U('/z'));
	});

	it('IndexNow: needs a key and a verified host, then sends once and respects the 24-hour cooldown', async () => {
		const f1: Seen[] = [];
		const none = await submitForIndexing(site(), [U('/a')], { channels: ['indexnow'], source: 'app', fetchImpl: net({}, f1) });
		expect(none.channels[0]).toMatchObject({ available: false });
		db().prepare("INSERT INTO indexnow_keys (site_id, key, created_at, auto) VALUES (1, 'abcdef0123456789abcdef0123456789', ?, 0)").run(Date.now());
		const unverified = await submitForIndexing(site(), [U('/a')], { channels: ['indexnow'], source: 'app', fetchImpl: net({}, f1) });
		expect(unverified.channels[0]).toMatchObject({ available: false, reason: expect.stringMatching(/not verified/) });
		db().prepare("INSERT OR REPLACE INTO indexnow_hosts VALUES (1,'greenleaf.example',?,1,'ok')").run(Date.now());
		const seen: Seen[] = [];
		const r = await submitForIndexing(site(), [U('/a'), U('/b')], { channels: ['indexnow'], source: 'app', fetchImpl: net({}, seen) });
		expect(r.channels[0]).toMatchObject({ available: true, accepted: 2 });
		expect(seen.filter((s) => s.url.includes('/indexnow'))).toHaveLength(1);
		const again = await submitForIndexing(site(), [U('/a'), U('/b'), U('/c')], { channels: ['indexnow'], source: 'app', fetchImpl: net({}, seen) });
		expect(again.channels[0].accepted).toBe(1); // /a and /b were sent less than 24 hours ago
		const rows = db().prepare("SELECT url, ok FROM index_submissions WHERE channel = 'indexnow' ORDER BY id").all() as { url: string; ok: number }[];
		expect(rows.filter((x) => x.url === U('/a'))).toEqual([{ url: U('/a'), ok: 1 }, { url: U('/a'), ok: 0 }]); // the second, skipped, attempt is recorded as not sent
	});

	it('Google Indexing API: off unless enabled; when on, only job and livestream pages are sent and every other page is refused with the reason', async () => {
		const off = await submitForIndexing(site(), [U('/jobs/1')], { channels: ['google_indexing_api'], source: 'app', fetchImpl: net({ [U('/jobs/1')]: JOB }, []) });
		expect(off.channels[0]).toMatchObject({ available: false, reason: expect.stringMatching(/GOOGLE_INCLUDE_INDEXING=1/) });
		process.env.GOOGLE_INCLUDE_INDEXING = '1';
		const seen: Seen[] = [];
		const pages = { [U('/jobs/1')]: JOB, [U('/blog/post')]: PLAIN };
		const r = await submitForIndexing(site(), [U('/jobs/1'), U('/blog/post'), U('/missing')], { channels: ['google_indexing_api'], source: 'app', fetchImpl: net(pages, seen) });
		const c = r.channels[0];
		expect(c).toMatchObject({ available: true, attempted: 1, accepted: 1 }); // demo account: counted, not really sent
		expect(c.skipped[0]).toMatchObject({ count: 2, reason: expect.stringMatching(/job-posting or livestream/) });
		expect(seen.some((s) => s.url.includes('indexing.googleapis.com'))).toBe(false); // demo never calls Google
		const rows = db().prepare("SELECT url, ok, message FROM index_submissions WHERE channel = 'google_indexing_api' ORDER BY url").all() as { url: string; ok: number; message: string }[];
		expect(rows.find((x) => x.url === U('/blog/post'))).toMatchObject({ ok: 0, message: expect.stringMatching(/No JobPosting or BroadcastEvent/) });
		expect(rows.find((x) => x.url === U('/missing'))!.message).toMatch(/Could not fetch the page/);
		expect(rows.find((x) => x.url === U('/jobs/1'))!.ok).toBe(1);
		expect(watchList(1)).toEqual([U('/jobs/1')]); // only what a channel accepted
	});

	it('Google Indexing API: the real call is a URL_UPDATED notification; a 403 stops the batch and says what to do; the daily cap holds', async () => {
		const id = upsertGoogleAccount({ sub: 'real', email: 'r@x.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'x' });
		const real = { ...site(), account_id: id };
		const seen: Seen[] = [];
		const ok = await publishUrls(real, [U('/jobs/1'), U('/jobs/2')], { fetchImpl: net({}, seen) });
		expect(ok.every((x) => x.ok)).toBe(true);
		const calls = seen.filter((s) => s.url.includes('indexing.googleapis.com'));
		expect(calls).toHaveLength(2);
		expect(JSON.parse(calls[0].body!)).toEqual({ url: U('/jobs/1'), type: 'URL_UPDATED' });
		const denied = await publishUrls(real, [U('/jobs/3'), U('/jobs/4'), U('/jobs/5')], { fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'no', status: 'PERMISSION_DENIED' } }), { status: 403 })) as typeof fetch });
		expect(denied[0]).toMatchObject({ ok: false, message: expect.stringMatching(/verified owner.*GOOGLE_INCLUDE_INDEXING=1/) });
		expect(denied).toHaveLength(3);
		expect(denied.slice(1).every((x) => !x.ok && /^Not sent/.test(x.message))).toBe(true);
		process.env.INDEXING_API_MAX_PER_DAY = '2';
		const capped = await publishUrls(real, [U('/jobs/9')], { fetchImpl: net({}, []) }); // two were already sent today
		expect(capped[0]).toMatchObject({ ok: false, message: expect.stringMatching(/Daily limit of 2/) });
	});

	it('READ_ONLY=1 refuses real submissions and sitemap changes, but a dry run still works', async () => {
		process.env.READ_ONLY = '1';
		await expect(submitForIndexing(site(), [U('/a')], { channels: ['bing'], source: 'app', bingClient: fakeBing().c })).rejects.toThrow(/READ_ONLY=1/);
		await expect(submitSitemapTo(site(), U('/sitemap.xml'), 'app')).rejects.toBeInstanceOf(SubmitRefused);
		await expect(deleteSitemapFrom(site(), U('/sitemap.xml'), 'app')).rejects.toBeInstanceOf(SubmitRefused);
		await expect(resubmitSitemaps(site(), 'app')).rejects.toBeInstanceOf(SubmitRefused);
		const dry = await submitForIndexing(site(), [U('/a')], { channels: ['bing'], dryRun: true, source: 'app', bingClient: fakeBing().c });
		expect(dry.dryRun).toBe(true);
		expect(scopes()).not.toContain('auth/indexing');
		process.env.GOOGLE_INCLUDE_INDEXING = '1';
		expect(scopes()).not.toContain('auth/indexing'); // never asked for in read-only mode
	});

	it('refuses an empty list, a list over the limit, and URLs from another site', async () => {
		await expect(submitForIndexing(site(), [], { source: 'app' })).rejects.toThrow(/at least one full URL/);
		await expect(submitForIndexing(site(), ['https://other.example/x'], { source: 'app' })).rejects.toThrow(/None of the URLs can be submitted: outside this site/);
		await expect(submitForIndexing(site(), Array.from({ length: 101 }, (_, i) => U('/p' + i)), { source: 'app' })).rejects.toThrow(/At most 100/);
	});

	it('the Indexing API scope is asked for only when the owner opts in', () => {
		expect(scopes()).not.toContain('auth/indexing');
		process.env.GOOGLE_INCLUDE_INDEXING = '1';
		expect(scopes()).toContain('https://www.googleapis.com/auth/indexing');
	});
});

describe('sitemaps from the tool', () => {
	it('submit, resubmit-all and delete go through Search Console, stay inside the property, and are audited', async () => {
		expect(await submitSitemapTo(site(), U('/new-sitemap.xml'), 'mcp')).toBe(U('/new-sitemap.xml'));
		await expect(submitSitemapTo(site(), 'https://other.example/sitemap.xml', 'mcp')).rejects.toThrow(/outside the property/);
		await expect(submitSitemapTo(site(), 'nonsense', 'mcp')).rejects.toThrow(/full sitemap address/);
		const re = await resubmitSitemaps(site(), 'mcp');
		expect(re.submitted).toContain(U('/new-sitemap.xml'));
		expect(re.failed).toEqual([]);
		expect(await deleteSitemapFrom(site(), U('/new-sitemap.xml'), 'mcp')).toBe(U('/new-sitemap.xml'));
		const actions = (db().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'sitemap.%' ORDER BY id").all() as { action: string; detail: string }[]).map((a) => a.action);
		expect(actions).toEqual(expect.arrayContaining(['sitemap.submitted', 'sitemap.resubmitted', 'sitemap.deleted']));
	});
});

describe('what happened to submitted URLs', () => {
	it('joins the latest submission with the stored Google inspection and says whether it was checked after sending', () => {
		const now = Date.now();
		const ins = db().prepare('INSERT INTO index_submissions (site_id, url, channel, at, ok, message, source) VALUES (1,?,?,?,?,?,?)');
		ins.run(U('/a'), 'bing', now - 5000, 1, 'Bing received it.', 'app');
		ins.run(U('/b'), 'bing', now - 4000, 1, 'Bing received it.', 'app');
		ins.run(U('/c'), 'bing', now - 3000, 1, 'Bing received it.', 'mcp');
		const put = db().prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)');
		put.run(U('/a'), now - 1000, JSON.stringify({ indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed' } })); // after the submission
		put.run(U('/b'), now - 9000, JSON.stringify({ indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed' } })); // before it
		const rows = submissionStatus(1, 10);
		const by = Object.fromEntries(rows.map((r) => [r.url, r]));
		expect(rows[0].url).toBe(U('/c')); // newest first
		expect(by[U('/a')].google).toMatchObject({ state: 'indexed', coverage: 'Submitted and indexed', checkedAfterSubmit: true });
		expect(by[U('/b')].google).toMatchObject({ state: 'not_indexed', checkedAfterSubmit: false });
		expect(by[U('/c')].google).toBeNull();
		expect(by[U('/a')].channels).toEqual([{ channel: 'bing', ok: true, message: 'Bing received it.' }]);
	});
});

describe('MCP: submit permission', () => {
	let readKey = '';
	let submitKey = '';
	let scopedSubmit = '';
	let deleteKey = '';
	const call = async (k: string, name: string, args: object = {}) => {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		const text = r.content[0].text as string;
		return { isError: !!r.isError, data: r.isError ? text : JSON.parse(text) };
	};
	beforeAll(() => {
		readKey = createApiKey('read', null).key;
		submitKey = createApiKey('submit', null, null, 'submit').key;
		scopedSubmit = createApiKey('submit one site', [2], null, 'submit').key;
		deleteKey = createApiKey('submit and delete', null, null, 'delete').key;
	});

	it('a key is read-only unless it was created with the submit permission, and the permission is stored on the key', () => {
		const req = (k: string) => new Request('http://x', { headers: { authorization: `Bearer ${k}` } });
		expect(authenticate(req(readKey))?.permission).toBe('read');
		expect(authenticate(req(submitKey))?.permission).toBe('submit');
		expect(createApiKey('anything', null, null, 'bogus' as never).key).toMatch(/^osc_/);
		expect(db().prepare("SELECT permission FROM api_keys WHERE name = 'anything'").get()).toEqual({ permission: 'read' });
	});

	it('tools/list marks exactly the submitting tools as not read-only, and destructive ones as destructive', async () => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${readKey}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
		const tools = (await res.json()).result.tools as { name: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean } }[];
		const writers = tools.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name).sort();
		expect(writers).toEqual(['build_request_indexing_queue', 'cancel_indexing_queue', 'delete_sitemap', 'get_site_verification_token', 'inspect_and_submit_urls', 'mark_indexing_requested', 'run_indexing_check', 'setup_indexnow', 'submit_sitemap', 'submit_urls_for_indexing', 'verify_site_ownership']);
		expect(tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name).sort()).toEqual(['cancel_indexing_queue', 'delete_sitemap']);
		for (const n of ['suggest_indexing_candidates', 'get_submission_status', 'check_sitemap']) expect(tools.find((t) => t.name === n)!.annotations.readOnlyHint).toBe(true);
	});

	it('a read-only key is refused by every submitting tool, with a message that says how to fix it, and nothing is sent', async () => {
		for (const [name, args] of [['submit_urls_for_indexing', { site: '1', urls: [U('/a')] }], ['submit_sitemap', { site: '1', sitemap_url: U('/s.xml') }], ['run_indexing_check', { site: '1' }], ['setup_indexnow', { site: '1', action: 'create_key' }]] as const) {
			const r = await call(readKey, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.data, name).toMatch(/needs an API key created with the "submit" permission/);
		}
		expect(db().prepare('SELECT COUNT(*) n FROM index_submissions').get()).toEqual({ n: 0 });
		expect(db().prepare('SELECT COUNT(*) n FROM indexnow_keys').get()).toEqual({ n: 0 });
	});

	it('a submit key can dry-run and submit, within its sites, and the plan and answers come back per channel', async () => {
		const dry = await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a'), 'https://elsewhere.example/x'], dry_run: true });
		expect(dry.isError).toBe(false);
		expect(dry.data).toMatchObject({ dryRun: true, urls: 1, rejected: [{ reason: expect.stringMatching(/outside this site/) }] });
		expect(dry.data.channels.map((c: { channel: string }) => c.channel)).toEqual(CHANNELS);
		expect(db().prepare('SELECT COUNT(*) n FROM index_submissions').get()).toEqual({ n: 0 });
		const real = await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a'), U('/b')], channels: ['bing'] });
		expect(real.isError).toBe(false);
		expect(real.data.channels[0]).toMatchObject({ channel: 'bing', usable: true, accepted: 2 });
		expect(real.data.addedToWatchList).toBe(2);
		expect(db().prepare("SELECT source FROM index_submissions LIMIT 1").get()).toEqual({ source: 'mcp' });
		expect((await call(scopedSubmit, 'submit_urls_for_indexing', { site: '1', urls: [U('/a')] })).isError).toBe(true); // site 1 is outside this key's sites
		const st = await call(submitKey, 'get_submission_status', { site: '1' });
		expect(st.data.count).toBe(2);
		expect(st.data.waitingForACheck).toBe(2);
		expect(st.data.submissions[0].channels[0]).toMatchObject({ channel: 'bing', accepted: true });
	});

	it('validates the arguments and enforces the per-key daily budget', async () => {
		expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1' })).data).toMatch(/`urls` is required/);
		expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a')], channels: ['google'] })).data).toMatch(/channels/);
		expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: Array.from({ length: 101 }, (_, i) => U('/p' + i)) })).data).toMatch(/At most 100/);
		process.env.MCP_SUBMIT_PER_KEY_DAY = '3';
		try {
			await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/x1'), U('/x2')], channels: ['bing'] });
			const over = await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/x3'), U('/x4')], channels: ['bing'] });
			expect(over.isError).toBe(true);
			expect(over.data).toMatch(/may submit 3 URLs a day/);
			expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/x3'), U('/x4')], channels: ['bing'], dry_run: true })).isError).toBe(false); // a dry run costs nothing
		} finally {
			delete process.env.MCP_SUBMIT_PER_KEY_DAY;
		}
	});

	it('sitemaps: submit, resubmit all and check with a submit key; removing one needs the delete permission and a second, confirming call', async () => {
		const feed = U('/mcp-sitemap.xml');
		expect((await call(submitKey, 'submit_sitemap', { site: '1', sitemap_url: feed })).data.submitted).toEqual([feed]);
		expect((await call(submitKey, 'submit_sitemap', { site: '1', sitemap_url: 'https://other.example/s.xml' })).data).toMatch(/outside the property/);
		expect((await call(submitKey, 'submit_sitemap', { site: '1' })).data.submitted).toContain(feed);
		const refused = await call(submitKey, 'delete_sitemap', { site: '1', sitemap_url: feed });
		expect(refused.isError).toBe(true);
		expect(refused.data).toMatch(/"delete" permission/);
		const first = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed });
		expect(first.data).toMatchObject({ needsConfirmation: true, willRemove: feed, confirmationToken: expect.stringMatching(/^cf_/) });
		const listed = async () => ((await call(readKey, 'get_sitemaps', { site: '1' })).data.sitemaps as { path: string }[]).map((x) => x.path);
		expect(await listed()).toContain(feed); // the first call removed nothing
		expect((await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed, confirmation_token: first.data.confirmationToken })).data.removed).toBe(feed);
		expect(await listed()).not.toContain(feed);
		expect((await call(readKey, 'check_sitemap', { site: '1', sitemap_url: 'nonsense' })).data).toMatch(/full http/); // the read-only checker is open to read keys
	});

	it('IndexNow setup from MCP returns the exact key file to upload, never replaces an existing key, and rejects other actions', async () => {
		const made = await call(submitKey, 'setup_indexnow', { site: '1', action: 'create_key' });
		expect(made.data.created).toBe(true);
		expect(made.data.keyFile.name).toBe(made.data.keyFile.content + '.txt');
		expect(made.data.keyFile.content).toMatch(/^[0-9a-f]{32}$/);
		const again = await call(submitKey, 'setup_indexnow', { site: '1', action: 'create_key' });
		expect(again.data).toMatchObject({ created: false, keyFile: made.data.keyFile });
		expect((await call(submitKey, 'setup_indexnow', { site: '1', action: 'auto_on' })).data).toEqual({ automaticSubmission: true });
		expect((await call(submitKey, 'setup_indexnow', { site: '1', action: 'explode' })).data).toMatch(/must be create_key/);
	});

	it('READ_ONLY=1 stops a submit key from submitting or starting checks', async () => {
		process.env.READ_ONLY = '1';
		const r = await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a')], channels: ['bing'] });
		expect(r.isError).toBe(true);
		expect(r.data).toMatch(/READ_ONLY=1/);
		expect((await call(submitKey, 'run_indexing_check', { site: '1' })).data).toMatch(/READ_ONLY=1/);
		expect((await call(submitKey, 'submit_urls_for_indexing', { site: '1', urls: [U('/a')], dry_run: true })).isError).toBe(false);
	});

	it('suggest_indexing_candidates validates its preset and answers from stored data', async () => {
		expect((await call(readKey, 'suggest_indexing_candidates', { site: '1', preset: 'nope' })).data).toMatch(/preset/);
		const r = await call(readKey, 'suggest_indexing_candidates', { site: '1', preset: 'new' });
		expect(r.isError).toBe(false);
		expect(r.data).toMatchObject({ preset: 'new', count: expect.any(Number), urls: expect.any(Array) });
	});
});


describe('proving ownership from the tool', () => {
	const demoAcct = () => listAccounts().find((a) => a.is_demo)!;
	it('tells a domain from a URL-prefix site, and refuses anything else', () => {
		expect(propertyFor('Example.COM')).toEqual({ type: 'INET_DOMAIN', identifier: 'example.com', gscUrl: 'sc-domain:example.com' });
		expect(propertyFor('sc-domain:x.example')).toEqual({ type: 'INET_DOMAIN', identifier: 'x.example', gscUrl: 'sc-domain:x.example' });
		expect(propertyFor('https://example.com/blog')).toEqual({ type: 'SITE', identifier: 'https://example.com/blog/', gscUrl: 'https://example.com/blog/' });
		for (const bad of ['javascript:alert(1)', 'localhost', 'ftp://example.com/', 'https://user:pw@example.com/', '', 'not a site']) expect(propertyFor(bad), bad).toBeNull();
		expect(methodsFor(propertyFor('example.com')!)).toEqual(['DNS_TXT', 'DNS_CNAME']);
		expect(methodsFor(propertyFor('https://example.com/')!)).toEqual(['META', 'FILE']);
	});

	it('asks Google for the token with the right site and method, and explains a refusal', async () => {
		const id = upsertGoogleAccount({ sub: 'v', email: 'v@x.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'x' });
		const seen: Seen[] = [];
		const f = (async (u: RequestInfo | URL, init?: RequestInit) => (seen.push({ url: String(u), method: init?.method ?? 'GET', body: String(init?.body) }), new Response(JSON.stringify({ token: 'google-site-verification=abc' }), { status: 200 }))) as typeof fetch;
		const r = await getVerificationToken(id, 'example.com', 'DNS_TXT', { fetchImpl: f });
		expect(r).toMatchObject({ method: 'DNS_TXT', token: 'google-site-verification=abc', property: { type: 'INET_DOMAIN' } });
		expect(r.help).toMatch(/TXT record.*google-site-verification=abc/);
		expect(seen[0].url).toBe('https://www.googleapis.com/siteVerification/v1/token');
		expect(JSON.parse(seen[0].body!)).toEqual({ site: { type: 'INET_DOMAIN', identifier: 'example.com' }, verificationMethod: 'DNS_TXT' });
		await expect(getVerificationToken(id, 'example.com', 'META', { fetchImpl: f })).rejects.toThrow(/DNS_TXT or DNS_CNAME, not META/);
		await expect(getVerificationToken(id, 'nonsense', 'META', { fetchImpl: f })).rejects.toThrow(/Use a domain/);
		const denied = (async () => new Response(JSON.stringify({ error: { message: 'no' } }), { status: 403 })) as typeof fetch;
		await expect(getVerificationToken(id, 'https://example.com/', 'META', { fetchImpl: denied })).rejects.toThrow(/GOOGLE_INCLUDE_SITE_VERIFICATION=1/);
	});

	it('verifying: Google must find the token (its refusal is passed on); READ_ONLY blocks it; the demo account verifies and adds without Google', async () => {
		const id = upsertGoogleAccount({ sub: 'v2', email: 'v2@x.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'x' });
		const acct = { id, google_sub: 'v2', is_demo: 0 };
		const notThere = (async () => new Response(JSON.stringify({ error: { message: 'The necessary verification token could not be found on your site.' } }), { status: 400 })) as typeof fetch;
		await expect(verifyAndAdd(acct as never, 'https://example.com/', 'META', { fetchImpl: notThere })).rejects.toThrow(/Google could not verify https:\/\/example.com\/: The necessary verification token could not be found/);
		expect(db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'site.verified'").get()).toEqual({ n: 0 }); // nothing is recorded as verified
		process.env.READ_ONLY = '1';
		await expect(verifyAndAdd(acct as never, 'https://example.com/', 'META')).rejects.toThrow(/READ_ONLY=1/);
		delete process.env.READ_ONLY;
		const d = demoAcct();
		const r = await verifyAndAdd({ id: d.id, google_sub: d.google_sub, is_demo: 1 } as never, 'newsite.example', 'DNS_TXT');
		expect(r).toMatchObject({ verified: true, added: true, property: { gscUrl: 'sc-domain:newsite.example' } });
		expect(db().prepare("SELECT action, detail FROM audit_log WHERE action = 'site.verified'").get()).toEqual({ action: 'site.verified', detail: 'sc-domain:newsite.example via DNS_TXT' });
	});

	it('the extra Google permission is requested only when the owner opts in, and never in READ_ONLY mode', () => {
		expect(scopes()).not.toContain('siteverification');
		process.env.GOOGLE_INCLUDE_SITE_VERIFICATION = '1';
		expect(scopes()).toContain('https://www.googleapis.com/auth/siteverification.verify_only');
		process.env.READ_ONLY = '1';
		expect(scopes()).not.toContain('siteverification');
	});

	describe('over MCP', () => {
		let readKey = '', allKey = '', scopedKey = '';
		const call = async (k: string, name: string, args: object = {}) => {
			resetRateLimits();
			const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
			const r = (await res.json()).result;
			return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
		};
		beforeAll(() => {
			readKey = createApiKey('v-read', null).key;
			allKey = createApiKey('v-all', null, null, 'submit').key;
			scopedKey = createApiKey('v-scoped', [1], null, 'submit').key;
		});
		it('needs the submit permission and a key for all sites, resolves the account by id or email, and lists the choices when it cannot', async () => {
			const d = demoAcct();
			const args = { account: String(d.id), site: 'newsite2.example', method: 'DNS_TXT' };
			expect((await call(readKey, 'get_site_verification_token', args)).data).toMatch(/"submit" permission/);
			expect((await call(scopedKey, 'get_site_verification_token', args)).data).toMatch(/limited to some sites/);
			const bad = await call(allKey, 'get_site_verification_token', { ...args, account: 'nobody@x.c' });
			expect(bad.data).toMatch(/must be a Google account's id or email. Connected:/);
			const tok = await call(allKey, 'get_site_verification_token', { ...args, account: d.email.toUpperCase() });
			expect(tok.isError).toBe(false);
			expect(tok.data).toMatchObject({ property: 'sc-domain:newsite2.example', method: 'DNS_TXT', token: expect.any(String), instructions: expect.stringMatching(/TXT record/) });
			expect((await call(allKey, 'get_site_verification_token', { ...args, method: 'carrier-pigeon' })).data).toMatch(/must be one of META, FILE, DNS_TXT, DNS_CNAME/);
			const ok = await call(allKey, 'verify_site_ownership', args);
			expect(ok.data).toMatchObject({ verified: true, addedToSearchConsole: true, property: 'sc-domain:newsite2.example' });
			process.env.READ_ONLY = '1';
			expect((await call(allKey, 'verify_site_ownership', args)).data).toMatch(/READ_ONLY=1/);
		});
	});
});
