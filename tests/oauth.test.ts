import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { config } from '../src/lib/server/config';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { authenticate, createApiKey, deleteApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { handle } from '../src/hooks.server';
import { GET as discoveryAuth } from '../src/routes/.well-known/oauth-authorization-server/+server';
import { GET as discoveryResource } from '../src/routes/.well-known/oauth-protected-resource/+server';
import { GET as discoveryResourcePath } from '../src/routes/.well-known/oauth-protected-resource/api/mcp/+server';
import { POST as registerRoute } from '../src/routes/oauth/register/+server';
import { POST as tokenRoute } from '../src/routes/oauth/token/+server';
import * as authorizePage from '../src/routes/oauth/authorize/+page.server';
import * as loginPage from '../src/routes/login/+page.server';
import { createSession } from '../src/lib/server/sessions';
import { crossSiteRefused } from '../src/lib/server/guard';
import { readFileSync } from 'node:fs';
import {
	callbackUrl, cleanName, challengeValid, DEFAULT_REDIRECTS, extraRedirects, parseForm, parseRegistration, parseRedirect, pkceChallenge, pkceMatches,
	redirectMatches, redirectRegisterable, resourceMatches, safeNext, verifierValid
} from '../src/lib/server/oauth-core';
import {
	ACCESS_TTL_MS, approveRequest, checkAuthorize, CODE_TTL_MS, denyRequest, getClient, MAX_CLIENTS, oauthLabels, redeemCode, refreshTokens, REFRESH_TTL_MS,
	REQUEST_TTL_MS, registerClient, resetOAuthLimits, withinLimit
} from '../src/lib/server/oauth';

const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
// The example from RFC 7636 appendix B.
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const ORIGIN = () => config.origin;

const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const ev = (request: Request, ip = '198.51.100.7') => ({ request, getClientAddress: () => ip }) as never;
const postJson = (url: string, body: unknown, ip?: string) => registerRoute(ev(new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), ip));
const tokenPost = async (params: Record<string, string>, ip?: string, contentType = 'application/x-www-form-urlencoded') => {
	const r = await tokenRoute(ev(new Request('http://x/oauth/token', { method: 'POST', headers: { 'content-type': contentType }, body: contentType.startsWith('application/x-www') ? form(params) : JSON.stringify(params) }), ip));
	return { status: r.status, json: (await r.json()) as Record<string, unknown>, headers: r.headers };
};
const authorizeQuery = (clientId: string, o: Record<string, string> = {}) =>
	'?' + form({ response_type: 'code', client_id: clientId, redirect_uri: CLAUDE, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'xyz', ...o });
/** Runs a load function and returns what it threw (an HttpError or a Redirect) or what it returned. */
const loadOf = (search: string) => {
	try {
		return { data: authorizePage.load({ url: new URL('http://localhost/oauth/authorize' + search) } as never) as unknown as { requestId: string; clientName: string; redirectHost: string; sites: { id: number }[] } };
	} catch (e) {
		const x = e as { status?: number; location?: string; body?: { message?: string } };
		return { status: x.status, location: x.location, message: x.body?.message };
	}
};
const act = (name: 'allow' | 'deny', f: Record<string, string | string[]>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries(f)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
	return (authorizePage.actions[name] as (e: never) => Promise<{ redirect?: string; status?: number; data?: { error?: string } }>)({ request: new Request('http://localhost/oauth/authorize', { method: 'POST', body }) } as never);
};
const newClient = (uris = [CLAUDE]) => registerClient('Claude', uris)!;
/** A complete sign-in up to the code: register, check, approve. */
const approveFlow = (sites: number[] | null = null, now?: number) => {
	const c = newClient();
	const chk = checkAuthorize(authorizeQuery(c.id), ORIGIN(), now);
	if (chk.kind !== 'consent') throw new Error('expected consent, got ' + chk.kind);
	const ok = approveRequest(chk.requestId, sites, now)!;
	const u = new URL(ok.location);
	return { client: c, code: u.searchParams.get('code')!, state: u.searchParams.get('state'), url: u };
};
const exchange = (client: { id: string }, code: string, o: Record<string, string> = {}) => tokenPost({ grant_type: 'authorization_code', code, client_id: client.id, redirect_uri: CLAUDE, code_verifier: VERIFIER, ...o });
const mcpInit = (token?: string) =>
	handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) }));

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.SCHEDULER = '0';
	process.env.DEMO_MODE = '0';
	delete process.env.MCP_OAUTH_REDIRECTS;
	process.env.ADMIN_PASSWORD = 'pw-for-oauth-tests';
	resetOAuthLimits();
});

describe('PKCE', () => {
	it('matches the RFC 7636 example, and only a verifier that hashes to the challenge passes', () => {
		expect(pkceChallenge(VERIFIER)).toBe(CHALLENGE);
		expect(pkceMatches(VERIFIER, CHALLENGE)).toBe(true);
		expect(pkceMatches(VERIFIER.slice(0, -1) + 'A', CHALLENGE)).toBe(false);
		expect(pkceMatches(VERIFIER, CHALLENGE.slice(0, -1) + 'A')).toBe(false);
		expect(pkceMatches(CHALLENGE, CHALLENGE)).toBe(false); // sending the challenge itself proves nothing
	});
	it('rejects malformed verifiers and challenges before hashing anything', () => {
		expect(verifierValid('short')).toBe(false);
		expect(verifierValid('a'.repeat(129))).toBe(false);
		expect(verifierValid('a'.repeat(42) + '!')).toBe(false);
		expect(verifierValid('a'.repeat(43))).toBe(true);
		expect(challengeValid('a'.repeat(42))).toBe(false);
		expect(challengeValid('a'.repeat(43))).toBe(true);
		expect(pkceMatches('short', 'short')).toBe(false);
	});
});

