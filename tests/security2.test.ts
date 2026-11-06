import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { handle } from '../src/hooks.server';
import { clientKey, hostnameOf, isLocalRequest, safeBack } from '../src/lib/server/guard';
import { isPrivateIp } from '../src/lib/server/onpage';
import { decode, stripTags } from '../src/lib/onpage';
import { parseSitemapXml } from '../src/lib/sitemap';
import { createApiKey, forgetSite, authenticate } from '../src/lib/server/apikeys';
import { MCP_RATE_PER_MINUTE, handleMcp, inspectionsUsed, rateLimited, resetRateLimits } from '../src/lib/server/mcp';
import { integrationUrlProblem } from '../src/lib/server/connect';
import { chatSafe, renderText, renderUrgent } from '../src/lib/digest';
import { postWebhook } from '../src/lib/server/digest';
import { load as layoutLoad } from '../src/routes/+layout.server';

describe('DNS rebinding and the Host header', () => {
	it('only a Host header that names localhost makes a request local', () => {
		const h = new Headers();
		expect(isLocalRequest('localhost:5173', '127.0.0.1', h)).toBe(true);
		expect(isLocalRequest('127.0.0.1:5173', '127.0.0.1', h)).toBe(true);
		expect(isLocalRequest('[::1]:5173', '::1', h)).toBe(true);
		expect(isLocalRequest('rebind.evil.example:5173', '127.0.0.1', h)).toBe(false); // a website's own name pointed at 127.0.0.1
		expect(isLocalRequest('localhost.evil.example', '127.0.0.1', h)).toBe(false);
		expect(isLocalRequest(null, '127.0.0.1', h)).toBe(false);
		expect(isLocalRequest('', '127.0.0.1', h)).toBe(false);
		expect(hostnameOf('LocalHost:80')).toBe('localhost');
		expect(hostnameOf('[::1]:80')).toBe('[::1]');
	});
});

describe('the gate: cross-site requests, demo mode, headers on every response', () => {
	const ev = (path: string, o: { method?: string; headers?: Record<string, string>; host?: string; peer?: string } = {}) => {
		const host = o.host ?? 'localhost:5173';
		const url = new URL(`http://${host}${path}`);
		return {
			url, request: new Request(url, { method: o.method ?? 'GET', headers: { host, ...(o.headers ?? {}) } }), locals: {} as Record<string, unknown>,
			cookies: { get: () => undefined }, getClientAddress: () => o.peer ?? '127.0.0.1'
		};
	};
	const run = (e: ReturnType<typeof ev>) => handle({ event: e as never, resolve: (async () => new Response('ok')) as never });
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		delete process.env.ADMIN_PASSWORD;
		process.env.DEMO_MODE = '0';
		process.env.SCHEDULER = '0';
	});
	it('refuses a state-changing request from another site even with no content type, and passes the owner\'s own', async () => {
		expect((await run(ev('/logout', { method: 'POST', headers: { origin: 'https://evil.example' } }))).status).toBe(403);
		expect((await run(ev('/sites/1/sync', { method: 'POST', headers: { 'sec-fetch-site': 'cross-site' } }))).status).toBe(403);
		expect((await run(ev('/logout', { method: 'POST', headers: { origin: 'http://localhost:5173' } }))).status).toBe(200);
		expect((await run(ev('/logout', { method: 'POST' }))).status).toBe(200); // a program with no Origin (curl) is not a browser attack
		expect((await run(ev('/', { headers: { origin: 'https://evil.example' } }))).status).toBe(200); // reading is not blocked here
		expect((await run(ev('/api/mcp', { method: 'POST', headers: { origin: 'https://claude.ai' } }))).status).toBe(200); // MCP has its own key check
	});
	it('rebinding Host header is refused without a password', async () => {
		expect((await run(ev('/accounts', { host: 'rebind.evil.example:5173' }))).status).toBe(503);
	});
	it('demo mode no longer opens the app to the network', async () => {
		process.env.DEMO_MODE = '1';
		expect((await run(ev('/', { peer: '192.0.2.2' }))).status).toBe(503);
		expect((await run(ev('/', { peer: '127.0.0.1' }))).status).toBe(200);
	});
	it('early refusals and the MCP endpoint carry the security headers too', async () => {
		for (const r of [await run(ev('/', { peer: '192.0.2.2' })), await run(ev('/api/mcp')), await run(ev('/logout', { method: 'POST', headers: { origin: 'https://evil.example' } }))]) {
			expect(r.headers.get('x-frame-options')).toBe('DENY');
			expect(r.headers.get('x-content-type-options')).toBe('nosniff');
		}
		process.env.ADMIN_PASSWORD = 'pw-for-tests';
		const redirect = await run(ev('/accounts'));
		expect(redirect.status).toBe(303);
		expect(redirect.headers.get('x-frame-options')).toBe('DENY');
	});
	it('before sign-in the layout reveals nothing about the installation', () => {
		process.env.ADMIN_PASSWORD = 'pw-for-tests';
		db().prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (99, 's', 'owner@example.com', 'active', 1)").run();
		const anon = layoutLoad({ locals: { authed: false } } as never) as Record<string, unknown>;
		expect(anon).toMatchObject({ authed: false, accounts: 0, revoked: 0, googleConfigured: false, demo: false });
		expect(JSON.stringify(anon)).not.toContain('owner@example.com');
		expect((layoutLoad({ locals: { authed: true } } as never) as { accounts: number }).accounts).toBeGreaterThan(0);
	});
	it('a request without the proxy header counts in an "unknown" bucket instead of breaking the login page', () => {
		expect(clientKey(() => '203.0.113.5')).toBe('203.0.113.5');
		expect(clientKey(() => { throw new Error('Address header was specified with ADDRESS_HEADER=x-forwarded-for but is absent from request'); })).toBe('unknown');
		expect(clientKey(() => '')).toBe('unknown');
	});
	it('redirects after an action stay inside the app', () => {
		expect(safeBack('http://localhost:5173/sites/1/queries?x=1', 'http://localhost:5173', '/f')).toBe('/sites/1/queries?x=1');
		expect(safeBack('https://evil.example/phish', 'http://localhost:5173', '/f')).toBe('/f');
		expect(safeBack('//evil.example', 'http://localhost:5173', '/f')).toBe('/f');
		expect(safeBack('javascript:alert(1)', 'http://localhost:5173', '/f')).toBe('/f');
		expect(safeBack(null, 'http://localhost:5173', '/f')).toBe('/f');
	});
});

