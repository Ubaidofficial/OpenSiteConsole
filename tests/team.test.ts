import { beforeEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { db, openDb } from '../src/lib/server/db';
import { handle } from '../src/hooks.server';
import { createSession, endSession, sessionUser, validSession } from '../src/lib/server/sessions';
import { hashPassword } from '../src/lib/server/password';
import { forgetSite } from '../src/lib/server/apikeys';
import { inviteLimiter, loginLimiter } from '../src/lib/server/attempts';
import { ENDPOINTS, FORM_ACTIONS, OWNER, accessRefusal, actionNameOf, hasRole, requiredRole, routeOf, type CurrentUser } from '../src/lib/server/roles';
import {
	acceptInvite, checkLogin, createInvite, findInvite, INVITE_DAYS, listPendingInvites, removeUser, revokeInvite, setUserDisabled, setUserRole, setUserSites, TeamError
} from '../src/lib/server/users';
import * as loginPage from '../src/routes/login/+page.server';
import * as invitePage from '../src/routes/invite/[token]/+page.server';
import * as teamPage from '../src/routes/team/+page.server';
import { load as dashboardLoad } from '../src/routes/+page.server';
import { load as layoutLoad } from '../src/routes/+layout.server';

const OWNER_PW = 'owner-password-for-team-tests';
const DAY = 86_400_000;

function fresh() {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.ADMIN_PASSWORD = OWNER_PW;
	delete process.env.ADMIN_PASSWORD_HASH;
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
	delete process.env.READ_ONLY;
	loginLimiter.reset();
	inviteLimiter.reset();
}

/** A member made directly, as an accepted invite would. */
function member(email: string, role: 'admin' | 'editor' | 'viewer', o: { password?: string; siteIds?: number[] | null; disabled?: boolean } = {}): number {
	const r = db()
		.prepare('INSERT INTO users (email, name, password_hash, role, site_ids, created_at, disabled) VALUES (?,?,?,?,?,?,?)')
		.run(email, email.split('@')[0], hashPassword(o.password ?? 'member-password-1'), role, o.siteIds ? JSON.stringify(o.siteIds) : null, Date.now(), o.disabled ? 1 : 0);
	return Number(r.lastInsertRowid);
}
const asUser = (id: number): CurrentUser => {
	const u = db().prepare('SELECT id, email, name, role, site_ids FROM users WHERE id = ?').get(id) as { id: number; email: string; name: string; role: 'admin'; site_ids: string | null };
	return { id: u.id, email: u.email, name: u.name, role: u.role, siteIds: u.site_ids ? JSON.parse(u.site_ids) : null };
};
const count = (sql: string, ...args: unknown[]) => (db().prepare(sql).get(...args) as { n: number }).n;

// ───────────────────────────── the permission table covers every route ─────────────────────────────
describe('every state-changing route is classified', () => {
	const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
	const routeFiles = walk('src/routes');
	const routeOfFile = (f: string) => '/' + f.replace(/^src\/routes\/?/, '').replace(/\/?\+(page|layout)\.server\.ts$|\/?\+server\.ts$/, '').replace(/^\/+/, '');
	const actionNames = (src: string) => {
		const start = src.indexOf('export const actions');
		if (start < 0) return [];
		const body = src.slice(start, src.indexOf('\n};', start));
		return [...body.matchAll(/^\t(?:async\s+)?([A-Za-z_]\w*)\s*(?::|\()/gm)].map((m) => m[1]);
	};
	// Pages whose actions run for someone who is not signed in yet: they are public, and carry their own attempt limits.
	const PUBLIC_ACTION_ROUTES = new Set(['/login', '/invite/[token]', '/reset/[token]']);
	// Endpoints for programs, not browsers; each authenticates with its own credential (API key, client registration, PKCE).
	const PROGRAM_ENDPOINTS = new Set(['POST /api/mcp', 'POST /api/v1/[...path]', 'POST /oauth/register', 'POST /oauth/token']);

	it('each form action in src/routes has a role in FORM_ACTIONS, and FORM_ACTIONS lists nothing that does not exist', () => {
		const found = new Map<string, string[]>();
		for (const f of routeFiles.filter((f) => f.endsWith('+page.server.ts'))) {
			const names = actionNames(readFileSync(f, 'utf8'));
			if (names.length) found.set(routeOfFile(f), names);
		}
		expect(found.size).toBeGreaterThan(15);
		for (const [route, names] of found) {
			if (PUBLIC_ACTION_ROUTES.has(route)) continue;
			expect(FORM_ACTIONS[route], route).toBeDefined();
			expect(Object.keys(FORM_ACTIONS[route]).sort(), route).toEqual([...names].sort());
		}
		for (const route of Object.keys(FORM_ACTIONS)) expect(found.has(route), `stale entry ${route}`).toBe(true);
	});
	it('each +server endpoint that accepts a change is in ENDPOINTS or is a program endpoint', () => {
		for (const f of routeFiles.filter((f) => f.endsWith('+server.ts'))) {
			const src = readFileSync(f, 'utf8');
			for (const m of src.matchAll(/export (?:const|async function|function) (POST|PUT|PATCH|DELETE)\b/g)) {
				const key = `${m[1]} ${routeOfFile(f)}`;
				expect(Object.hasOwn(ENDPOINTS, key) || PROGRAM_ENDPOINTS.has(key), key).toBe(true);
			}
		}
	});
	it('starting or finishing an account connection (GET endpoints that change things) needs admin', () => {
		for (const f of ['src/routes/auth/connect/+server.ts', 'src/routes/auth/callback/+server.ts', 'src/routes/auth/bing/connect/+server.ts', 'src/routes/auth/bing/callback/+server.ts']) {
			expect(existsSync(f), f).toBe(true);
			expect(ENDPOINTS[`GET ${routeOfFile(f)}`], f).toBe('admin');
		}
	});
	it('works out routes and action names exactly as SvelteKit does, and fails closed on anything unknown', () => {
		const u = (p: string) => new URL(`http://localhost:5173${p}`);
		expect(routeOf('/sites/12/settings/')).toBe('/sites/[id]/settings');
		expect(routeOf('/sites/12/__data.json')).toBe('/sites/[id]');
		expect(routeOf('/__data.json')).toBe('/');
		expect(actionNameOf(u('/team?x=1&/invite&/role'))).toBe('invite');
		expect(actionNameOf(u('/login'))).toBe('default');
		expect(requiredRole('POST', u('/sites/3?/addNote'))).toBe('editor');
		expect(requiredRole('POST', u('/sites/3/settings?/save'))).toBe('admin');
		expect(requiredRole('GET', u('/agents'))).toBe('viewer');
		expect(requiredRole('HEAD', u('/auth/connect'))).toBe('admin');
		for (const odd of ['/sites/3?/constructor', '/sites/3?/__proto__', '/sites/3?/toString', '/sites/3?/nope', '/nowhere', '/sites/3', '/%61ccounts?/remove']) expect(requiredRole('POST', u(odd)), odd).toBe('admin');
		for (const m of ['PUT', 'PATCH', 'DELETE']) expect(requiredRole(m, u('/sites/3/sync'))).toBe('admin');
		expect(hasRole('editor', 'viewer')).toBe(true);
		expect(hasRole('viewer', 'editor')).toBe(false);
		expect(hasRole('constructor' as never, 'viewer')).toBe(false);
		expect(hasRole(null, 'viewer')).toBe(false);
	});
});

// ───────────────────────────── invites ─────────────────────────────
describe('invites', () => {
	beforeEach(fresh);

	it('store only a hash of the token, never the token itself', () => {
		const inv = createInvite({ email: 'Writer@Example.com', role: 'editor', actor: OWNER });
		expect(inv.token).toMatch(/^osci_[A-Za-z0-9_-]{43}$/);
		expect(inv.email).toBe('writer@example.com');
		const row = db().prepare('SELECT * FROM invites WHERE id = ?').get(inv.id) as Record<string, unknown>;
		expect(JSON.stringify(row)).not.toContain(inv.token);
		expect(JSON.stringify(row)).not.toContain(inv.token.slice(5));
		expect(row.token_hash).toBe(createHash('sha256').update(inv.token).digest('hex'));
		expect(findInvite(inv.token)?.email).toBe('writer@example.com');
	});
	it('are single-use: the second acceptance fails and no second account appears', () => {
		const inv = createInvite({ email: 'a@example.com', role: 'viewer' });
		const u = acceptInvite(inv.token, { name: 'Ada', password: 'long-enough-pw' });
		expect(u).toMatchObject({ email: 'a@example.com', name: 'Ada', role: 'viewer', disabled: 0 });
		expect(findInvite(inv.token)).toBeUndefined();
		expect(() => acceptInvite(inv.token, { name: 'Mallory', password: 'another-password' })).toThrow(TeamError);
		expect(count('SELECT COUNT(*) n FROM users')).toBe(1);
		expect(listPendingInvites()).toHaveLength(0);
	});
	it('expire after seven days', () => {
		const t0 = Date.now();
		const inv = createInvite({ email: 'b@example.com', role: 'editor' }, t0);
		expect(inv.expiresAt).toBe(t0 + INVITE_DAYS * DAY);
		expect(INVITE_DAYS).toBe(7);
		expect(findInvite(inv.token, t0 + 7 * DAY - 1000)).toBeDefined();
		expect(findInvite(inv.token, t0 + 7 * DAY)).toBeUndefined();
		expect(() => acceptInvite(inv.token, { name: 'Late', password: 'long-enough-pw' }, t0 + 8 * DAY)).toThrow(/expired/);
		expect(count('SELECT COUNT(*) n FROM users')).toBe(0);
	});
	it('can be revoked, and a new invite for the same address replaces the old link', () => {
		const one = createInvite({ email: 'c@example.com', role: 'editor' });
		const two = createInvite({ email: 'c@example.com', role: 'viewer' });
		expect(findInvite(one.token)).toBeUndefined();
		expect(findInvite(two.token)?.role).toBe('viewer');
		expect(revokeInvite(two.id, OWNER)).toBe(true);
		expect(revokeInvite(two.id, OWNER)).toBe(false);
		expect(() => acceptInvite(two.token, { name: 'C', password: 'long-enough-pw' })).toThrow(TeamError);
	});
	it('refuse forged, truncated and look-alike tokens, weak passwords and missing names', () => {
		const inv = createInvite({ email: 'd@example.com', role: 'editor' });
		for (const bad of ['', 'osci_', inv.token.slice(0, -1), inv.token + 'x', inv.token.replace('osci_', 'osck_'), inv.token.toUpperCase(), "osci_' OR 1=1 --" + 'x'.repeat(40)]) expect(findInvite(bad), bad).toBeUndefined();
		expect(() => acceptInvite(inv.token, { name: 'D', password: '123456789' })).toThrow(/at least 10/);
		expect(() => acceptInvite(inv.token, { name: '   ', password: 'long-enough-pw' })).toThrow(/name/);
		expect(findInvite(inv.token)).toBeDefined(); // a refused attempt does not use the link up
		expect(acceptInvite(inv.token, { name: 'D', password: '0123456789' }).role).toBe('editor');
	});
	it('cannot be made for someone already on the team, or with a role that does not exist (the owner role cannot be handed out)', () => {
		member('e@example.com', 'viewer');
		expect(() => createInvite({ email: 'E@example.com', role: 'editor' })).toThrow(/already on the team/);
		for (const role of ['owner', 'root', '', null]) expect(() => createInvite({ email: 'f@example.com', role }), String(role)).toThrow(TeamError);
		expect(() => createInvite({ email: 'not-an-email', role: 'viewer' })).toThrow(/email/);
	});
	it('admins are never limited to some sites; editors and viewers can be', () => {
		const a = createInvite({ email: 'adm@example.com', role: 'admin', siteIds: [1, 2] });
		const v = createInvite({ email: 'v@example.com', role: 'viewer', siteIds: [2, 2, 1] });
		expect(findInvite(a.token)?.site_ids).toBeNull();
		expect(findInvite(v.token)?.site_ids).toBe('[1,2]');
		expect(acceptInvite(v.token, { name: 'V', password: 'long-enough-pw' }).site_ids).toBe('[1,2]');
	});
	it('the invite page counts bad links per visitor and refuses after ten', () => {
		const ev = (token: string, ip = '203.0.113.5') => ({ params: { token }, getClientAddress: () => ip, locals: { user: null } }) as never;
		for (let i = 0; i < 10; i++) expect((invitePage.load(ev('osci_' + 'x'.repeat(43))) as { valid: boolean }).valid).toBe(false);
		const good = createInvite({ email: 'g@example.com', role: 'viewer' });
		expect(() => invitePage.load(ev(good.token))).toThrow(); // 429, even for a good link, until the window ends
		expect((invitePage.load(ev(good.token, '203.0.113.6')) as { valid: boolean }).valid).toBe(true); // another visitor is unaffected
	});
	it('accepting through the page signs the new member in with the same cookie settings as the owner\'s', async () => {
		const inv = createInvite({ email: 'h@example.com', role: 'editor' });
		const set: { name: string; value: string; opts: Record<string, unknown> }[] = [];
		const cookies = { get: () => undefined, set: (name: string, value: string, opts: Record<string, unknown>) => set.push({ name, value, opts }), delete: () => {} };
		const request = new Request('https://s.example/invite/x', { method: 'POST', body: new URLSearchParams({ name: 'Hana', password: 'long-enough-pw' }) });
		let location = '';
		try {
			await invitePage.actions.default({ params: { token: inv.token }, request, cookies, getClientAddress: () => '198.51.100.1', url: new URL('https://s.example/invite/x') } as never);
		} catch (e) {
			location = (e as { location: string }).location;
		}
		expect(location).toBe('/');
		expect(set).toHaveLength(1);
		expect(set[0].opts).toMatchObject({ path: '/', httpOnly: true, sameSite: 'lax', secure: true });
		expect(sessionUser(set[0].value)).toMatchObject({ email: 'h@example.com', role: 'editor', siteIds: null });
	});
});

// ───────────────────────────── signing in ─────────────────────────────
describe('signing in', () => {
	beforeEach(fresh);

	it('the owner password still works, with the email left empty or with anything in it', () => {
		expect(checkLogin('', OWNER_PW)).toEqual({ kind: 'owner' });
		expect(checkLogin('someone@example.com', OWNER_PW)).toEqual({ kind: 'owner' });
		expect(checkLogin('', 'wrong')).toBeNull();
		process.env.ADMIN_PASSWORD_HASH = hashPassword('hashed-owner-password');
		expect(checkLogin('', 'hashed-owner-password')).toEqual({ kind: 'owner' });
	});
	it('a member signs in with email and password; email case does not matter; last sign-in is recorded', () => {
		const id = member('m@example.com', 'editor', { password: 'member-password-1' });
		const r = checkLogin(' M@Example.com ', 'member-password-1');
		expect(r?.kind).toBe('member');
		expect(r?.kind === 'member' && r.user.id).toBe(id);
		expect((db().prepare('SELECT last_login_at FROM users WHERE id = ?').get(id) as { last_login_at: number }).last_login_at).toBeGreaterThan(0);
	});
	it('a disabled member cannot sign in, and disabling ends their sessions at once', () => {
		const id = member('d@example.com', 'editor', { password: 'member-password-1' });
		const s = createSession(Date.now(), id);
		expect(sessionUser(s.id)?.role).toBe('editor');
		setUserDisabled(id, true, OWNER);
		expect(checkLogin('d@example.com', 'member-password-1')).toBeNull();
		expect(validSession(s.id)).toBe(false);
		expect(() => createSession(Date.now(), id)).toThrow();
		setUserDisabled(id, false, OWNER);
		expect(checkLogin('d@example.com', 'member-password-1')?.kind).toBe('member');
		expect(validSession(s.id)).toBe(false); // an old session does not come back
	});
	it('no user enumeration: unknown email, wrong password and disabled account give the same answer', async () => {
		member('known@example.com', 'viewer', { password: 'member-password-1' });
		member('off@example.com', 'viewer', { password: 'member-password-1', disabled: true });
		const attempt = async (email: string, password: string) => {
			const request = new Request('http://localhost:5173/login', { method: 'POST', body: new URLSearchParams({ email, password }) });
			const r = (await loginPage.actions.default({ request, cookies: { set: () => {} }, getClientAddress: () => `192.0.2.${Math.floor(Math.random() * 250)}`, url: new URL('http://localhost:5173/login') } as never)) as { status: number; data: { error: string } };
			return [r.status, r.data.error];
		};
		const unknown = await attempt('nobody@example.com', 'member-password-1');
		expect(await attempt('known@example.com', 'wrong-password-1')).toEqual(unknown);
		expect(await attempt('off@example.com', 'member-password-1')).toEqual(unknown);
		expect(unknown).toEqual([401, 'Wrong email or password.']);
	});
	it('the sign-in form keeps its attempt limit, shared by owner and member attempts', async () => {
		const attempt = async (email: string, password: string) => {
			const request = new Request('http://localhost:5173/login', { method: 'POST', body: new URLSearchParams({ email, password }) });
			try {
				return ((await loginPage.actions.default({ request, cookies: { set: () => {} }, getClientAddress: () => '192.0.2.77', url: new URL('http://localhost:5173/login') } as never)) as { status: number }).status;
			} catch {
				return 303;
			}
		};
		for (let i = 0; i < 5; i++) expect(await attempt(i % 2 ? 'x@example.com' : '', 'nope')).toBe(401);
		expect(await attempt('', OWNER_PW)).toBe(429);
	});
	it('a role change applies on the next request; a member password change or an owner password change signs them out', () => {
		const id = member('r@example.com', 'viewer');
		const s = createSession(Date.now(), id);
		setUserRole(id, 'editor', OWNER);
		expect(sessionUser(s.id)?.role).toBe('editor');
		process.env.ADMIN_PASSWORD = 'rotated-owner-password';
		expect(validSession(s.id)).toBe(false);
		process.env.ADMIN_PASSWORD = OWNER_PW;
		expect(validSession(s.id)).toBe(true);
		db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword('a-brand-new-password'), id);
		expect(validSession(s.id)).toBe(false);
	});
	it('owner sessions are unchanged: valid until logout, ended by a password change', () => {
		const s = createSession();
		expect(sessionUser(s.id)).toEqual(OWNER);
		endSession(s.id);
		expect(sessionUser(s.id)).toBeNull();
	});
	it('the owner cannot be locked out: no member change touches the owner, and nobody changes their own role or access', () => {
		const adminId = member('boss@example.com', 'admin');
		const me = asUser(adminId);
		expect(() => setUserRole(adminId, 'viewer', me)).toThrow(/your own/);
		expect(() => setUserDisabled(adminId, true, me)).toThrow(/your own/);
		expect(() => removeUser(adminId, me)).toThrow(/your own/);
		const other = member('x@example.com', 'admin');
		setUserDisabled(other, true, me);
		removeUser(other, me);
		expect(checkLogin('', OWNER_PW)).toEqual({ kind: 'owner' });
	});
});

// ───────────────────────────── the role matrix, through the request gate ─────────────────────────────
describe('roles, enforced in the request gate for every form action and endpoint', () => {
	const ORIGIN = 'http://localhost:5173';
	const ev = (method: string, path: string, cookie: string | undefined, headers: Record<string, string> = {}) => {
		const url = new URL(ORIGIN + path);
		return {
			url,
			request: new Request(url, { method, headers: { host: 'localhost:5173', ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }), ...headers } }),
			locals: {} as Record<string, unknown>,
			cookies: { get: (k: string) => (k === 'osc_session' ? cookie : undefined) },
			getClientAddress: () => '127.0.0.1'
		};
	};
	const run = async (method: string, path: string, cookie: string | undefined, headers?: Record<string, string>) =>
		(await handle({ event: ev(method, path, cookie, headers) as never, resolve: (async () => new Response('ran')) as never })).status;
	let s: Record<'owner' | 'admin' | 'editor' | 'viewer', string>;
	beforeEach(() => {
		fresh();
		s = {
			owner: createSession().id,
			admin: createSession(Date.now(), member('admin@example.com', 'admin')).id,
			editor: createSession(Date.now(), member('editor@example.com', 'editor')).id,
			viewer: createSession(Date.now(), member('viewer@example.com', 'viewer')).id
		};
	});

	const EDITOR_WORK = ['/sites/1?/addNote', '/sites/1/actions?/state', '/sites/1/tests?/create', '/sites/1/submit?/submit', '/sites/1/indexnow?/submit', '/sites/1/sitemaps?/delete', '/sites/1/sync', '/?/syncAll', '/digest?/generate', '/updates?/add', '/sitemaps?/resubmitAll', '/connect?/resync', '/accounts?/refresh'];
	const ADMIN_WORK = [
		'/agents?/create', '/agents?/remove', '/agents?/permission', '/team?/invite', '/team?/role', '/team?/disable', '/team?/revoke', '/connect?/bingKey', '/connect?/unlink', '/connect?/cruxRemove',
		'/accounts?/remove', '/accounts?/addSite', '/accounts?/verifyNow', '/sites/1/settings?/save', '/sites/1/settings?/removeProperty', '/sites/1/clarity?/install', '/oauth/authorize?/allow', '/?/purgeRemoved'
	];

	it('a viewer can open every page but every change is refused', async () => {
		for (const p of ['/', '/agents', '/accounts', '/connect', '/team', '/portfolio', '/sites/1', '/sites/1/settings', '/sites/1/__data.json']) expect(await run('GET', p, s.viewer), p).toBe(200);
		for (const p of [...EDITOR_WORK, ...ADMIN_WORK]) expect(await run('POST', p, s.viewer), p).toBe(403);
		expect(await run('POST', '/logout', s.viewer)).toBe(200); // signing out is always allowed
	});
	it('an editor uses the app but cannot touch connections, API keys, the team or site settings', async () => {
		for (const p of EDITOR_WORK) expect(await run('POST', p, s.editor), p).toBe(200);
		for (const p of ADMIN_WORK) expect(await run('POST', p, s.editor), p).toBe(403);
		for (const p of ['/auth/connect', '/auth/callback?code=x&state=y', '/auth/bing/connect', '/auth/bing/callback']) expect(await run('GET', p, s.editor), p).toBe(403);
	});
	it('an admin and the owner can do everything', async () => {
		for (const who of [s.admin, s.owner]) {
			for (const p of [...EDITOR_WORK, ...ADMIN_WORK]) expect(await run('POST', p, who), p).toBe(200);
			expect(await run('GET', '/auth/connect', who)).toBe(200);
		}
	});
	it('an action nobody classified, or a prototype name, needs admin', async () => {
		for (const p of ['/sites/1?/brandNew', '/sites/1?/constructor', '/team?/__proto__']) {
			expect(await run('POST', p, s.editor), p).toBe(403);
			expect(await run('POST', p, s.admin), p).toBe(200); // SvelteKit itself then answers 404 for an action that does not exist
		}
	});
	it('a refused form posted with use:enhance gets an action failure the page can show', async () => {
		const r = await handle({ event: ev('POST', '/agents?/create', s.editor, { accept: 'application/json', 'x-sveltekit-action': 'true' }) as never, resolve: (async () => new Response('ran')) as never });
		expect(r.status).toBe(200);
		const body = (await r.json()) as { type: string; status: number; data: string };
		expect(body).toMatchObject({ type: 'failure', status: 403 });
		expect(JSON.parse(body.data)[1]).toMatch(/owner or an admin/);
	});
	it('the existing protections still apply: cross-site posts are refused, no session means /login, invite links are reachable signed out', async () => {
		expect(await run('POST', '/sites/1?/addNote', s.admin, { origin: 'https://evil.example' })).toBe(403);
		expect(await run('POST', '/sites/1?/addNote', undefined)).toBe(303);
		expect(await run('GET', '/team', undefined)).toBe(303);
		expect(await run('GET', '/invite/osci_whatever', undefined)).toBe(200);
		expect(await run('GET', '/invite/osci_whatever/__data.json', undefined)).toBe(200);
		expect(await run('GET', '/invite/a/b', undefined)).toBe(303);
	});
	it('READ_ONLY=1 still governs the Google writes for every role (the gate adds to it, never removes it)', () => {
		const src = readFileSync('src/routes/sitemaps/+page.server.ts', 'utf8');
		expect(src).toMatch(/if \(config\.readOnly\) return fail\(403/);
	});
	it('without a password, this machine is the owner', async () => {
		delete process.env.ADMIN_PASSWORD;
		expect(await run('POST', '/team?/invite', undefined)).toBe(200);
		expect(await run('POST', '/agents?/create', undefined)).toBe(200);
	});
	it('team actions check the role again themselves, and refuse demo mode', async () => {
		const call = (locals: unknown) => teamPage.actions.invite({ request: new Request('http://x/team', { method: 'POST', body: new URLSearchParams({ email: 'z@example.com', role: 'viewer' }) }), locals } as never);
		await expect(call({ user: asUser(member('ed2@example.com', 'editor')) })).rejects.toMatchObject({ status: 403 });
		await expect(call({ user: null })).rejects.toMatchObject({ status: 403 });
		process.env.DEMO_MODE = '1';
		expect(await call({ user: OWNER })).toMatchObject({ status: 403 });
		expect(count('SELECT COUNT(*) n FROM invites')).toBe(0);
		process.env.DEMO_MODE = '0';
		const ok = (await call({ user: OWNER })) as { inviteLink: string };
		expect(ok.inviteLink).toMatch(/\/invite\/osci_[A-Za-z0-9_-]{43}$/);
	});
});