describe('callback addresses', () => {
	it('may be registered only if loopback or on the allowed list', () => {
		expect(redirectRegisterable(CLAUDE)).toBe(true);
		for (const ok of ['http://localhost:3118/callback', 'http://127.0.0.1:8080/callback', 'http://[::1]:9000/cb', 'http://localhost/callback']) expect(redirectRegisterable(ok), ok).toBe(true);
		for (const bad of ['https://evil.example/cb', 'http://claude.ai/api/mcp/auth_callback', 'https://claude.ai.evil.example/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback/', 'https://claude.ai/api/mcp/auth_callback?x=1', 'javascript:alert(1)', 'data:text/html,x', 'ftp://localhost/cb', 'http://localhost.evil.example/cb', 'http://192.168.1.5/cb', 'https://claude.ai/api/mcp/auth_callback#frag', 'https://user:pw@claude.ai/api/mcp/auth_callback', 'http://localhost:3000/cb#frag', 'http://user:pw@localhost:3000/cb', 'http://localhost/cb?' + 'a'.repeat(600), 'http://localhost:3000/cb\n', 'http://local host/cb', '', 'x', 'https://claude.ai/api/mcp/auth_callback ' + 'a'.repeat(600)]) expect(redirectRegisterable(bad), bad).toBe(false);
		expect(redirectRegisterable(5)).toBe(false);
		expect(redirectRegisterable(null)).toBe(false);
	});
	it('an owner can allow more addresses with a setting, https only and exact', () => {
		const extra = extraRedirects('https://chat.example/cb , http://insecure.example/cb, nonsense, https://other.example/x');
		expect(extra).toEqual(['https://chat.example/cb', 'https://other.example/x']);
		expect(redirectRegisterable('https://chat.example/cb', extra)).toBe(true);
		expect(redirectRegisterable('https://chat.example/cb2', extra)).toBe(false);
		expect(redirectRegisterable('https://chat.example/cb')).toBe(false);
		expect(DEFAULT_REDIRECTS).toEqual([CLAUDE]);
	});
	it('must match a registered one exactly; loopback may change port only', () => {
		expect(redirectMatches([CLAUDE], CLAUDE)).toBe(true);
		for (const bad of [CLAUDE + '/', CLAUDE + '?a=1', 'https://claude.ai/api/mcp/other', 'https://claude.com/api/mcp/auth_callback', 'http://claude.ai/api/mcp/auth_callback', '', 'nonsense', 7]) expect(redirectMatches([CLAUDE], bad), String(bad)).toBe(false);
		const lb = ['http://localhost:1111/callback'];
		expect(redirectMatches(lb, 'http://localhost:54321/callback')).toBe(true);
		expect(redirectMatches(lb, 'http://localhost/callback')).toBe(true);
		expect(redirectMatches(lb, 'http://localhost:54321/other')).toBe(false); // path must match
		expect(redirectMatches(lb, 'http://127.0.0.1:1111/callback')).toBe(false); // host must match
		expect(redirectMatches(lb, 'https://localhost:1111/callback')).toBe(false); // scheme must match
		expect(redirectMatches([CLAUDE], 'http://localhost:1/callback')).toBe(false); // loopback is not a wildcard for non-loopback registrations
		expect(parseRedirect('https://claude.ai/x')?.host).toBe('claude.ai');
	});
});