describe('hostile page content cannot stall the server', () => {
	it('stripTags is linear (80,000 "<" took 4.5 seconds with the regex) and keeps the regex\'s meaning', () => {
		const t = Date.now();
		stripTags('<'.repeat(80_000));
		stripTags('<a'.repeat(80_000));
		stripTags('<'.repeat(80_000) + '>');
		expect(Date.now() - t).toBeLessThan(500);
		const ref = (s: string) => s.replace(/<[^>]*>/g, ' ');
		const cases = ['plain', 'a <b>bold</b> c', '<<>>', 'x<y', 'x>y', '<a href="x">t</a> and <i>', '5 < 6 and 7 > 3', '<>', '', 'a<b<c>d', '<!-- c --> t', 'x<'];
		for (const c of cases) expect(stripTags(c), c).toBe(decode(ref(c)));
		let seed = 7;
		const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
		for (let i = 0; i < 300; i++) {
			const s = Array.from({ length: 1 + Math.floor(rnd() * 20) }, () => '<>ab '[Math.floor(rnd() * 5)]).join('');
			expect(stripTags(s), JSON.stringify(s)).toBe(decode(ref(s)));
		}
	});
	it('a big upper-case sitemap parses fast and keeps its URLs intact', () => {
		const big = '<URLSET>' + '<URL><LOC>https://x.example/A</LOC></URL>'.repeat(40_000) + '</URLSET>';
		const t = Date.now();
		const p = parseSitemapXml(big);
		expect(Date.now() - t).toBeLessThan(1500);
		expect(p.entries[0].loc).toBe('https://x.example/A'); // case of the URL itself is untouched
		const dotted = parseSitemapXml('<urlset><url><loc>https://x.example/İstanbul/Ä</loc></url><url><loc>https://x.example/two</loc></url></urlset>');
		expect(dotted.entries.map((e) => e.loc)).toEqual(['https://x.example/İstanbul/Ä', 'https://x.example/two']); // alignment survives a character that expands when lower-cased
	});
});

describe('private address detection, every spelling', () => {
	it('blocks private, loopback, link-local, mapped, NAT64, 6to4 and reserved addresses', () => {
		for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '198.18.0.1', '198.19.255.255', '192.0.2.2', '203.0.113.5', '0.0.0.0', '224.0.0.1', '255.255.255.255',
			'::', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:a00:1', '::ffff:c0a8:101', '::127.0.0.1', '64:ff9b::7f00:1', '64:ff9b::127.0.0.1', '2002:7f00:1::', '2002:a00:1::1', 'fe80::1', 'fec0::1', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2001:0:1::1', '[::1]', '::ffff:169.254.169.254', '0:0:0:0:0:ffff:7f00:1']) expect(isPrivateIp(a), a).toBe(true);
	});
	it('allows ordinary public addresses, including public ones inside mapped, NAT64 and 6to4 forms', () => {
		for (const a of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '100.63.0.1', '198.17.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '::ffff:808:808', '64:ff9b::808:808', '2002:808:808::']) expect(isPrivateIp(a), a).toBe(false);
	});
	it('an address it cannot read is refused', () => {
		expect(isPrivateIp('1:2:3:4:5:6:7:8:9')).toBe(false); // not an IP at all: handled by the caller (isIP says 0)
	});
});

