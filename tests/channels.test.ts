import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { db, openDb } from '../src/lib/server/db';
import { BingApiError, parseBingDate, RealBingClient } from '../src/lib/server/bing';
import { callsLeft, ClarityApiError, fetchInsights } from '../src/lib/server/clarity';
import { bestMatch, hostKey, hostsMatch } from '../src/lib/server/hosts';
import { saveIntegration, linksFor, getIntegration } from '../src/lib/server/links';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4, connectBingKey, connectClarity, connectOpenSeo } from '../src/lib/server/connect';
import { syncBing, syncClarity, syncGa4 } from '../src/lib/server/channels';
import { dailyByChannel, listProperties } from '../src/lib/server/ga4';
import { listOpenSeoProjects, OpenSeoError } from '../src/lib/server/openseo';
import { encrypt } from '../src/lib/server/crypto';
import { queueDepth } from '../src/lib/server/jobs';

/** Linking a site queues a background sync; wait for the queue so it can't touch the next test's DB. */
const drain = async () => {
	const end = Date.now() + 20_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
});
afterEach(async () => {
	await drain();
	delete process.env.DEMO_MODE;
});

describe('Bing', () => {
	it('parses the WCF date from the docs sample to the intended calendar day', () => {
		expect(parseBingDate('/Date(1316156400000-0700)/')).toBe('2011-09-16');
		expect(parseBingDate('/Date(1316131200000)/')).toBe('2011-09-16'); // no offset = UTC
		expect(() => parseBingDate('2011-09-16')).toThrow();
	});

	it('calls the documented JSON endpoint with the API key and maps the documented sample shapes', async () => {
		const id = saveIntegration('bing', 'k', { apiKey: 'SECRETKEY' });
		const calls: string[] = [];
		const f = vi.fn(async (url: string) => {
			calls.push(url);
			if (url.includes('GetQueryStats'))
				return json({ d: [{ __type: 'QueryStats:#Microsoft.Bing.Webmaster.Api', AvgClickPosition: 18, AvgImpressionPosition: 17, Clicks: 15, Date: '/Date(1316156400000-0700)/', Impressions: 100, Query: 'query' }] });
			if (url.includes('GetRankAndTrafficStats')) return json({ d: [{ Clicks: 15, Date: '/Date(1316156400000-0700)/', Impressions: 100 }] });
			return json({ d: [{ AuthenticationCode: 'x', IsVerified: false, Url: 'http://example.com' }] });
		});
		const c = new RealBingClient(id, { fetchImpl: f as never });
		expect(await c.listSites()).toEqual([{ url: 'http://example.com', isVerified: false }]);
		expect(await c.dailyStats('http://example.com')).toEqual([{ date: '2011-09-16', clicks: 15, impressions: 100 }]);
		expect((await c.queryStats('http://example.com'))[0]).toMatchObject({ date: '2011-09-16', term: 'query', clicks: 15, clickPos: 18, imprPos: 17 });
		expect(calls[0]).toBe('https://ssl.bing.com/webmaster/api.svc/json/GetUserSites?apikey=SECRETKEY');
		expect(calls[1]).toContain('GetRankAndTrafficStats?siteUrl=http%3A%2F%2Fexample.com&apikey=SECRETKEY');
	});

	it('surfaces the documented 400 error body and never leaks the API key in errors', async () => {
		const id = saveIntegration('bing', 'k', { apiKey: 'SECRETKEY' });
		const bad = new RealBingClient(id, { fetchImpl: (async () => json({ ErrorCode: 3, Message: 'InvalidApiKey' }, 400)) as never });
		const e = (await bad.listSites().catch((x) => x)) as BingApiError;
		expect(e).toBeInstanceOf(BingApiError);
		expect(e.message).toMatch(/rejected this API key/);
		expect(e.code).toBe(3);
		const down = new RealBingClient(id, { fetchImpl: (async (u: string) => { throw new Error(`connect ECONNREFUSED ${u}`); }) as never });
		const e2 = (await down.listSites().catch((x) => x)) as Error;
		expect(e2.message).not.toContain('SECRETKEY');
	});

	it('retries 5xx then succeeds', async () => {
		const id = saveIntegration('bing', 'k', { apiKey: 'K' });
		const f = vi.fn().mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(json({ d: [] }));
		const c = new RealBingClient(id, { fetchImpl: f as never, sleepImpl: async () => {} });
		expect(await c.listSites()).toEqual([]);
		expect(f).toHaveBeenCalledTimes(2);
	});

	it('OAuth: sends Bearer to the OAuth host and refreshes an expired token', async () => {
		process.env.BING_CLIENT_ID = 'cid';
		process.env.BING_CLIENT_SECRET = 'sec';
		const id = saveIntegration('bing', 'o', { refreshToken: 'R1', accessToken: 'old', expiresAt: Date.now() - 1000 }, { auth: 'oauth' });
		const seen: { url: string; auth?: string; body?: string }[] = [];
		const f = vi.fn(async (url: string, init?: RequestInit) => {
			seen.push({ url, auth: (init?.headers as Record<string, string> | undefined)?.authorization, body: String(init?.body ?? '') });
			if (url.includes('/oauth/token')) return json({ access_token: 'new', expires_in: 3599 });
			return json({ d: [] });
		});
		await new RealBingClient(id, { fetchImpl: f as never }).listSites();
		expect(seen[0].url).toBe('https://www.bing.com/webmasters/oauth/token');
		expect(seen[0].body).toContain('grant_type=refresh_token');
		expect(seen[0].body).toContain('refresh_token=R1');
		expect(seen[1].url).toBe('https://www.bing.com/webmaster/api.svc/json/GetUserSites?');
		expect(seen[1].auth).toBe('Bearer new');
		delete process.env.BING_CLIENT_ID;
	});
});