describe('client registration rules', () => {
	it('accepts a public authorization-code client and keeps the name as plain text', () => {
		const r = parseRegistration({ client_name: '  Claude\u0000\n  <b>Desktop</b> ', redirect_uris: [CLAUDE, CLAUDE], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' });
		expect(r).toEqual({ ok: true, name: 'Claude <b>Desktop</b>', redirectUris: [CLAUDE] }); // markup is left as text (the page escapes it), controls are gone, duplicates merged
		expect(cleanName('x'.repeat(200))).toHaveLength(80);
		expect(cleanName(undefined)).toBe('MCP client');
		expect(cleanName(' \n\t ')).toBe('MCP client');
	});
	it('refuses everything that is not harmless', () => {
		const ok = { redirect_uris: [CLAUDE] };
		for (const body of [null, 'x', [], {}, { redirect_uris: [] }, { redirect_uris: 'https://claude.ai/' }, { redirect_uris: Array(6).fill(CLAUDE) }, { redirect_uris: ['https://evil.example/cb'] }, { ...ok, grant_types: ['client_credentials'] }, { ...ok, grant_types: 'authorization_code' }, { ...ok, response_types: ['token'] }, { ...ok, token_endpoint_auth_method: 'client_secret_basic' }]) {
			expect(parseRegistration(body).ok, JSON.stringify(body)).toBe(false);
		}
		expect(parseRegistration({ redirect_uris: ['https://evil.example/cb'] })).toMatchObject({ ok: false, error: 'invalid_redirect_uri' });
		expect(parseRegistration({ ...ok, token_endpoint_auth_method: 'private_key_jwt' })).toMatchObject({ ok: false, error: 'invalid_client_metadata' });
	});
});

describe('forms, resources and the sign-in return path', () => {
	it('a repeated parameter is an error, not "the last one wins"', () => {
		expect(parseForm('a=1&b=2')?.get('b')).toBe('2');
		expect(parseForm('a=1&a=2')).toBeNull();
		expect(parseForm('')?.size).toBe(0);
	});
	it('a resource indicator is optional, but when given it must be this server\'s MCP endpoint', () => {
		expect(resourceMatches(null, 'https://s.example')).toBe(true);
		expect(resourceMatches('https://s.example/api/mcp', 'https://s.example')).toBe(true);
		expect(resourceMatches('https://s.example/api/mcp/', 'https://s.example')).toBe(true);
		expect(resourceMatches('https://other.example/api/mcp', 'https://s.example')).toBe(false);
		expect(resourceMatches('https://s.example', 'https://s.example')).toBe(false);
	});
	it('only the authorization page can be returned to after sign-in', () => {
		expect(safeNext('/oauth/authorize?client_id=a&state=b')).toBe('/oauth/authorize?client_id=a&state=b');
		expect(safeNext('/oauth/authorize')).toBe('/oauth/authorize');
		// An unencoded redirect_uri contains "//" and must still work, or those apps would land on the home page instead of the approval screen.
		expect(safeNext('/oauth/authorize?redirect_uri=https://claude.ai/api/mcp/auth_callback&state=1')).toBe('/oauth/authorize?redirect_uri=https://claude.ai/api/mcp/auth_callback&state=1');
		for (const bad of [null, '', '/', '/accounts', 'https://evil.example/oauth/authorize', '//evil.example/oauth/authorize', '/oauth/authorize//evil.example', '/oauth/authorizeX', '/oauth/authorize?x=\\evil', '/oauth/authorize?x=1\nSet-Cookie: a', '/oauth/authorize?' + 'a'.repeat(2100), '/oauth/token']) expect(safeNext(bad as string), String(bad)).toBeNull();
	});
	it('a callback keeps what the client registered and adds code, state and the issuer', () => {
		const u = new URL(callbackUrl('http://localhost:5000/callback?keep=1', { code: 'c', state: 's', nothing: null }, 'https://s.example'));
		expect(u.searchParams.get('keep')).toBe('1');
		expect(u.searchParams.get('code')).toBe('c');
		expect(u.searchParams.get('state')).toBe('s');
		expect(u.searchParams.get('iss')).toBe('https://s.example');
		expect(u.searchParams.has('nothing')).toBe(false);
	});
});

describe('discovery documents', () => {
	it('say where everything is, and promise only what is implemented', async () => {
		const as = (await (discoveryAuth({} as never) as Response).json()) as Record<string, unknown>;
		const o = ORIGIN();
		expect(as).toMatchObject({ issuer: o, authorization_endpoint: `${o}/oauth/authorize`, token_endpoint: `${o}/oauth/token`, registration_endpoint: `${o}/oauth/register` });
		expect(as.code_challenge_methods_supported).toEqual(['S256']); // plain is not offered
		expect(as.token_endpoint_auth_methods_supported).toEqual(['none']);
		expect(as.grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
		expect(as.response_types_supported).toEqual(['code']);
		expect(as).not.toHaveProperty('client_id_metadata_document_supported'); // client metadata documents are not fetched, so not advertised
		for (const route of [discoveryResource, discoveryResourcePath]) {
			const rm = (await (route({} as never) as Response).json()) as Record<string, unknown>;
			expect(rm.resource).toBe(`${o}/api/mcp`); // must equal the address people enter in Claude
			expect(rm.authorization_servers).toEqual([o]);
		}
	});
	it('the MCP endpoint answers an unauthenticated call with a 401 that points at the document', async () => {
		const r = await mcpInit();
		expect(r.status).toBe(401);
		expect(r.headers.get('www-authenticate')).toBe(`Bearer resource_metadata="${ORIGIN()}/.well-known/oauth-protected-resource/api/mcp"`);
	});
	it('a credential that was sent but is no good is reported as invalid_token', async () => {
		const r = await mcpInit('osc_notarealkey');
		expect(r.status).toBe(401);
		expect(r.headers.get('www-authenticate')).toMatch(/error="invalid_token"/);
		expect(r.headers.get('www-authenticate')).toMatch(/resource_metadata=/);
	});
});

describe('POST /oauth/register', () => {
	it('registers a client and stores it', async () => {
		const r = await postJson('http://x/oauth/register', { client_name: 'Claude', redirect_uris: [CLAUDE], token_endpoint_auth_method: 'none' });
		expect(r.status).toBe(201);
		const j = (await r.json()) as { client_id: string; redirect_uris: string[]; token_endpoint_auth_method: string };
		expect(j.client_id).toMatch(/^ocl_/);
		expect(j.token_endpoint_auth_method).toBe('none');
		expect(getClient(j.client_id)).toMatchObject({ name: 'Claude', redirectUris: [CLAUDE] });
		expect(r.headers.get('cache-control')).toBe('no-store');
	});
	it('refuses a callback address that is not allowed, with the standard error', async () => {
		const r = await postJson('http://x/oauth/register', { client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] });
		expect(r.status).toBe(400);
		expect(((await r.json()) as { error: string }).error).toBe('invalid_redirect_uri');
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_clients').get() as { n: number }).n).toBe(0);
	});
	it('takes an address from the owner\'s setting, and only exactly that one', async () => {
		process.env.MCP_OAUTH_REDIRECTS = 'https://chat.example/cb';
		expect((await postJson('http://x/oauth/register', { redirect_uris: ['https://chat.example/cb'] })).status).toBe(201);
		expect((await postJson('http://x/oauth/register', { redirect_uris: ['https://chat.example/cb/'] })).status).toBe(400);
	});
	it('refuses non-JSON, broken JSON and oversize bodies', async () => {
		const wrongType = await registerRoute(ev(new Request('http://x/oauth/register', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ redirect_uris: [CLAUDE] }) })));
		expect(wrongType.status).toBe(400); // a perfectly good registration, sent as the wrong type
		expect(await wrongType.json()).toMatchObject({ error: 'invalid_client_metadata', error_description: expect.stringMatching(/application\/json/) });
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_clients').get() as { n: number }).n).toBe(0);
		expect((await registerRoute(ev(new Request('http://x/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' })))).status).toBe(400);
		expect((await registerRoute(ev(new Request('http://x/oauth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ redirect_uris: [CLAUDE], pad: 'x'.repeat(20_000) }) })))).status).toBe(400);
	});
	it('limits how fast one address can register', async () => {
		for (let i = 0; i < 20; i++) expect((await postJson('http://x/oauth/register', { redirect_uris: [CLAUDE] }, '203.0.113.5')).status).toBe(201);
		const r = await postJson('http://x/oauth/register', { redirect_uris: [CLAUDE] }, '203.0.113.5');
		expect(r.status).toBe(429);
		expect(r.headers.get('retry-after')).toBeTruthy();
		expect((await postJson('http://x/oauth/register', { redirect_uris: [CLAUDE] }, '203.0.113.6')).status).toBe(201); // someone else is unaffected
	});
	it('caps the table: unused clients make room, clients with a sign-in are never evicted', () => {
		const first = newClient();
		approveFlowFor(first); // gives this client a grant
		for (let i = 0; i < MAX_CLIENTS + 10; i++) registerClient(`c${i}`, [CLAUDE]);
		const n = (db().prepare('SELECT COUNT(*) n FROM oauth_clients').get() as { n: number }).n;
		expect(n).toBeLessThanOrEqual(MAX_CLIENTS);
		expect(getClient(first.id)).toBeDefined(); // still there: it has a grant
	});
	it('says so when the table is full of clients in use', () => {
		for (let i = 0; i < MAX_CLIENTS; i++) {
			const c = registerClient(`c${i}`, [CLAUDE])!;
			db().prepare('INSERT INTO api_keys (name, prefix, hash, created_at) VALUES (?,?,?,?)').run(`k${i}`, 'osc_', `h${i}`, 1);
			const keyId = (db().prepare('SELECT id FROM api_keys WHERE hash = ?').get(`h${i}`) as { id: number }).id;
			db().prepare('INSERT INTO oauth_grants (client_id, key_id, refresh_hash, refresh_expires_at, created_at) VALUES (?,?,?,?,?)').run(c.id, keyId, `r${i}`, 9e15, 1);
		}
		expect(registerClient('one too many', [CLAUDE])).toBeNull();
	});
});

/** Gives an existing client a grant by running the code exchange for it. */
function approveFlowFor(client: { id: string }) {
	const chk = checkAuthorize(authorizeQuery(client.id), ORIGIN());
	if (chk.kind !== 'consent') throw new Error('no consent');
	const code = new URL(approveRequest(chk.requestId, null)!.location).searchParams.get('code')!;
	const r = redeemCode({ code, clientId: client.id, redirectUri: CLAUDE, verifier: VERIFIER });
	if (!r.ok) throw new Error(r.description);
	return r.body;
}

describe('the authorization request', () => {
	it('shows the consent page for a sound request, naming the app and where it will return', () => {
		const c = newClient();
		const r = loadOf(authorizeQuery(c.id));
		expect(r.data).toMatchObject({ clientName: 'Claude', redirectHost: 'claude.ai' });
		expect(r.data!.requestId.length).toBeGreaterThanOrEqual(30);
	});
	it('never redirects when the client or address cannot be trusted: it shows an error', () => {
		const c = newClient();
		for (const search of [authorizeQuery('ocl_unknown'), authorizeQuery(c.id, { redirect_uri: 'https://evil.example/cb' }), authorizeQuery(c.id, { redirect_uri: CLAUDE + '/' }), '?response_type=code', '', authorizeQuery(c.id) + '&state=again']) {
			const r = loadOf(search);
			expect(r.status, search).toBe(400);
			expect(r.location, search).toBeUndefined();
		}
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_requests').get() as { n: number }).n).toBe(0); // nothing was stored for any of them
	});
	it('sends problems with the request itself back to the client at its registered address', () => {
		const c = newClient();
		const cases: [Record<string, string>, string][] = [
			[{ response_type: 'token' }, 'unsupported_response_type'],
			[{ code_challenge_method: 'plain' }, 'invalid_request'],
			[{ code_challenge_method: '' }, 'invalid_request'],
			[{ code_challenge: 'short' }, 'invalid_request'],
			[{ code_challenge: '' }, 'invalid_request'],
			[{ resource: 'https://other.example/api/mcp' }, 'invalid_target'],
			[{ state: 'x'.repeat(600) }, 'invalid_request']
		];
		for (const [o, error] of cases) {
			const r = loadOf(authorizeQuery(c.id, o));
			expect(r.status, JSON.stringify(o)).toBe(303);
			const u = new URL(r.location!);
			expect(u.origin + u.pathname).toBe(CLAUDE);
			expect(u.searchParams.get('error'), JSON.stringify(o)).toBe(error);
			expect(u.searchParams.get('iss')).toBe(ORIGIN());
			if (!o.state) expect(u.searchParams.get('state'), JSON.stringify(o)).toBe('xyz'); // the client's own state is handed back with the error
		}
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_requests').get() as { n: number }).n).toBe(0);
	});
	it('accepts a loopback client on whatever port it uses now', () => {
		const c = registerClient('Claude Code', ['http://localhost:1111/callback'])!;
		expect(checkAuthorize(authorizeQuery(c.id, { redirect_uri: 'http://localhost:40123/callback' }), ORIGIN()).kind).toBe('consent');
		expect(checkAuthorize(authorizeQuery(c.id, { redirect_uri: 'http://localhost:40123/elsewhere' }), ORIGIN()).kind).toBe('error');
	});
	it('forgets requests that waited too long', () => {
		const c = newClient();
		const chk = checkAuthorize(authorizeQuery(c.id), ORIGIN(), 1_000);
		if (chk.kind !== 'consent') throw new Error('x');
		expect(approveRequest(chk.requestId, null, 1_000 + REQUEST_TTL_MS + 1)).toBeUndefined();
	});
});

describe('approving or declining', () => {
	it('approval returns a code and the client\'s own state, and a request can be decided only once', () => {
		const c = newClient();
		const chk = checkAuthorize(authorizeQuery(c.id), ORIGIN());
		if (chk.kind !== 'consent') throw new Error('x');
		const ok = approveRequest(chk.requestId, null)!;
		const u = new URL(ok.location);
		expect(u.origin + u.pathname).toBe(CLAUDE);
		expect(u.searchParams.get('code')!.length).toBeGreaterThanOrEqual(40);
		expect(u.searchParams.get('state')).toBe('xyz');
		expect(u.searchParams.get('iss')).toBe(ORIGIN());
		expect(approveRequest(chk.requestId, null)).toBeUndefined(); // replayed
		expect(denyRequest(chk.requestId)).toBeUndefined();
		expect(approveRequest('made-up-id', null)).toBeUndefined();
	});
	it('declining tells the client no, with its state, and issues nothing', () => {
		const c = newClient();
		const chk = checkAuthorize(authorizeQuery(c.id), ORIGIN());
		if (chk.kind !== 'consent') throw new Error('x');
		const u = new URL(denyRequest(chk.requestId)!.location);
		expect(u.searchParams.get('error')).toBe('access_denied');
		expect(u.searchParams.get('state')).toBe('xyz');
		expect(u.searchParams.has('code')).toBe(false);
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_codes').get() as { n: number }).n).toBe(0);
	});
	it('only a hash of the code is stored', () => {
		const f = approveFlow();
		const rows = db().prepare('SELECT hash FROM oauth_codes').all() as { hash: string }[];
		expect(rows).toHaveLength(1);
		expect(rows[0].hash).not.toContain(f.code);
		expect(rows[0].hash).toMatch(/^[0-9a-f]{64}$/);
	});
	it('through the page: choosing sites keeps only real ones, and an empty choice is refused without spending the request', async () => {
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const c = newClient();
		const { data } = loadOf(authorizeQuery(c.id));
		const id = data!.requestId;
		const real = data!.sites.map((s) => s.id);
		expect(real.length).toBeGreaterThan(1);
		const empty = (await act('allow', { request_id: id, scope: 'selected', site: ['9999', 'abc'] })) as { status?: number; data?: { error?: string } };
		expect(empty.status).toBe(400);
		expect(empty.data?.error).toMatch(/at least one site/);
		const ok = await act('allow', { request_id: id, scope: 'selected', site: [String(real[0]), '9999'] });
		const code = new URL(ok.redirect!).searchParams.get('code')!;
		const t = await exchange(c, code);
		const token = t.json.access_token as string;
		expect(authenticate(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))!.scope).toEqual([real[0]]); // unknown ids dropped
	});
	it('through the page: "all sites" gives an unrestricted token; an expired or reused request says so', async () => {
		const c = newClient();
		const { data } = loadOf(authorizeQuery(c.id));
		const ok = await act('allow', { request_id: data!.requestId, scope: 'all' });
		const code = new URL(ok.redirect!).searchParams.get('code')!;
		const t = await exchange(c, code);
		expect(authenticate(new Request('http://x', { headers: { authorization: `Bearer ${t.json.access_token}` } }))!.scope).toBeNull();
		const again = (await act('allow', { request_id: data!.requestId, scope: 'all' })) as { status?: number; data?: { error?: string } };
		expect(again.status).toBe(400);
		expect(again.data?.error).toMatch(/expired or was already used/);
		const deny = (await act('deny', { request_id: 'nope' })) as { status?: number };
		expect(deny.status).toBe(400);
	});
	it('declining through the page hands back access_denied', async () => {
		const c = newClient();
		const { data } = loadOf(authorizeQuery(c.id));
		const r = await act('deny', { request_id: data!.requestId });
		expect(new URL(r.redirect!).searchParams.get('error')).toBe('access_denied');
	});
});

describe('POST /oauth/token: the code exchange', () => {
	it('gives an access token that works on the MCP endpoint, a refresh token, and never allows caching', async () => {
		const f = approveFlow();
		const t = await exchange(f.client, f.code);
		expect(t.status).toBe(200);
		expect(t.headers.get('cache-control')).toBe('no-store');
		expect(t.headers.get('pragma')).toBe('no-cache');
		expect(t.json).toMatchObject({ token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, scope: 'mcp' });
		expect(String(t.json.access_token)).toMatch(/^osc_/);
		expect(String(t.json.refresh_token)).toMatch(/^ocr_/);
		expect((await mcpInit(String(t.json.access_token))).status).toBe(200);
		expect(oauthLabels().size).toBe(1);
		expect([...oauthLabels().values()]).toEqual(['Claude']);
	});
	it('a code works once; using it again fails and takes back the token the first use produced', async () => {
		const f = approveFlow();
		const first = await exchange(f.client, f.code);
		expect((await mcpInit(String(first.json.access_token))).status).toBe(200);
		const again = await exchange(f.client, f.code);
		expect(again.status).toBe(400);
		expect(again.json.error).toBe('invalid_grant');
		expect((await mcpInit(String(first.json.access_token))).status).toBe(401); // revoked
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_grants').get() as { n: number }).n).toBe(0);
	});
	it('refuses a wrong verifier, a missing one, a malformed one, and burns the code', async () => {
		for (const verifier of ['x'.repeat(50), '', 'short']) {
			const f = approveFlow();
			const bad = await exchange(f.client, f.code, { code_verifier: verifier });
			expect(bad.status, verifier).toBe(400);
			expect(bad.json.error).toBe(verifier ? 'invalid_grant' : 'invalid_request');
			if (verifier) expect((await exchange(f.client, f.code)).json.error).toBe('invalid_grant'); // the right verifier no longer helps: the code is spent
		}
	});
	it('refuses a code presented by another app or for another address', async () => {
		const f = approveFlow();
		const other = newClient();
		expect((await exchange(other, f.code)).json.error).toBe('invalid_grant');
		const g = approveFlow();
		expect((await exchange(g.client, g.code, { redirect_uri: 'https://claude.ai/api/mcp/auth_callback/' })).json.error).toBe('invalid_grant');
	});
	it('refuses an expired code, and one that never existed', async () => {
		const f = approveFlow(null, 5_000);
		const late = redeemCode({ code: f.code, clientId: f.client.id, redirectUri: CLAUDE, verifier: VERIFIER }, 5_000 + CODE_TTL_MS + 1);
		expect(late).toMatchObject({ ok: false, error: 'invalid_grant' });
		expect((await exchange(f.client, 'a'.repeat(43))).json.error).toBe('invalid_grant');
	});
	it('wants a form body with each parameter once', async () => {
		const f = approveFlow();
		expect((await tokenPost({ grant_type: 'authorization_code', code: f.code, client_id: f.client.id }, undefined, 'application/json')).json.error).toBe('invalid_request');
		const dup = await tokenRoute(ev(new Request('http://x/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `grant_type=authorization_code&grant_type=refresh_token&code=${f.code}` })));
		expect(dup.status).toBe(400);
		expect(await dup.json()).toMatchObject({ error: 'invalid_request', error_description: expect.stringMatching(/repeated/) });
		const big = await tokenRoute(ev(new Request('http://x/oauth/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'a=' + 'x'.repeat(5000) })));
		expect(big.status).toBe(400);
		expect(await big.json()).toMatchObject({ error: 'invalid_request', error_description: expect.stringMatching(/too large/) });
		expect((await tokenPost({ grant_type: 'password', username: 'a', password: 'b' })).json.error).toBe('unsupported_grant_type');
		expect((await tokenPost({ grant_type: 'client_credentials' })).json.error).toBe('unsupported_grant_type');
		expect((await tokenPost({})).json.error).toBe('unsupported_grant_type');
	});
	it('is rate limited per address', async () => {
		let last = 0;
		for (let i = 0; i < 125; i++) last = (await tokenPost({ grant_type: 'authorization_code' }, '203.0.113.50')).status;
		expect(last).toBe(429);
		expect((await tokenPost({ grant_type: 'authorization_code' }, '203.0.113.51')).status).toBe(400);
	});
});

describe('refresh tokens', () => {
	it('swap for a new pair, and the old access token and the old refresh token both stop working', async () => {
		const f = approveFlow();
		const t1 = (await exchange(f.client, f.code)).json as { access_token: string; refresh_token: string };
		const r = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: f.client.id });
		expect(r.status).toBe(200);
		const t2 = r.json as { access_token: string; refresh_token: string };
		expect(t2.access_token).not.toBe(t1.access_token);
		expect(t2.refresh_token).not.toBe(t1.refresh_token);
		expect((await mcpInit(t1.access_token)).status).toBe(401);
		expect((await mcpInit(t2.access_token)).status).toBe(200);
		expect((db().prepare('SELECT COUNT(*) n FROM api_keys').get() as { n: number }).n).toBe(1); // rotated in place: one row, not a pile
	});
	it('reusing a superseded refresh token revokes the whole grant, including the newest tokens', async () => {
		const f = approveFlow();
		const t1 = (await exchange(f.client, f.code)).json as { refresh_token: string };
		const t2 = (await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: f.client.id })).json as { access_token: string; refresh_token: string };
		const replay = await tokenPost({ grant_type: 'refresh_token', refresh_token: t1.refresh_token, client_id: f.client.id });
		expect(replay.status).toBe(400);
		expect(replay.json.error).toBe('invalid_grant');
		expect((await mcpInit(t2.access_token)).status).toBe(401);
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t2.refresh_token, client_id: f.client.id })).json.error).toBe('invalid_grant');
	});
	it('refuses another app, a made-up token and missing fields', async () => {
		const f = approveFlow();
		const t = (await exchange(f.client, f.code)).json as { refresh_token: string };
		const other = newClient();
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: other.id })).json.error).toBe('invalid_grant');
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: 'ocr_' + 'a'.repeat(43), client_id: f.client.id })).json.error).toBe('invalid_grant');
		expect((await tokenPost({ grant_type: 'refresh_token', client_id: f.client.id })).json.error).toBe('invalid_request');
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh_token })).json.error).toBe('invalid_request');
		// the failed attempts by others did not disturb the real grant
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.client.id })).status).toBe(200);
	});
	it('expire after sixty unused days, and take the grant with them', () => {
		const f = approveFlow(null, 1_000);
		const t = redeemCode({ code: f.code, clientId: f.client.id, redirectUri: CLAUDE, verifier: VERIFIER }, 2_000);
		if (!t.ok) throw new Error('x');
		const late = refreshTokens({ refreshToken: t.body.refresh_token, clientId: f.client.id }, 2_000 + REFRESH_TTL_MS + 1);
		expect(late).toMatchObject({ ok: false, error: 'invalid_grant' });
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_grants').get() as { n: number }).n).toBe(0);
	});
	it('use pushes the expiry out, so an app in regular use stays signed in', () => {
		const f = approveFlow(null, 1_000);
		const t = redeemCode({ code: f.code, clientId: f.client.id, redirectUri: CLAUDE, verifier: VERIFIER }, 1_000);
		if (!t.ok) throw new Error('x');
		const half = 1_000 + REFRESH_TTL_MS / 2;
		const r2 = refreshTokens({ refreshToken: t.body.refresh_token, clientId: f.client.id }, half);
		if (!r2.ok) throw new Error('x');
		expect(refreshTokens({ refreshToken: r2.body.refresh_token, clientId: f.client.id }, 1_000 + REFRESH_TTL_MS + 5_000).ok).toBe(true); // past the first expiry, inside the extended one
	});
});