// ───────────────────────────── site scope ─────────────────────────────
describe('a member limited to some sites', () => {
	const ORIGIN = 'http://localhost:5173';
	const run = async (method: string, path: string, cookie: string) => {
		const url = new URL(ORIGIN + path);
		const event = { url, request: new Request(url, { method, headers: { host: 'localhost:5173', ...(method === 'GET' ? {} : { origin: ORIGIN }) } }), locals: {}, cookies: { get: () => cookie }, getClientAddress: () => '198.51.100.30' };
		return (await handle({ event: event as never, resolve: (async () => new Response('ran')) as never })).status;
	};
	let id: number;
	let cookie: string;
	beforeEach(() => {
		fresh();
		db().prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1,'s','a@example.com','active',1)").run();
		for (const [sid, url] of [[1, 'https://one.example/'], [2, 'https://two.example/'], [3, 'https://three.example/']] as const) db().prepare("INSERT INTO sites (id, account_id, site_url, permission, created_at) VALUES (?,1,?,'siteOwner',1)").run(sid, url);
		id = member('scoped@example.com', 'editor', { siteIds: [1, 3] });
		cookie = createSession(Date.now(), id).id;
	});

	it('sees and works on its own sites only; other sites do not even exist for it', async () => {
		expect(await run('GET', '/sites/1', cookie)).toBe(200);
		expect(await run('GET', '/sites/3/queries', cookie)).toBe(200);
		expect(await run('POST', '/sites/1?/addNote', cookie)).toBe(200);
		expect(await run('GET', '/sites/2', cookie)).toBe(404);
		expect(await run('GET', '/sites/2/__data.json', cookie)).toBe(404);
		expect(await run('GET', '/sites/2/export', cookie)).toBe(404);
		expect(await run('POST', '/sites/2?/addNote', cookie)).toBe(404);
		expect(await run('POST', '/sites/2/sync', cookie)).toBe(404);
	});
	it('is refused the pages and changes that span every site', async () => {
		for (const p of ['/portfolio', '/actions', '/sitemaps', '/digest', '/agents', '/accounts', '/connect', '/oauth/authorize', '/sites', '/sites/x']) expect(await run('GET', p, cookie), p).toBe(403);
		for (const p of ['/?/syncAll', '/?/toggleHidden', '/updates?/add', '/sitemaps?/resubmitAll']) expect(await run('POST', p, cookie), p).toBe(403);
		for (const p of ['/', '/team', '/updates']) expect(await run('GET', p, cookie), p).toBe(200);
		expect(await run('POST', '/logout', cookie)).toBe(200);
	});
	it('the dashboard lists only its sites', () => {
		const cards = (u: CurrentUser) => ((dashboardLoad({ url: new URL(ORIGIN + '/'), locals: { user: u, authed: true } } as never) as { cards: { id: number }[] }).cards.map((c) => c.id).sort());
		expect(cards(asUser(id))).toEqual([1, 3]);
		expect(cards(OWNER)).toEqual([1, 2, 3]);
	});
	it('is limited again when its scope changes, and loses a deleted site for good (SQLite may reuse the id)', async () => {
		setUserSites(id, [2], OWNER);
		expect(await run('GET', '/sites/1', cookie)).toBe(404);
		expect(await run('GET', '/sites/2', cookie)).toBe(200);
		forgetSite(2);
		expect(sessionUser(cookie)?.siteIds).toEqual([]);
		expect(await run('GET', '/sites/2', cookie)).toBe(404);
		setUserSites(id, null, OWNER);
		expect(await run('GET', '/portfolio', cookie)).toBe(200);
	});
	it('accessRefusal: admins are never scoped, even if a row says otherwise', () => {
		db().prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(id);
		expect(sessionUser(cookie)?.siteIds).toBeNull();
		expect(accessRefusal({ ...OWNER, role: 'editor', siteIds: [1] }, 'GET', new URL(ORIGIN + '/sites/1'))).toBeNull();
	});
});