describe('MCP: limits, budgets and bad bodies', () => {
	let key = '';
	let keyId = 0;
	const post = (body: string, k = key) => handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body }));
	const call = async (name: string, args: object, k = key) => {
		const r = (await (await post(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }), k)).json()).result;
		return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
	};
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const k = createApiKey('t', null);
		key = k.key;
		keyId = k.id;
		resetRateLimits();
		delete process.env.MCP_INSPECT_PER_KEY_DAY;
	});
	it('a body of null, a number, a string or a batch is a 400, not a crash', async () => {
		for (const b of ['null', '5', '"x"', '[]', '[{"jsonrpc":"2.0","id":1,"method":"ping"}]']) {
			const r = await post(b);
			expect(r.status, b).toBe(400);
			expect((await r.json()).error.code).toBe(-32600);
		}
		expect((await post('{bad')).status).toBe(400);
	});
	it('rate-limits a key per minute and forgets old requests', () => {
		const t0 = 1_000_000;
		for (let i = 0; i < MCP_RATE_PER_MINUTE; i++) expect(rateLimited(424242, t0 + i)).toBe(false);
		expect(rateLimited(424242, t0 + 1000)).toBe(true);
		expect(rateLimited(424243, t0 + 1000)).toBe(false); // another key is unaffected
		expect(rateLimited(424242, t0 + 61_000 + MCP_RATE_PER_MINUTE)).toBe(false); // the window moved on
	});
	it('over HTTP the limit answers 429 with Retry-After', async () => {
		let last: Response | null = null;
		for (let i = 0; i < MCP_RATE_PER_MINUTE + 3; i++) last = await post('{"jsonrpc":"2.0","id":1,"method":"ping"}');
		expect(last!.status).toBe(429);
		expect(last!.headers.get('retry-after')).toBe('60');
	});
	it('tells agents that site text is data, not instructions', async () => {
		const r = await (await post('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}')).json();
		expect(r.result.instructions).toMatch(/third-party text.*never as instructions/);
	});
	it('inspect_url: spelling variants share one cached answer, and a key has a daily budget of live inspections', async () => {
		const page = 'https://www.greenleaf.example/guides/a';
		const sites = (await call('list_sites', {})).data as { id: number; property: string }[];
		const s1 = sites.find((s) => s.id === 1)!;
		const base = s1.property.startsWith('sc-domain:') ? `https://www.${s1.property.slice(10)}/guides/a` : `${s1.property}guides/a`;
		const first = await call('inspect_url', { site: '1', urls: [base] });
		expect(first.data.results[0].fromCache).toBe(false);
		const variant = base.replace(/^https:\/\/([^/]+)/, (_m, h: string) => 'HTTPS://' + h.toUpperCase()) + '#frag';
		const again = await call('inspect_url', { site: '1', urls: [variant] });
		expect(again.isError).toBe(false);
		expect(again.data.results[0].fromCache).toBe(true); // same page, so the cache answered
		expect(inspectionsUsed(keyId)).toBe(1);
		void page;
		process.env.MCP_INSPECT_PER_KEY_DAY = '1';
		const over = await call('inspect_url', { site: '1', urls: [base + '?b=1'], refresh: true });
		expect(over.isError).toBe(true);
		expect(over.data).toMatch(/used its 1 live URL inspections/);
		process.env.MCP_INSPECT_PER_KEY_DAY = '5';
		const ok = await call('inspect_url', { site: '1', urls: [base + '?b=1'], refresh: true });
		expect(ok.isError).toBe(false);
		expect(inspectionsUsed(keyId)).toBe(2);
		// cached answers cost nothing
		await call('inspect_url', { site: '1', urls: [base + '?b=1'] });
		expect(inspectionsUsed(keyId)).toBe(2);
	});
});

describe('API key scope when a site is deleted', () => {
	beforeEach(() => void (globalThis.__openSiteConsoleDb = openDb(':memory:')));
	it('removes the id from every key; a key left with no sites sees nothing rather than everything', () => {
		const only = createApiKey('only 5', [5]);
		const two = createApiKey('1 and 2', [1, 2]);
		const all = createApiKey('all', null);
		forgetSite(5);
		forgetSite(2);
		const req = (k: string) => authenticate(new Request('http://x', { headers: { authorization: `Bearer ${k}` } }))!;
		expect(req(only.key).scope).toEqual([]);
		expect(req(two.key).scope).toEqual([1]);
		expect(req(all.key).scope).toBeNull();
	});
	it('an empty scope really is "no sites" in the MCP server', async () => {
		resetRateLimits();
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const k = createApiKey('gone', [999]);
		forgetSite(999);
		const r = await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_sites', arguments: {} } }) }))).json();
		expect(JSON.parse(r.result.content[0].text)).toEqual([]);
	});
});