describe('access tokens', () => {
	it('stop working when they expire, and the endpoint says invalid_token so the app refreshes', async () => {
		const f = approveFlow(null, 1_000);
		const t = redeemCode({ code: f.code, clientId: f.client.id, redirectUri: CLAUDE, verifier: VERIFIER }, 1_000);
		if (!t.ok) throw new Error('x');
		const req = new Request('http://x', { headers: { authorization: `Bearer ${t.body.access_token}` } });
		expect(authenticate(req, 1_000 + ACCESS_TTL_MS - 1)).toBeDefined();
		expect(authenticate(req, 1_000 + ACCESS_TTL_MS)).toBeUndefined();
		db().prepare('UPDATE api_keys SET expires_at = 1').run();
		const r = await mcpInit(t.body.access_token);
		expect(r.status).toBe(401);
		expect(r.headers.get('www-authenticate')).toMatch(/invalid_token/);
	});
	it('keys made by hand never expire', () => {
		const k = createApiKey('mine', null);
		expect(authenticate(new Request('http://x', { headers: { 'x-api-key': k.key } }), Date.now() + 10 * 365 * 86_400_000)).toBeDefined();
	});
	it('revoking the key on the Agents page revokes the sign-in: its refresh token stops too', async () => {
		const f = approveFlow();
		const t = (await exchange(f.client, f.code)).json as { access_token: string; refresh_token: string };
		const keyId = (db().prepare('SELECT key_id FROM oauth_grants').get() as { key_id: number }).key_id;
		deleteApiKey(keyId);
		expect((await mcpInit(t.access_token)).status).toBe(401);
		expect((await tokenPost({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: f.client.id })).json.error).toBe('invalid_grant');
		expect((db().prepare('SELECT COUNT(*) n FROM oauth_grants').get() as { n: number }).n).toBe(0);
	});
	it('only a hash of each token is stored', async () => {
		const f = approveFlow();
		const t = (await exchange(f.client, f.code)).json as { access_token: string; refresh_token: string };
		const all = JSON.stringify([db().prepare('SELECT * FROM api_keys').all(), db().prepare('SELECT * FROM oauth_grants').all(), db().prepare('SELECT * FROM oauth_codes').all()]);
		expect(all).not.toContain(t.access_token);
		expect(all).not.toContain(t.refresh_token);
		expect(all).not.toContain(f.code);
	});
});

