import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { isLocalRequest, isLoopbackAddress } from '../src/lib/server/guard';
import { securityHeaders } from '../src/lib/server/headers';
import { createSession, endSession, validSession, SESSION_DAYS } from '../src/lib/server/sessions';
import { handle } from '../src/hooks.server';

describe('who counts as "this machine" when no password is set', () => {
	const h = (o: Record<string, string> = {}) => new Headers(o);
	it('recognises loopback addresses exactly, not look-alikes', () => {
		for (const ok of ['127.0.0.1', '127.1.2.3', '::1', '[::1]', '::ffff:127.0.0.1', ' 127.0.0.1 ']) expect(isLoopbackAddress(ok), ok).toBe(true);
		for (const bad of ['', '128.0.0.1', '10.0.0.1', '192.0.2.2', '::ffff:10.0.0.1', '127.0.0.1.evil.com', '1127.0.0.1', 'localhost', '::2', 'fe80::1']) expect(isLoopbackAddress(bad), bad).toBe(false);
		expect(isLoopbackAddress(null)).toBe(false);
		expect(isLoopbackAddress(undefined)).toBe(false);
	});
	it('a URL that says localhost is not enough: the connection must be local too (HOST=0.0.0.0 with ORIGIN=localhost)', () => {
		expect(isLocalRequest('localhost', '127.0.0.1', h())).toBe(true);
		expect(isLocalRequest('localhost', '192.0.2.2', h())).toBe(false); // the hole that was open
		expect(isLocalRequest('localhost', null, h())).toBe(false); // peer unknown
		expect(isLocalRequest('example.com', '127.0.0.1', h())).toBe(false);
		expect(isLocalRequest('LOCALHOST', '::1', h())).toBe(true);
	});
	it('a reverse proxy on the same machine does not make the internet local', () => {
		for (const header of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'via']) {
			expect(isLocalRequest('localhost', '127.0.0.1', h({ [header]: '203.0.113.9' })), header).toBe(false);
		}
	});
});

describe('sessions', () => {
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.ADMIN_PASSWORD = 'first-password';
	});
	it('are random, differ per login, and only a hash of the id is stored', () => {
		const a = createSession(), b = createSession();
		expect(a.id).not.toBe(b.id);
		expect(a.id.length).toBeGreaterThanOrEqual(43);
		const rows = db().prepare('SELECT id_hash FROM sessions').all() as { id_hash: string }[];
		expect(rows).toHaveLength(2);
		expect(rows.some((r) => r.id_hash === a.id)).toBe(false);
		expect(validSession(a.id)).toBe(true);
		expect(a.maxAgeSeconds).toBe(SESSION_DAYS * 86400);
	});
	it('reject guesses, malformed ids and forged old-style cookies', () => {
		createSession();
		for (const bad of [undefined, '', 'ok', 'ok.abcdefghijklmnopqrstuvwxyz0123456789abcdefg', 'x'.repeat(43), 'x'.repeat(500), '%00', "' OR 1=1 --"]) expect(validSession(bad), String(bad)).toBe(false);
	});
	it('expire on the server', () => {
		const now = Date.now();
		const s = createSession(now);
		expect(validSession(s.id, now + 13 * 86_400_000)).toBe(true);
		expect(validSession(s.id, now + 15 * 86_400_000)).toBe(false);
	});
	it('logout revokes the session, so a copied cookie stops working', () => {
		const s = createSession();
		expect(validSession(s.id)).toBe(true);
		endSession(s.id);
		expect(validSession(s.id)).toBe(false);
	});
	it('changing ADMIN_PASSWORD signs everyone out', () => {
		const s = createSession();
		process.env.ADMIN_PASSWORD = 'second-password';
		expect(validSession(s.id)).toBe(false);
		process.env.ADMIN_PASSWORD = 'first-password';
		expect(validSession(s.id)).toBe(true);
	});
	it('expired rows are removed when a new session is made', () => {
		const t = Date.now() - 30 * 86_400_000;
		createSession(t);
		createSession();
		expect((db().prepare('SELECT COUNT(*) n FROM sessions').get() as { n: number }).n).toBe(1);
	});
});