describe('Clarity', () => {
	it('enforces the 10 calls/day/project budget locally, before calling Microsoft', async () => {
		const id = saveIntegration('clarity', 'p', { token: 't' });
		const f = vi.fn(async () => json([{ metricName: 'Traffic', information: [{ totalSessionCount: '9554', totalBotSessionCount: '8369', distantUserCount: '189733', PagesPerSessionPercentage: 1.0931, OS: 'Other' }] }]));
		for (let i = 0; i < 10; i++) expect((await fetchInsights(id, 't', {}, f as never))[0].metricName).toBe('Traffic');
		expect(callsLeft(id)).toBe(0);
		await expect(fetchInsights(id, 't', {}, f as never)).rejects.toThrow(/daily limit/i);
		expect(f).toHaveBeenCalledTimes(10);
	});

	it('uses the documented endpoint, bearer auth and dimension1', async () => {
		const id = saveIntegration('clarity', 'p', { token: 'TKN' });
		const f = vi.fn(async () => json([]));
		await fetchInsights(id, 'TKN', { numOfDays: 1, dimension: 'URL' }, f as never);
		const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1&dimension1=URL');
		expect((init.headers as Record<string, string>).authorization).toBe('Bearer TKN');
	});

	it('maps 401 to a helpful message and still counts the call', async () => {
		const id = saveIntegration('clarity', 'p', { token: 'bad' });
		const e = (await fetchInsights(id, 'bad', {}, (async () => new Response('', { status: 401 })) as never).catch((x) => x)) as ClarityApiError;
		expect(e.status).toBe(401);
		expect(e.message).toMatch(/token/i);
		expect(callsLeft(id)).toBe(9);
	});

	it('refreshes every 8.5 hours within the daily limit: 9 calls a day, one always kept for the user, never more than 10', async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date('2026-11-09T00:30:00Z'));
			await ensureDemoAccounts();
			await connectClarity(1, 'demo'); // 1 call: the connect test, stored as the first totals snapshot
			const integ = linksFor(1).clarity!.integration_id!;
			await syncClarity(1); // fills URL and Device: 2 calls (totals is fresh)
			expect(10 - callsLeft(integ)).toBe(3);
			await syncClarity(1); // an hour later nothing is stale: no call
			expect(10 - callsLeft(integ)).toBe(3);
			vi.setSystemTime(new Date('2026-11-09T08:00:00Z')); // 7.5 hours on: still fresh, no call
			await syncClarity(1);
			expect(10 - callsLeft(integ)).toBe(3);
			for (const hour of ['09:00', '17:30', '23:59']) {
				vi.setSystemTime(new Date(`2026-11-09T${hour}:00Z`));
				await syncClarity(1);
			}
			// 09:00 and 17:30 each refresh all three (to 9 used); the 23:59 run must stop to keep the last call free
			expect(10 - callsLeft(integ)).toBe(9);
			expect(callsLeft(integ)).toBe(1);
			// a new UTC day starts a new allowance and a new snapshot row per dimension
			vi.setSystemTime(new Date('2026-11-10T00:30:00Z'));
			await syncClarity(1);
			expect(10 - callsLeft(integ)).toBe(3);
			const days = db().prepare('SELECT day, COUNT(*) n FROM clarity_snapshots WHERE site_id = 1 GROUP BY day ORDER BY day').all();
			expect(days).toEqual([{ day: '2026-11-09', n: 3 }, { day: '2026-11-10', n: 3 }]);
		} finally {
			vi.useRealTimers();
		}
	});

	it('scheduled sync spends at most 3 calls and is idempotent within a day', async () => {
		await ensureDemoAccounts();
		await connectClarity(1, 'demo');
		const integ = linksFor(1).clarity!.integration_id!;
		const before = 10 - callsLeft(integ); // the connect test call
		expect(before).toBe(1);
		await syncClarity(1);
		const afterFirst = 10 - callsLeft(integ);
		expect(afterFirst).toBeLessThanOrEqual(3);
		await syncClarity(1);
		expect(10 - callsLeft(integ)).toBe(afterFirst);
		const n = (db().prepare('SELECT COUNT(*) n FROM clarity_snapshots WHERE site_id = 1').get() as { n: number }).n;
		expect(n).toBe(3);
	});
});