describe('the limiter', () => {
	it('counts per key within a window and starts over after it', () => {
		for (let i = 0; i < 3; i++) expect(withinLimit('t', 'a', 3, 1000, 100)).toBe(true);
		expect(withinLimit('t', 'a', 3, 1000, 100)).toBe(false);
		expect(withinLimit('t', 'b', 3, 1000, 100)).toBe(true);
		expect(withinLimit('t', 'a', 3, 1000, 1200)).toBe(true);
	});
});

describe('the request gate and the login return path', () => {
	const gev = (path: string, o: { method?: string; cookie?: string; origin?: string; search?: string } = {}) => {
		const url = new URL(`http://localhost:5173${path}${o.search ?? ''}`);
		const jar = new Map<string, string>(o.cookie ? [['osc_session', o.cookie]] : []);
		return {
			url, request: new Request(url, { method: o.method ?? 'GET', headers: { host: 'localhost:5173', ...(o.origin ? { origin: o.origin } : {}) } }), locals: {} as Record<string, unknown>,
			cookies: { get: (k: string) => jar.get(k) }, getClientAddress: () => '127.0.0.1'
		};
	};
	const run = (e: ReturnType<typeof gev>) => handle({ event: e as never, resolve: (async () => new Response('page')) as never });
	it('the discovery documents, registration and token endpoints work without a login: programs call them', async () => {
		for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/api/mcp']) expect((await run(gev(p))).status, p).toBe(200);
		expect((await run(gev('/oauth/register', { method: 'POST' }))).status).toBe(200);
		expect((await run(gev('/oauth/token', { method: 'POST' }))).status).toBe(200);
	});
	it('those two endpoints accept calls with a foreign Origin (they carry no cookie); every other POST still does not', async () => {
		const evil = 'https://evil.example';
		expect((await run(gev('/oauth/token', { method: 'POST', origin: evil }))).status).toBe(200);
		expect((await run(gev('/oauth/register', { method: 'POST', origin: evil }))).status).toBe(200);
		expect((await run(gev('/oauth/authorize', { method: 'POST', origin: evil, cookie: createSession().id }))).status).toBe(403); // approving from another site is refused
		expect((await run(gev('/accounts', { method: 'POST', origin: evil, cookie: createSession().id }))).status).toBe(403);
	});
	it('the authorization page needs the owner: no session goes to sign-in and comes back to exactly that request', async () => {
		const r = await run(gev('/oauth/authorize', { search: '?client_id=a&state=b' }));
		expect(r.status).toBe(303);
		expect(r.headers.get('location')).toBe('/login?next=%2Foauth%2Fauthorize%3Fclient_id%3Da%26state%3Db');
		expect((await run(gev('/oauth/authorize', { search: '?client_id=a', cookie: createSession().id }))).status).toBe(200);
		expect((await run(gev('/oauth/authorize', { method: 'POST' }))).headers.get('location')).toBe('/login'); // a POST is not bounced back to
		expect((await run(gev('/accounts'))).headers.get('location')).toBe('/login'); // other pages are unchanged
	});
	it('after signing in, the owner returns to the request, and cannot be sent anywhere else', async () => {
		const back = (next: string | null) => {
			const url = new URL('http://localhost:5173/login' + (next == null ? '' : `?next=${encodeURIComponent(next)}`));
			try {
				loginPage.load({ locals: { authed: true }, url } as never);
			} catch (e) {
				return (e as { location: string }).location;
			}
			return 'no redirect';
		};
		expect(back('/oauth/authorize?client_id=a&state=b')).toBe('/oauth/authorize?client_id=a&state=b');
		for (const bad of ['https://evil.example/', '//evil.example', '/accounts', 'javascript:alert(1)', null]) expect(back(bad), String(bad)).toBe('/');
	});
});