describe('response headers', () => {
	it('always sets the baseline; HSTS only over https; dynamic pages are not cached', () => {
		const http = securityHeaders({ https: false, hasCacheControl: false });
		expect(http).toMatchObject({ 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'private, no-store' });
		expect(http['permissions-policy']).toMatch(/camera=\(\)/);
		expect(http['cross-origin-opener-policy']).toBe('same-origin');
		expect(http).not.toHaveProperty('strict-transport-security');
		expect(securityHeaders({ https: true, hasCacheControl: false })['strict-transport-security']).toMatch(/^max-age=\d+$/);
		expect(securityHeaders({ https: true, hasCacheControl: false })['strict-transport-security']).not.toMatch(/preload|includeSubDomains/);
		expect(securityHeaders({ https: false, hasCacheControl: true })).not.toHaveProperty('cache-control'); // static assets keep their own
	});
});

describe('the request gate (hooks)', () => {
	const ev = (path: string, o: { cookie?: string; peer?: string | null; headers?: Record<string, string>; host?: string } = {}) => {
		const url = new URL(`http://${o.host ?? 'localhost'}:5173${path}`);
		const jar = new Map<string, string>(o.cookie ? [['osc_session', o.cookie]] : []);
		return {
			url, request: new Request(url, { headers: o.headers }), locals: {} as Record<string, unknown>,
			cookies: { get: (k: string) => jar.get(k) },
			getClientAddress: () => { if (o.peer === null) throw new Error('no address'); return o.peer ?? '127.0.0.1'; }
		};
	};
	const run = (e: ReturnType<typeof ev>) => handle({ event: e as never, resolve: (async () => new Response('page')) as never });
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		delete process.env.ADMIN_PASSWORD;
		process.env.DEMO_MODE = '0';
		process.env.SCHEDULER = '0';
	});
	it('no password: served to the machine itself, refused to anyone on the network even when the URL says localhost', async () => {
		expect((await run(ev('/'))).status).toBe(200);
		expect((await run(ev('/', { peer: '192.0.2.2' }))).status).toBe(503);
		expect((await run(ev('/', { peer: null }))).status).toBe(503);
		expect((await run(ev('/', { headers: { 'x-forwarded-for': '203.0.113.9' } }))).status).toBe(503);
		expect((await run(ev('/', { host: 'example.com' }))).status).toBe(503);
	});
	it('with a password: no session means /login, a valid session passes, and a revoked one does not', async () => {
		process.env.ADMIN_PASSWORD = 'pw-for-tests';
		const anon = await run(ev('/accounts'));
		expect(anon.status).toBe(303);
		expect(anon.headers.get('location')).toBe('/login');
		expect((await run(ev('/accounts', { cookie: 'ok.forged' }))).status).toBe(303);
		const s = createSession();
		expect((await run(ev('/accounts', { cookie: s.id }))).status).toBe(200);
		endSession(s.id);
		expect((await run(ev('/accounts', { cookie: s.id }))).status).toBe(303);
		expect((await run(ev('/login'))).status).toBe(200); // the login page itself stays reachable
	});
	it('every response carries the security headers', async () => {
		process.env.ADMIN_PASSWORD = 'pw-for-tests';
		const r = await run(ev('/login'));
		expect(r.headers.get('x-frame-options')).toBe('DENY');
		expect(r.headers.get('cache-control')).toBe('private, no-store');
		expect(r.headers.get('permissions-policy')).toBeTruthy();
	});
	it('the MCP endpoint keeps its own key check and skips the browser gate', async () => {
		process.env.ADMIN_PASSWORD = 'pw-for-tests';
		const r = await run(ev('/api/mcp'));
		expect(r.status).toBe(200); // resolve ran: the route itself enforces the API key
	});
});