// ───────────────────────────── audit, the layout, demo mode, migration ─────────────────────────────
describe('audit log, header and demo mode', () => {
	beforeEach(fresh);

	it('records invites made, accepted and revoked, role changes and disabled members, with who did it', () => {
		const one = createInvite({ email: 'p@example.com', role: 'viewer', actor: OWNER });
		const u = acceptInvite(one.token, { name: 'Pat', password: 'long-enough-pw' });
		const two = createInvite({ email: 'q@example.com', role: 'editor', actor: OWNER });
		revokeInvite(two.id, OWNER);
		setUserRole(u.id, 'editor', OWNER);
		setUserDisabled(u.id, true, OWNER);
		const log = db().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'invite.%' OR action LIKE 'user.%' ORDER BY id").all() as { action: string; detail: string }[];
		expect(log.map((l) => l.action)).toEqual(['invite.created', 'invite.accepted', 'invite.created', 'invite.revoked', 'user.role_changed', 'user.disabled']);
		expect(log.find((l) => l.action === 'user.role_changed')!.detail).toBe('p@example.com: viewer -> editor by Owner');
		expect(JSON.stringify(log)).not.toContain(one.token);
	});
	it('the header learns who is signed in; before sign-in it learns nothing', () => {
		const id = member('who@example.com', 'viewer');
		const signedIn = layoutLoad({ locals: { authed: true, user: asUser(id) } } as never) as { user: Record<string, unknown> };
		expect(signedIn.user).toEqual({ name: 'who', email: 'who@example.com', role: 'viewer', roleLabel: 'Viewer', scoped: false });
		expect((layoutLoad({ locals: { authed: false, user: null } } as never) as { user: unknown }).user).toBeNull();
	});
	it('demo mode shows example people and pending invites, none of them real or acceptable', () => {
		process.env.DEMO_MODE = '1';
		member('real@example.com', 'editor');
		const d = teamPage.load({ locals: { user: OWNER, authed: true } } as never) as { users: { email: string }[]; invites: { email: string }[]; demo: boolean; activity: unknown[] };
		expect(d.demo).toBe(true);
		expect(d.users.length).toBeGreaterThanOrEqual(2);
		expect(d.users.every((u) => u.email.endsWith('@example.com') && u.email !== 'real@example.com')).toBe(true);
		expect(d.invites.length).toBeGreaterThan(0);
		expect(count('SELECT COUNT(*) n FROM invites')).toBe(0);
		expect(d.activity).toEqual([]);
	});
	it('outside demo mode a viewer sees the team but not other people\'s site lists or the activity', () => {
		const viewer = asUser(member('v@example.com', 'viewer'));
		member('s@example.com', 'editor', { siteIds: [1] });
		const d = teamPage.load({ locals: { user: viewer, authed: true } } as never) as { canManage: boolean; users: { email: string; sites: string[] | null; siteIds: unknown }[]; sites: unknown[]; activity: unknown[] };
		expect(d.canManage).toBe(false);
		expect(d.users.find((u) => u.email === 's@example.com')).toMatchObject({ sites: ['1 site'], siteIds: null });
		expect(d.sites).toEqual([]);
		expect(d.activity).toEqual([]);
	});
});

describe('upgrading an existing database', () => {
	it('adds the session owner column; sessions from before stay the owner\'s', () => {
		const dir = mkdtempSync(join(tmpdir(), 'osc-team-'));
		const file = join(dir, 'old.db');
		try {
			const old = new Database(file);
			old.exec('CREATE TABLE sessions (id_hash TEXT PRIMARY KEY, pw_fp TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL) WITHOUT ROWID');
			old.close();
			const d = openDb(file);
			expect((d.prepare('PRAGMA table_info(sessions)').all() as { name: string }[]).map((c) => c.name)).toContain('user_id');
			expect((d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users','invites') ORDER BY name").all() as { name: string }[]).map((r) => r.name)).toEqual(['invites', 'users']);
			d.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