describe('the cross-site check (it replaces SvelteKit\'s own, which cannot exempt the server-to-server endpoints)', () => {
	const base = { method: 'POST', origin: null as string | null, secFetchSite: null as string | null, contentType: null as string | null, urlOrigin: 'https://s.example', programEndpoint: false };
	const refused = (o: Partial<typeof base>) => crossSiteRefused({ ...base, ...o });
	it('never refuses a read', () => {
		for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) expect(refused({ method, origin: 'https://evil.example', secFetchSite: 'cross-site' }), method).toBe(false);
	});
	it('refuses a request from another origin, however it is sent', () => {
		for (const o of ['https://evil.example', 'null', 'https://s.example.evil.example', 'http://s.example']) {
			expect(refused({ origin: o }), o).toBe(true);
			expect(refused({ origin: o, contentType: 'application/json' }), o).toBe(true);
		}
		expect(refused({ secFetchSite: 'cross-site' })).toBe(true);
		expect(refused({ origin: 'https://s.example', secFetchSite: 'cross-site' })).toBe(true);
	});
	it('refuses a form-type POST with no Origin, as SvelteKit did; allows it from this origin', () => {
		for (const ct of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'text/plain', 'Application/X-WWW-Form-Urlencoded; charset=UTF-8']) {
			expect(refused({ contentType: ct }), ct).toBe(true);
			expect(refused({ contentType: ct, origin: 'https://s.example' }), ct).toBe(false);
		}
		for (const method of ['PUT', 'PATCH', 'DELETE']) expect(refused({ method, contentType: 'application/x-www-form-urlencoded' }), method).toBe(true);
	});
	it('lets programs through: JSON or bare requests with no browser headers, and the same origin', () => {
		expect(refused({ contentType: 'application/json' })).toBe(false);
		expect(refused({})).toBe(false);
		expect(refused({ origin: 'https://s.example', secFetchSite: 'same-origin' })).toBe(false);
		expect(refused({ secFetchSite: 'same-site' })).toBe(false);
	});
	it('exempts the server-to-server endpoints completely, form body and foreign origin included', () => {
		expect(refused({ programEndpoint: true, contentType: 'application/x-www-form-urlencoded' })).toBe(false);
		expect(refused({ programEndpoint: true, origin: 'https://evil.example', secFetchSite: 'cross-site', contentType: 'application/x-www-form-urlencoded' })).toBe(false);
	});
	it('is applied by the gate, with SvelteKit\'s own check switched off in step with it', async () => {
		const gev = (path: string, o: { origin?: string; type?: string; cookie?: string } = {}) => {
			const url = new URL(`http://localhost:5173${path}`);
			const jar = new Map<string, string>(o.cookie ? [['osc_session', o.cookie]] : []);
			return { url, request: new Request(url, { method: 'POST', headers: { host: 'localhost:5173', ...(o.origin ? { origin: o.origin } : {}), ...(o.type ? { 'content-type': o.type } : {}) } }), locals: {} as Record<string, unknown>, cookies: { get: (k: string) => jar.get(k) }, getClientAddress: () => '127.0.0.1' };
		};
		const run = (e: ReturnType<typeof gev>) => handle({ event: e as never, resolve: (async () => new Response('page')) as never });
		const sid = createSession().id, form = 'application/x-www-form-urlencoded';
		expect((await run(gev('/accounts', { type: form, cookie: sid }))).status).toBe(403); // a bare form POST, no Origin
		expect((await run(gev('/accounts', { type: form, cookie: sid, origin: 'http://localhost:5173' }))).status).toBe(200);
		expect((await run(gev('/oauth/token', { type: form }))).status).toBe(200); // the token request of a connector's server
		expect((await run(gev('/oauth/register', { type: 'application/json' }))).status).toBe(200);
		expect(readFileSync('svelte.config.js', 'utf8')).toMatch(/csrf: \{ trustedOrigins: \['\*'\] \}/);
		expect(readFileSync('src/hooks.server.ts', 'utf8')).toMatch(/crossSiteRefused\(\{/);
	});
});