describe('host matching', () => {
	it('normalises every property style', () => {
		expect(hostKey('sc-domain:Example.com')).toBe('example.com');
		expect(hostKey('https://www.example.com/path')).toBe('example.com');
		expect(hostsMatch('https://blog.example.com/', 'sc-domain:example.com')).toBe(true);
		expect(hostsMatch('https://example.org/', 'sc-domain:example.com')).toBe(false);
	});
	it('prefers exact hosts, refuses ambiguity', () => {
		const c = [{ u: 'https://a.example.com/' }, { u: 'https://example.com/' }];
		expect(bestMatch('sc-domain:example.com', c, (x) => x.u)).toEqual({ u: 'https://example.com/' });
		expect(bestMatch('sc-domain:example.com', [{ u: 'https://a.example.com/' }, { u: 'https://b.example.com/' }], (x) => x.u)).toBeNull();
	});
});

describe('GA4', () => {
	it('lists properties across pages and parses runReport rows (YYYYMMDD dates)', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		const urls: string[] = [];
		const f = vi.fn(async (url: string) => {
			urls.push(url);
			if (url.includes('accountSummaries') && !url.includes('pageToken')) return json({ accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/1', displayName: 'Site 1' }] }], nextPageToken: 'T2' });
			if (url.includes('accountSummaries')) return json({ accountSummaries: [{ displayName: 'Acme', propertySummaries: [{ property: 'properties/2', displayName: 'Site 2' }] }] });
			return json({ rows: [{ dimensionValues: [{ value: '20260131' }, { value: 'Organic Search' }], metricValues: ['10', '6', '8', '1', '25'].map((value) => ({ value })) }] });
		});
		const props = await listProperties(id, { fetchImpl: f as never });
		expect(props.map((p) => p.property)).toEqual(['properties/1', 'properties/2']);
		const rows = await dailyByChannel(id, 'properties/1', '2026-01-01', '2026-01-31', { fetchImpl: f as never });
		expect(rows).toEqual([{ date: '2026-01-31', channel: 'Organic Search', sessions: 10, engagedSessions: 6, users: 8, keyEvents: 1, pageviews: 25 }]);
		expect(urls.at(-1)).toBe('https://analyticsdata.googleapis.com/v1beta/properties/1:runReport');
	});
});

describe('OpenSEO MCP client', () => {
	let srv: Server;
	let base = '';
	const seen: { method: string; key?: string; session?: string }[] = [];
	const start = (mode: 'json' | 'sse') =>
		new Promise<void>((resolve) => {
			srv = createServer((req, res) => {
				let body = '';
				req.on('data', (c) => (body += c));
				req.on('end', () => {
					const msg = body ? JSON.parse(body) : {};
					seen.push({ method: msg.method, key: req.headers['x-api-key'] as string, session: req.headers['mcp-session-id'] as string });
					if (req.url !== '/mcp') return void res.writeHead(404).end();
					if (req.headers['x-api-key'] !== 'oseo_good') return void res.writeHead(401).end();
					if (msg.method === 'notifications/initialized') return void res.writeHead(202).end();
					const reply =
						msg.method === 'initialize'
							? { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'x', version: '1' } } }
							: { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: JSON.stringify({ projects: [{ id: 'p1', name: 'Jobs Board', domain: 'jobsboard.example', url: 'https://x/p/p1' }, { id: 'p2', name: 'Default', domain: null }] }) }] } };
					const headers: Record<string, string> = { 'mcp-session-id': 'sess-1' };
					if (mode === 'sse') res.writeHead(200, { ...headers, 'content-type': 'text/event-stream' }).end(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
					else res.writeHead(200, { ...headers, 'content-type': 'application/json' }).end(JSON.stringify(reply));
				});
			}).listen(0, '127.0.0.1', () => {
				base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
				resolve();
			});
		});
	afterEach(() => srv?.close());

	for (const mode of ['json', 'sse'] as const) {
		it(`completes initialize → initialized → tools/call over ${mode} and carries the session id`, async () => {
			seen.length = 0;
			await start(mode);
			const projects = await listOpenSeoProjects(base, 'oseo_good');
			expect(projects.map((p) => p.id)).toEqual(['p1', 'p2']);
			expect(seen.map((s) => s.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
			expect(seen[2].session).toBe('sess-1');
			expect(seen[0].key).toBe('oseo_good');
		});
	}
	it('reports a rejected key clearly', async () => {
		await start('json');
		await expect(listOpenSeoProjects(base, 'oseo_bad')).rejects.toThrow(OpenSeoError);
	});
});