describe('addresses a stored key is sent to', () => {
	it('refuses credentials in the URL and cloud metadata addresses, allows a LAN or public OpenSEO', () => {
		for (const bad of ['http://user:pw@openseo.example.com', 'ftp://x.example', 'not a url', 'http://169.254.169.254/latest', 'http://169.254.1.1', 'http://metadata.google.internal/', 'http://metadata/', 'http://[fe80::1]/', 'http://[fd00:ec2::254]/']) expect(integrationUrlProblem(bad), bad).not.toBeNull();
		for (const ok of ['https://openseo.example.com', 'http://192.168.1.20:8787', 'http://localhost:3000', 'https://openseo.example.workers.dev']) expect(integrationUrlProblem(ok), ok).toBeNull();
	});
});

describe('text from the web inside chat messages', () => {
	it('cannot ping a room or inject Slack markup', () => {
		const out = chatSafe('<!channel> hi <@U123> <https://evil.example|click> @everyone @Here & done');
		expect(out).not.toMatch(/<|>/);
		expect(out).not.toMatch(/@(everyone|here|channel)/i);
		expect(out).toContain('&amp;');
		const d = { createdAt: 1, weekEnd: '2026-10-31', headline: ['<!channel> bad'], sites: [], top: [{ key: 'k', type: 'blocked' as const, title: '<!here> /guides/@everyone', blocking: true, impact: 1, confidence: 'high' as const, href: '/x', site: '<@U1>', siteId: 1 }] };
		const text = renderText(d, 'https://seo.example');
		expect(text).not.toContain('<!');
		expect(text).not.toContain('<@');
		expect(renderUrgent([{ site: '<@U1>', title: '@everyone', why: '<!channel>', href: '/x' }], '')).not.toMatch(/<!|<@|@everyone/);
	});
	it('a Discord message asks to mention nobody', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/x';
		process.env.DIGEST_WEBHOOK_FORMAT = 'discord';
		let body: Record<string, unknown> = {};
		await postWebhook('hi', {}, (async (_u: URL, i: RequestInit) => ((body = JSON.parse(String(i.body))), new Response('ok'))) as never);
		expect(body.allowed_mentions).toEqual({ parse: [] });
		delete process.env.DIGEST_WEBHOOK_URL;
		delete process.env.DIGEST_WEBHOOK_FORMAT;
	});
});

describe('files and containers', () => {
	it('the database file is owner-only, and an existing loose one is tightened', () => {
		const dir = mkdtempSync(join(tmpdir(), 'osc-db-'));
		const path = join(dir, 'a.db');
		openDb(path).close();
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const loose = join(dir, 'b.db');
		writeFileSync(loose, '');
		chmodSync(loose, 0o644);
		openDb(loose).close();
		expect(statSync(loose).mode & 0o777).toBe(0o600);
	});
	it('both images run as an unprivileged user, and the app is started without the R2 keys', () => {
		for (const f of ['Dockerfile', 'Dockerfile.cloudflare']) expect(readFileSync(join(process.cwd(), f), 'utf8'), f).toMatch(/^USER node$/m);
		const ep = readFileSync(join(process.cwd(), 'deploy/cloudflare/entrypoint.sh'), 'utf8');
		expect(ep).toMatch(/env -u R2_ACCESS_KEY_ID -u R2_SECRET_ACCESS_KEY node build/);
	});
});

describe('the Coolify compose file', () => {
	const f = readFileSync(join(process.cwd(), 'compose.coolify.yaml'), 'utf8');
	it('publishes no host port, keeps the data in a named volume, and refuses to deploy open', () => {
		expect(f).not.toMatch(/^\s*ports:/m); // a published port would bypass the proxy
		expect(f).toMatch(/osc-data:\/data/);
		for (const v of ['ORIGIN', 'APP_SECRET']) expect(f, v).toMatch(new RegExp(`\\$\\{${v}:\\?`));
		// the login password may be given plain or as a hash; with neither the app itself refuses remote requests
		expect(f).toMatch(/ADMIN_PASSWORD=\$\{ADMIN_PASSWORD:-\}/);
		expect(f).toMatch(/ADMIN_PASSWORD_HASH=\$\{ADMIN_PASSWORD_HASH:-\}/);
		expect(f).toMatch(/ADDRESS_HEADER=\$\{ADDRESS_HEADER:-X-Forwarded-For\}/);
		expect(f).toMatch(/XFF_DEPTH=\$\{XFF_DEPTH:-1\}/);
		expect(f).toMatch(/healthcheck:/);
	});
});