describe('sign-in and the submit permission', () => {
	const signIn = (allowSubmit?: boolean) => {
		const c = newClient();
		const chk = checkAuthorize(authorizeQuery(c.id), ORIGIN());
		if (chk.kind !== 'consent') throw new Error('no consent');
		const code = new URL(approveRequest(chk.requestId, null, Date.now(), allowSubmit)!.location).searchParams.get('code')!;
		const r = redeemCode({ code, clientId: c.id, redirectUri: CLAUDE, verifier: VERIFIER });
		if (!r.ok) throw new Error(r.description);
		return { ...(r.body as { access_token: string; refresh_token: string }), clientId: c.id };
	};
	const permissionOf = (token: string) => authenticate(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))?.permission;

	it('an approved app is read-only unless the owner ticked "allow submitting", and a refresh keeps whatever was granted', () => {
		const plain = signIn();
		expect(permissionOf(plain.access_token)).toBe('read');
		const granted = signIn(true);
		expect(permissionOf(granted.access_token)).toBe('submit');
		const next = refreshTokens({ refreshToken: granted.refresh_token, clientId: granted.clientId });
		if (!next.ok) throw new Error(next.description);
		expect(permissionOf((next.body as { access_token: string }).access_token)).toBe('submit');
		expect(permissionOf(plain.access_token)).toBe('read'); // the other app is untouched
	});

	it('the consent page asks for submitting separately and is off by default; the server cannot grant it in READ_ONLY mode', async () => {
		const svelte = readFileSync('src/routes/oauth/authorize/+page.svelte', 'utf8');
		expect(svelte).toMatch(/name="submit" value="1"/);
		expect(svelte).not.toMatch(/name="submit"[^>]*checked/);
		expect(readFileSync('src/routes/oauth/authorize/+page.server.ts', 'utf8')).toMatch(/f\.get\('submit'\) === '1' && !config\.readOnly/);
	});
});