describe('connect flows (demo)', () => {
	it('Bing: validates, imports sites and auto-links the ones that match; reports the unmatched', async () => {
		await ensureDemoAccounts();
		const r = await connectBingKey('demo', 'Agency Bing');
		expect(r.matched).toBe(5); // ledgerly is not in the demo Bing account
		expect(linksFor(5).bing).toBeUndefined();
		expect(linksFor(1).bing?.external_id).toMatch(/greenleaf\.example/);
	});
	it('Bing: a failing key leaves nothing behind', async () => {
		process.env.DEMO_MODE = '0';
		await ensureDemoAccounts().catch(() => {});
		const before = (db().prepare("SELECT COUNT(*) n FROM integrations WHERE kind='bing'").get() as { n: number }).n;
		await expect(connectBingKey('not-demo', 'x')).rejects.toThrow();
		expect((db().prepare("SELECT COUNT(*) n FROM integrations WHERE kind='bing'").get() as { n: number }).n).toBe(before);
	});
	it('GA4: auto-matches every site by stream URL host; skips accounts without the GA4 scope', async () => {
		await ensureDemoAccounts();
		const real = upsertGoogleAccount({ sub: 'real', email: 'real@x.y', accessToken: 'a', refreshToken: 'r', expiresIn: 3600, scope: 'openid email webmasters' });
		const r = await autoMatchGa4();
		expect(r.matched).toBe(6);
		expect(r.noScope).toContain('real@x.y');
		expect(real).toBeGreaterThan(0);
		expect(linksFor(1).ga4?.external_id).toMatch(/^properties\//);
	});
	it('OpenSEO: links by domain and lists leftovers', async () => {
		await ensureDemoAccounts();
		const r = await connectOpenSeo('https://openseo.example', 'demo');
		expect(r.matched).toBe(2);
		expect(r.unmatchedProjects.join()).toContain('Unrelated');
		expect(linksFor(1).openseo?.external_id).toBe('demo-proj-greenleaf');
		// secrets are stored encrypted
		const raw = db().prepare("SELECT secret_enc FROM integrations WHERE kind='openseo'").get() as { secret_enc: string };
		expect(raw.secret_enc.startsWith('v1:')).toBe(true);
		expect(getIntegration(r.id)?.is_demo).toBe(1);
		expect(encrypt('x')).toMatch(/^v1:/);
	});
	it('syncs Bing and GA4 into the warehouse (queued on link, idempotent on re-run)', async () => {
		await ensureDemoAccounts();
		await connectBingKey('demo', 'b'); // queues a Bing sync per matched site
		await autoMatchGa4(); // queues a GA4 sync per matched site
		await drain();
		const n = (sql: string) => (db().prepare(sql).get() as { n: number }).n;
		expect(n('SELECT COUNT(*) n FROM bing_daily WHERE site_id = 1')).toBeGreaterThan(200);
		expect(n("SELECT COUNT(*) n FROM bing_terms WHERE site_id = 1 AND kind = 'query'")).toBeGreaterThan(10);
		expect(n("SELECT COUNT(*) n FROM ga4_daily WHERE site_id = 1 AND channel = 'Organic Search'")).toBeGreaterThan(200);
		expect(linksFor(1).bing?.sync_status).toBe('idle');
		expect(linksFor(1).ga4?.last_sync_at).toBeTruthy();
		const before = [n('SELECT COUNT(*) n FROM ga4_daily WHERE site_id = 1'), n('SELECT COUNT(*) n FROM bing_terms WHERE site_id = 1')];
		await syncGa4(1); // recent-window refresh only
		await syncBing(1); // full replace
		expect([n('SELECT COUNT(*) n FROM ga4_daily WHERE site_id = 1'), n('SELECT COUNT(*) n FROM bing_terms WHERE site_id = 1')]).toEqual(before);
	});
});
