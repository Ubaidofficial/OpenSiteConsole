import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { handle } from '../src/hooks.server';
import { config } from '../src/lib/server/config';
import { buildLoginAuthUrl, loginRedirectUri } from '../src/lib/server/google';
import { createSession, sessionUser, validSession } from '../src/lib/server/sessions';
import { hashPassword } from '../src/lib/server/password';
import { googleLoginLimiter, loginLimiter, profileLimiter, resetLimiter } from '../src/lib/server/attempts';
import { OWNER, accessRefusal, requiredRole, type CurrentUser } from '../src/lib/server/roles';
import { checkLogin, createInvite, removeUser, setUserDisabled, TeamError } from '../src/lib/server/users';
import { changeOwnEmail, changeOwnName, changeOwnPassword, completePasswordReset, createPasswordReset, findReset, googleLinked, googleSignIn, linkGoogle, pendingResetUserIds, unlinkGoogle } from '../src/lib/server/selfservice';
import { finishGoogle, GOOGLE_LINK_COOKIE, GOOGLE_NEXT_COOKIE, GOOGLE_STATE_COOKIE, startGoogle } from '../src/lib/server/googlelogin';
import * as loginPage from '../src/routes/login/+page.server';
import * as resetPage from '../src/routes/reset/[token]/+page.server';
import * as profilePage from '../src/routes/profile/+page.server';
import * as teamPage from '../src/routes/team/+page.server';
import { GET as googleStart } from '../src/routes/login/google/+server';
import { GET as googleCallback } from '../src/routes/login/google/callback/+server';

const OWNER_PW = 'owner-password-for-account-tests';
const PW = 'member-password-1';

function fresh() {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.ADMIN_PASSWORD = OWNER_PW;
	delete process.env.ADMIN_PASSWORD_HASH;
	process.env.GOOGLE_CLIENT_ID = 'cid';
	process.env.GOOGLE_CLIENT_SECRET = 'secret';
	delete process.env.OAUTH_REDIRECT_URI;
	delete process.env.GOOGLE_LOGIN;
	delete process.env.OWNER_GOOGLE_EMAILS;
	process.env.DEMO_MODE = '0';
	process.env.SCHEDULER = '0';
	delete process.env.READ_ONLY;
	for (const l of [loginLimiter, resetLimiter, profileLimiter, googleLoginLimiter]) l.reset();
}
function member(email: string, role: 'admin' | 'editor' | 'viewer' = 'editor', o: { password?: string; siteIds?: number[] | null; disabled?: boolean } = {}): number {
	const r = db()
		.prepare('INSERT INTO users (email, name, password_hash, role, site_ids, created_at, disabled) VALUES (?,?,?,?,?,?,?)')
		.run(email, email.split('@')[0], hashPassword(o.password ?? PW), role, o.siteIds ? JSON.stringify(o.siteIds) : null, Date.now(), o.disabled ? 1 : 0);
	return Number(r.lastInsertRowid);
}
const asUser = (id: number): CurrentUser => {
	const u = db().prepare('SELECT id, email, name, role, site_ids FROM users WHERE id = ?').get(id) as { id: number; email: string; name: string; role: 'admin'; site_ids: string | null };
	return { id: u.id, email: u.email, name: u.name, role: u.role, siteIds: u.site_ids ? JSON.parse(u.site_ids) : null };
};
const row = (id: number) => db().prepare('SELECT * FROM users WHERE id = ?').get(id) as Record<string, unknown>;
const auditActions = () => (db().prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);
const jar = (init: Record<string, string> = {}) => {
	const m = new Map(Object.entries(init));
	const cookies = {
		get: (k: string) => m.get(k),
		set: (k: string, v: string, o?: { maxAge?: number }) => void (o?.maxAge === 0 ? m.delete(k) : m.set(k, v)),
		delete: (k: string) => void m.delete(k)
	};
	return { cookies: cookies as never, m };
};
/** What a SvelteKit handler redirects to (it throws, or rejects, a Redirect), or null. */
const redirectOf = async (fn: () => unknown): Promise<string | null> => {
	try {
		await fn();
	} catch (e) {
		if (e && typeof e === 'object' && 'location' in e) return (e as { location: string }).location;
		throw e;
	}
	return null;
};
const form = (o: Record<string, string>, url = 'https://s.example/x') => new Request(url, { method: 'POST', body: new URLSearchParams(o) });
const failed = (r: unknown) => r as { status: number; data: { error?: string; ok?: string } };

// ── a stand-in for Google: records what SEOConsole sends and answers as the test says ─────────────────────────────────
function google(identity: { sub?: string; email?: string; email_verified?: boolean } | 'token-fails' = { sub: 'g-1', email: 'amy@example.com', email_verified: true }) {
	const calls: { url: string; body?: string; auth?: string }[] = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
		calls.push({ url, body: init.body?.toString(), auth: (init.headers as Record<string, string> | undefined)?.authorization });
		if (url.includes('oauth2.googleapis.com/token')) return identity === 'token-fails' ? new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }) : new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 });
		return new Response(JSON.stringify(identity), { status: 200 });
	}) as unknown as typeof fetch;
	return { calls, fetchImpl };
}
const cb = (qs: string) => new URL(`https://s.example/login/google/callback?${qs}`);

// ───────────────────────────── the Google request ─────────────────────────────
describe('Sign in with Google: the request', () => {
	beforeEach(fresh);

	it('asks for openid and email only, with the login return address, no offline access and no data scopes', () => {
		const u = new URL(buildLoginAuthUrl('STATE1'));
		expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		expect(u.searchParams.get('scope')).toBe('openid email');
		expect(u.searchParams.get('redirect_uri')).toBe(`${config.origin}/login/google/callback`);
		expect(u.searchParams.get('redirect_uri')).toBe(loginRedirectUri());
		expect(u.searchParams.get('state')).toBe('STATE1');
		expect(u.searchParams.get('response_type')).toBe('code');
		expect(u.searchParams.get('prompt')).toBe('select_account');
		expect(u.searchParams.has('access_type')).toBe(false);
		expect(u.toString()).not.toMatch(/webmasters|analytics|tagmanager/);
	});
	it('is on only with a login password, a Google client and not on the hosted plan; GOOGLE_LOGIN=0 turns it off', () => {
		expect(config.googleLogin).toBe(true);
		process.env.GOOGLE_LOGIN = '0';
		expect(config.googleLogin).toBe(false);
		delete process.env.GOOGLE_LOGIN;
		process.env.OAUTH_REDIRECT_URI = 'https://hosted.example/oauth/callback';
		expect(config.googleLogin).toBe(false);
		delete process.env.OAUTH_REDIRECT_URI;
		delete process.env.ADMIN_PASSWORD;
		expect(config.googleLogin).toBe(false);
		process.env.ADMIN_PASSWORD = OWNER_PW;
		process.env.GOOGLE_CLIENT_SECRET = '';
		expect(config.googleLogin).toBe(false);
	});
	it('starting sets a state cookie and remembers where to go and whose profile is linking, and nothing else', () => {
		const j = jar();
		const url = startGoogle(j.cookies, new URL('https://s.example/login/google'), { next: '/oauth/authorize?x=1' });
		expect(new URL(url).searchParams.get('state')).toBe(j.m.get(GOOGLE_STATE_COOKIE));
		expect(j.m.get(GOOGLE_NEXT_COOKIE)).toBe('/oauth/authorize?x=1');
		expect(j.m.has(GOOGLE_LINK_COOKIE)).toBe(false);
		const k = jar();
		startGoogle(k.cookies, new URL('https://s.example/profile'), { linkUserId: 7 });
		expect(k.m.get(GOOGLE_LINK_COOKIE)).toBe('7');
	});
});

// ───────────────────────────── who a Google identity is ─────────────────────────────
describe('Sign in with Google: who gets in', () => {
	beforeEach(fresh);

	it('only people already on the team: a member is matched by a verified address and the Google account is linked to them', () => {
		const id = member('amy@example.com', 'editor');
		const r = googleSignIn({ sub: 'g-1', email: 'Amy@Example.com', emailVerified: true });
		expect(r).toMatchObject({ kind: 'member', user: { id, role: 'editor' } });
		expect(row(id).google_sub).toBe('g-1');
		expect(googleLinked(id)).toBe(true);
		expect(row(id).last_login_at).toBeGreaterThan(0);
		expect(auditActions()).toContain('user.google_linked');
	});
	it('Google never creates anyone: an address that is not on the team is turned away', () => {
		expect(googleSignIn({ sub: 'g-9', email: 'stranger@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'unknown' });
		expect(db().prepare('SELECT COUNT(*) n FROM users').get()).toEqual({ n: 0 });
	});
	it('an address Google has not verified is not enough', () => {
		const id = member('amy@example.com');
		expect(googleSignIn({ sub: 'g-1', email: 'amy@example.com', emailVerified: false })).toEqual({ kind: 'refused', reason: 'unverified' });
		expect(row(id).google_sub).toBeNull();
	});
	it('once linked, the Google account (not the address) is what counts: the member may change their address, and nobody else gets in on the old one', () => {
		const id = member('amy@example.com');
		googleSignIn({ sub: 'g-1', email: 'amy@example.com', emailVerified: true });
		db().prepare('UPDATE users SET email = ? WHERE id = ?').run('amy.new@example.com', id);
		expect(googleSignIn({ sub: 'g-1', email: 'whatever@gmail.com', emailVerified: true })).toMatchObject({ kind: 'member', user: { id } });
		// a different Google account claiming the member's current address is refused: it belongs to a linked Google account
		expect(googleSignIn({ sub: 'g-2', email: 'amy.new@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'other-google' });
	});
	it('a disabled member is turned away, by address and by linked Google account', () => {
		const id = member('amy@example.com');
		googleSignIn({ sub: 'g-1', email: 'amy@example.com', emailVerified: true });
		setUserDisabled(id, true, OWNER);
		expect(googleSignIn({ sub: 'g-1', email: 'amy@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'disabled' });
		const other = member('bo@example.com', 'viewer', { disabled: true });
		expect(googleSignIn({ sub: 'g-2', email: 'bo@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'disabled' });
		expect(row(other).google_sub).toBeNull();
	});
	it('the owner signs in by an address listed in OWNER_GOOGLE_EMAILS (verified, any case); nobody else can be the owner', () => {
		process.env.OWNER_GOOGLE_EMAILS = 'Boss@Example.com, second@example.com';
		expect(googleSignIn({ sub: 'g-5', email: 'boss@example.com', emailVerified: true })).toEqual({ kind: 'owner' });
		expect(googleSignIn({ sub: 'g-6', email: 'second@example.com', emailVerified: true })).toEqual({ kind: 'owner' });
		expect(googleSignIn({ sub: 'g-5', email: 'boss@example.com', emailVerified: false })).toEqual({ kind: 'refused', reason: 'unverified' });
		expect(googleSignIn({ sub: 'g-7', email: 'other@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'unknown' });
	});
	it('a Search Console account an admin connected is NOT the owner: otherwise an admin could make themselves the owner', () => {
		db().prepare("INSERT INTO accounts (google_sub, email, status, created_at) VALUES ('s','admin.google@example.com','active',1)").run();
		expect(googleSignIn({ sub: 'g-8', email: 'admin.google@example.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'unknown' });
	});
	it('an owner address cannot also be a team member: not by invite, not by a member changing their own email', () => {
		process.env.OWNER_GOOGLE_EMAILS = 'boss@example.com';
		expect(() => createInvite({ email: 'boss@example.com', role: 'admin' })).toThrow(/owner/);
		const id = member('amy@example.com');
		expect(() => changeOwnEmail(id, PW, 'BOSS@example.com')).toThrow(/owner/);
	});
	it('a member can link a Google account with another address; one Google account links to one member; unlinking works', () => {
		const a = member('amy@example.com');
		const b = member('bo@example.com');
		linkGoogle(a, 'g-77');
		expect(googleSignIn({ sub: 'g-77', email: 'private@gmail.com', emailVerified: true })).toMatchObject({ kind: 'member', user: { id: a } });
		expect(() => linkGoogle(b, 'g-77')).toThrow(/already linked/);
		unlinkGoogle(a);
		expect(googleLinked(a)).toBe(false);
		expect(googleSignIn({ sub: 'g-77', email: 'private@gmail.com', emailVerified: true })).toEqual({ kind: 'refused', reason: 'unknown' });
		expect(auditActions()).toEqual(expect.arrayContaining(['user.google_linked', 'user.google_unlinked']));
	});
});

// ───────────────────────────── the return from Google ─────────────────────────────
describe('Sign in with Google: the return', () => {
	beforeEach(fresh);
	const started = (o: { next?: string | null; linkUserId?: number } = {}) => {
		const j = jar();
		startGoogle(j.cookies, new URL('https://s.example/login/google'), o);
		return { ...j, state: j.m.get(GOOGLE_STATE_COOKIE)! };
	};

	it('trades the code with the login return address, asks Google who it is with the new token, and signs a member in', async () => {
		const id = member('amy@example.com');
		const g = google();
		const s = started({ next: '/oauth/authorize?c=1' });
		const r = await finishGoogle(s.cookies, cb(`code=CODE1&state=${s.state}`), null, '1.1.1.1', g.fetchImpl);
		expect(r).toEqual({ ok: true, kind: 'member', userId: id, next: '/oauth/authorize?c=1' });
		const token = new URLSearchParams(g.calls[0].body);
		expect(token.get('code')).toBe('CODE1');
		expect(token.get('redirect_uri')).toBe(loginRedirectUri());
		expect(token.get('grant_type')).toBe('authorization_code');
		expect(g.calls[1]).toMatchObject({ url: 'https://openidconnect.googleapis.com/v1/userinfo', auth: 'Bearer AT' });
		expect([...s.m.keys()]).toEqual([]); // the one-time cookies are gone
	});
	it('refuses a return that is not the one this browser started (no cookie, wrong state) before talking to Google', async () => {
		const g = google();
		const s = started();
		expect(await finishGoogle(s.cookies, cb('code=C&state=WRONG'), null, '1.1.1.2', g.fetchImpl)).toMatchObject({ ok: false, code: 'state' });
		expect(await finishGoogle(jar().cookies, cb(`code=C&state=${s.state}`), null, '1.1.1.2', g.fetchImpl)).toMatchObject({ ok: false, code: 'state' });
		expect(g.calls).toEqual([]);
	});
	it('cancelling at Google, a missing code and a failing token exchange each end without signing anyone in', async () => {
		member('amy@example.com');
		let s = started();
		expect(await finishGoogle(s.cookies, cb(`error=access_denied&state=${s.state}`), null, '1.1.1.3', google().fetchImpl)).toMatchObject({ ok: false, code: 'denied' });
		s = started();
		expect(await finishGoogle(s.cookies, cb(`state=${s.state}`), null, '1.1.1.3', google().fetchImpl)).toMatchObject({ ok: false, code: 'failed' });
		s = started();
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), null, '1.1.1.3', google('token-fails').fetchImpl)).toMatchObject({ ok: false, code: 'failed' });
	});
	it('an identity that is not on the team is refused, and ten refusals from one address stop further tries for a while', async () => {
		for (let i = 0; i < 10; i++) {
			const s = started();
			expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), null, '9.9.9.9', google({ sub: 'x', email: 'nobody@example.com', email_verified: true }).fetchImpl)).toMatchObject({ ok: false, code: 'unknown' });
		}
		const s = started();
		const g = google();
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), null, '9.9.9.9', g.fetchImpl)).toMatchObject({ ok: false, code: 'toomany' });
		expect(g.calls).toEqual([]);
		member('amy@example.com');
		const t = started();
		expect(await finishGoogle(t.cookies, cb(`code=C&state=${t.state}`), null, '8.8.8.8', google().fetchImpl)).toMatchObject({ ok: true }); // another visitor is unaffected
	});
	it('linking only works for the member who started it and who is still signed in as them', async () => {
		const a = member('amy@example.com');
		const b = member('bo@example.com');
		let s = started({ linkUserId: a });
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), null, '2.2.2.2', google({ sub: 'g-1', email: 'x@gmail.com', email_verified: true }).fetchImpl)).toMatchObject({ ok: false, code: 'state', link: true });
		s = started({ linkUserId: a });
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), asUser(b), '2.2.2.2', google({ sub: 'g-1', email: 'x@gmail.com', email_verified: true }).fetchImpl)).toMatchObject({ ok: false, code: 'state' });
		expect(googleLinked(a)).toBe(false);
		s = started({ linkUserId: a });
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), asUser(a), '2.2.2.2', google({ sub: 'g-1', email: 'x@gmail.com', email_verified: true }).fetchImpl)).toEqual({ ok: true, kind: 'linked', userId: a });
		expect(googleLinked(a)).toBe(true);
		// a Google account that another member already uses is refused with a message the profile can show
		s = started({ linkUserId: b });
		expect(await finishGoogle(s.cookies, cb(`code=C&state=${s.state}`), asUser(b), '2.2.2.2', google({ sub: 'g-1', email: 'x@gmail.com', email_verified: true }).fetchImpl)).toMatchObject({ ok: false, code: 'link', message: expect.stringMatching(/already linked/) });
	});
});

// ───────────────────────────── the routes ─────────────────────────────
describe('Sign in with Google: the routes and the login page', () => {
	beforeEach(fresh);

	it('/login/google sends the browser to Google, and is a 404 when the feature is off', async () => {
		const j = jar();
		const loc = await redirectOf(() => googleStart({ cookies: j.cookies, url: new URL('https://s.example/login/google?next=%2Foauth%2Fauthorize%3Fa%3D1') } as never));
		expect(loc).toMatch(/^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
		expect(j.m.get(GOOGLE_NEXT_COOKIE)).toBe('/oauth/authorize?a=1');
		// only the OAuth approval page may be returned to; anything else is dropped
		const k = jar();
		await redirectOf(() => googleStart({ cookies: k.cookies, url: new URL('https://s.example/login/google?next=https%3A%2F%2Fevil.example') } as never));
		expect(k.m.has(GOOGLE_NEXT_COOKIE)).toBe(false);
		process.env.GOOGLE_LOGIN = '0';
		await expect(Promise.resolve().then(() => googleStart({ cookies: j.cookies, url: new URL('https://s.example/login/google') } as never))).rejects.toMatchObject({ status: 404 });
	});
	it('the return signs a member in with a fresh session, ends the one that was there, and goes home', async () => {
		const id = member('amy@example.com', 'viewer');
		const old = createSession();
		const s = jar({ osc_session: old.id });
		startGoogle(s.cookies, new URL('https://s.example/login/google'));
		const state = s.m.get(GOOGLE_STATE_COOKIE)!;
		vi.stubGlobal('fetch', google().fetchImpl);
		try {
			const loc = await redirectOf(() => googleCallback({ url: cb(`code=C&state=${state}`), cookies: s.cookies, locals: { user: null }, getClientAddress: () => '3.3.3.3' } as never));
			expect(loc).toBe('/');
		} finally {
			vi.unstubAllGlobals();
		}
		expect(validSession(old.id)).toBe(false);
		expect(sessionUser(s.m.get('osc_session'))).toMatchObject({ id, role: 'viewer' });
	});
	it('a turned-away sign-in goes back to the form with a reason, and sets no session', async () => {
		const s = jar();
		startGoogle(s.cookies, new URL('https://s.example/login/google'));
		const state = s.m.get(GOOGLE_STATE_COOKIE)!;
		vi.stubGlobal('fetch', google({ sub: 'z', email: 'nobody@example.com', email_verified: true }).fetchImpl);
		try {
			expect(await redirectOf(() => googleCallback({ url: cb(`code=C&state=${state}`), cookies: s.cookies, locals: { user: null }, getClientAddress: () => '3.3.3.4' } as never))).toBe('/login?google=unknown');
		} finally {
			vi.unstubAllGlobals();
		}
		expect(s.m.has('osc_session')).toBe(false);
	});
	it('the owner signs in through Google when their address is listed', async () => {
		process.env.OWNER_GOOGLE_EMAILS = 'boss@example.com';
		const s = jar();
		startGoogle(s.cookies, new URL('https://s.example/login/google'));
		const state = s.m.get(GOOGLE_STATE_COOKIE)!;
		vi.stubGlobal('fetch', google({ sub: 'b', email: 'boss@example.com', email_verified: true }).fetchImpl);
		try {
			expect(await redirectOf(() => googleCallback({ url: cb(`code=C&state=${state}`), cookies: s.cookies, locals: { user: null }, getClientAddress: () => '3.3.3.5' } as never))).toBe('/');
		} finally {
			vi.unstubAllGlobals();
		}
		expect(sessionUser(s.m.get('osc_session'))).toMatchObject({ role: 'owner', id: null });
	});
	it('the sign-in page offers Google only when it is on, and shows why a Google sign-in was refused', () => {
		const load = (qs = '') => loginPage.load({ locals: { authed: false }, url: new URL(`https://s.example/login${qs}`) } as never) as { googleLogin: boolean; googleError: string | null; next: string | null };
		expect(load().googleLogin).toBe(true);
		expect(load().googleError).toBeNull();
		expect(load('?google=unknown').googleError).toMatch(/not on the team/);
		expect(load('?google=nonsense').googleError).toMatch(/could not confirm/);
		expect(load('?next=%2Foauth%2Fauthorize%3Fx%3D1').next).toBe('/oauth/authorize?x=1');
		process.env.GOOGLE_LOGIN = '0';
		expect(load().googleLogin).toBe(false);
	});
});

// ───────────────────────────── changing your own details ─────────────────────────────
describe('a member changing their own name, email and password', () => {
	beforeEach(fresh);

	it('name: trimmed, 1 to 80 characters', () => {
		const id = member('amy@example.com');
		expect(changeOwnName(id, '  Amy   Lee ').name).toBe('Amy Lee');
		for (const bad of ['', '   ', 'x'.repeat(81)]) expect(() => changeOwnName(id, bad)).toThrow(TeamError);
		expect(auditActions()).toContain('user.name_changed');
	});
	it('email: needs the current password, a valid new address, and one nobody else uses', () => {
		const id = member('amy@example.com');
		member('bo@example.com');
		expect(() => changeOwnEmail(id, 'wrong-password', 'new@example.com')).toThrow(/current password/);
		expect(() => changeOwnEmail(id, '', 'new@example.com')).toThrow(/current password/);
		expect(() => changeOwnEmail(id, PW, 'not an email')).toThrow(/valid email/);
		expect(() => changeOwnEmail(id, PW, 'AMY@example.com')).toThrow(/already your/);
		expect(() => changeOwnEmail(id, PW, 'Bo@example.com')).toThrow(/already uses/);
		expect(row(id).email).toBe('amy@example.com');
	});
	it('email: the new address (lower-cased) is what they sign in with from then on, the Google link is dropped, and it is logged', () => {
		const id = member('amy@example.com');
		linkGoogle(id, 'g-1');
		const s = createSession(Date.now(), id);
		expect(changeOwnEmail(id, PW, ' New.Amy@Example.com ').email).toBe('new.amy@example.com');
		expect(checkLogin('new.amy@example.com', PW)?.kind).toBe('member');
		expect(checkLogin('amy@example.com', PW)).toBeNull();
		expect(googleLinked(id)).toBe(false);
		expect(validSession(s.id)).toBe(true); // the password did not change, so the session stays
		expect(auditActions()).toContain('user.email_changed');
	});
	it('password: needs the current one, a long enough new one, and a different one', () => {
		const id = member('amy@example.com');
		expect(() => changeOwnPassword(id, 'wrong', 'a-brand-new-password')).toThrow(/current password/);
		expect(() => changeOwnPassword(id, PW, 'short')).toThrow(/at least 10/);
		expect(() => changeOwnPassword(id, PW, 'x'.repeat(257))).toThrow(/at most 256/);
		expect(() => changeOwnPassword(id, PW, PW)).toThrow(/not already using/);
		expect(checkLogin('amy@example.com', PW)?.kind).toBe('member');
	});
	it('password: the old one stops working, the new one works, every session ends, and a pending reset link is voided', () => {
		const id = member('amy@example.com');
		const admin = member('admin@example.com', 'admin');
		const s1 = createSession(Date.now(), id);
		const s2 = createSession(Date.now(), id);
		const link = createPasswordReset(id, asUser(admin));
		changeOwnPassword(id, PW, 'a-brand-new-password');
		expect(checkLogin('amy@example.com', PW)).toBeNull();
		expect(checkLogin('amy@example.com', 'a-brand-new-password')?.kind).toBe('member');
		expect(validSession(s1.id) || validSession(s2.id)).toBe(false);
		expect(findReset(link.token)).toBeUndefined();
		expect(auditActions()).toContain('user.password_changed');
	});
	it('a disabled member cannot change anything: they cannot prove the password', () => {
		const id = member('amy@example.com', 'editor', { disabled: true });
		expect(() => changeOwnPassword(id, PW, 'a-brand-new-password')).toThrow(/current password/);
	});
});

describe('the account page', () => {
	beforeEach(fresh);
	const act = (name: 'name' | 'email' | 'password' | 'linkGoogle' | 'unlinkGoogle', user: CurrentUser, body: Record<string, string> = {}, j = jar()) =>
		(profilePage.actions[name] as (e: never) => Promise<unknown>)({ request: form(body), locals: { user }, cookies: j.cookies, url: new URL('https://s.example/profile') } as never);

	it('the owner has no row: the page says where the password lives, and every action explains instead of changing anything', async () => {
		const data = profilePage.load({ locals: { user: OWNER }, url: new URL('https://s.example/profile') } as never) as { owner: boolean; ownerEmails: string[] };
		expect(data.owner).toBe(true);
		for (const name of ['name', 'email', 'password', 'unlinkGoogle'] as const) expect(failed(await act(name, OWNER, { name: 'x', email: 'a@b.co', current: 'x', password: 'long-enough-pw', confirm: 'long-enough-pw' })).data.error).toMatch(/ADMIN_PASSWORD/);
	});
	it('changing the password signs out every other browser and keeps this one signed in with a new session', async () => {
		const id = member('amy@example.com');
		const other = createSession(Date.now(), id);
		const j = jar();
		const r = (await act('password', asUser(id), { current: PW, password: 'a-brand-new-password', confirm: 'a-brand-new-password' }, j)) as { ok: string };
		expect(r.ok).toMatch(/Password changed/);
		expect(validSession(other.id)).toBe(false);
		expect(sessionUser(j.m.get('osc_session'))).toMatchObject({ id });
	});
	it('the two new passwords must match, and five wrong current passwords lock further tries for a while', async () => {
		const id = member('amy@example.com');
		expect(failed(await act('password', asUser(id), { current: PW, password: 'a-brand-new-password', confirm: 'something-else-entirely' })).data.error).toMatch(/not the same/);
		for (let i = 0; i < 5; i++) expect(failed(await act('password', asUser(id), { current: 'wrong', password: 'a-brand-new-password', confirm: 'a-brand-new-password' })).status).toBe(400);
		const locked = failed(await act('password', asUser(id), { current: PW, password: 'a-brand-new-password', confirm: 'a-brand-new-password' }));
		expect(locked.status).toBe(429);
		expect(failed(await act('email', asUser(id), { current: PW, email: 'new@example.com' })).status).toBe(429);
		expect(checkLogin('amy@example.com', PW)?.kind).toBe('member'); // nothing changed
	});
	it('name and email actions answer with what changed', async () => {
		const id = member('amy@example.com');
		expect(((await act('name', asUser(id), { name: 'Amy Lee' })) as { ok: string }).ok).toMatch(/Amy Lee/);
		expect(((await act('email', asUser(id), { current: PW, email: 'new@example.com' })) as { ok: string }).ok).toMatch(/new@example\.com/);
		expect(failed(await act('email', asUser(id), { current: PW, email: 'bad' })).data.error).toMatch(/valid email/);
	});
	it('linking goes to Google from a form on the page (never a plain link), and only when Google sign-in is on; unlinking works', async () => {
		const id = member('amy@example.com');
		const j = jar();
		expect(await redirectOf(() => act('linkGoogle', asUser(id), {}, j))).toMatch(/^https:\/\/accounts\.google\.com\//);
		expect(j.m.get(GOOGLE_LINK_COOKIE)).toBe(String(id));
		linkGoogle(id, 'g-1');
		expect(((await act('unlinkGoogle', asUser(id))) as { ok: string }).ok).toMatch(/unlinked/);
		process.env.GOOGLE_LOGIN = '0';
		expect(failed(await act('linkGoogle', asUser(id))).data.error).toMatch(/not set up/);
	});
	it('the page shows the member’s own details and the Google link state', () => {
		const id = member('amy@example.com', 'viewer');
		const load = (qs = '') => profilePage.load({ locals: { user: asUser(id) }, url: new URL(`https://s.example/profile${qs}`) } as never) as { owner: boolean; email: string; googleLinked: boolean; googleNote: { ok: boolean; text: string } | null };
		expect(load()).toMatchObject({ owner: false, email: 'amy@example.com', googleLinked: false, googleNote: null });
		expect(load('?google=linked').googleNote).toMatchObject({ ok: true });
		expect(load('?google=link').googleNote?.ok).toBe(false);
	});
});

// ───────────────────────────── reset links ─────────────────────────────
describe('password reset links', () => {
	beforeEach(fresh);
	const DAY = 86_400_000;

	it('an admin makes a link for a member: only a hash is stored, it expires in 24 hours, and it is logged', () => {
		const id = member('amy@example.com');
		const admin = member('admin@example.com', 'admin');
		const now = Date.now();
		const r = createPasswordReset(id, asUser(admin), now);
		expect(r.token).toMatch(/^oscr_[\w-]{43}$/);
		expect(r.expiresAt).toBe(now + DAY);
		const stored = db().prepare('SELECT * FROM password_resets').get() as { token_hash: string; created_by: string };
		expect(JSON.stringify(stored)).not.toContain(r.token);
		expect(stored.created_by).toContain('admin@example.com');
		expect(findReset(r.token, now)).toMatchObject({ userId: id, email: 'amy@example.com' });
		expect(findReset(r.token, now + DAY + 1)).toBeUndefined();
		expect(pendingResetUserIds(now).has(id)).toBe(true);
		expect(auditActions()).toContain('user.reset_link_created');
	});
	it('nobody makes one for themselves (they have their profile), for a disabled member or for someone who does not exist; the owner may make one for anyone', () => {
		const id = member('amy@example.com', 'admin');
		const off = member('off@example.com', 'editor', { disabled: true });
		expect(() => createPasswordReset(id, asUser(id))).toThrow(/your own password/);
		expect(() => createPasswordReset(off, OWNER)).toThrow(/Enable/);
		expect(() => createPasswordReset(9999, OWNER)).toThrow(/Unknown/);
		expect(createPasswordReset(id, OWNER).token).toMatch(/^oscr_/);
	});
	it('a newer link replaces the pending one, and a malformed or unknown link is never valid', () => {
		const id = member('amy@example.com');
		const a = createPasswordReset(id, OWNER);
		const b = createPasswordReset(id, OWNER);
		expect(findReset(a.token)).toBeUndefined();
		expect(findReset(b.token)).toBeDefined();
		for (const bad of ['', 'oscr_', 'osci_' + 'x'.repeat(43), 'oscr_' + 'x'.repeat(43), 'oscr_' + 'x'.repeat(200)]) expect(findReset(bad)).toBeUndefined();
	});
	it('using it sets the password, signs the member out everywhere, and works once', () => {
		const id = member('amy@example.com');
		const s = createSession(Date.now(), id);
		const { token } = createPasswordReset(id, OWNER);
		const u = completePasswordReset(token, 'a-brand-new-password');
		expect(u.id).toBe(id);
		expect(checkLogin('amy@example.com', PW)).toBeNull();
		expect(checkLogin('amy@example.com', 'a-brand-new-password')?.kind).toBe('member');
		expect(validSession(s.id)).toBe(false);
		expect(() => completePasswordReset(token, 'another-new-password')).toThrow(/not valid/);
		expect(auditActions()).toContain('user.password_reset');
	});
	it('a password that is too weak or long is refused and the link stays usable', () => {
		const id = member('amy@example.com');
		const { token } = createPasswordReset(id, OWNER);
		expect(() => completePasswordReset(token, 'short')).toThrow(/at least 10/);
		expect(() => completePasswordReset(token, 'x'.repeat(300))).toThrow(/at most 256/);
		expect(findReset(token)).toBeDefined();
	});
	it('disabling or removing the member voids the link', () => {
		const a = member('amy@example.com');
		const b = member('bo@example.com');
		const la = createPasswordReset(a, OWNER);
		const lb = createPasswordReset(b, OWNER);
		setUserDisabled(a, true, OWNER);
		expect(findReset(la.token)).toBeUndefined();
		removeUser(b, OWNER);
		expect(findReset(lb.token)).toBeUndefined();
		expect(db().prepare('SELECT COUNT(*) n FROM password_resets WHERE user_id = ?').get(b)).toEqual({ n: 0 });
	});

	it('the reset page: a good link shows the address; unknown links are counted per visitor and refused after ten', () => {
		const id = member('amy@example.com');
		const { token } = createPasswordReset(id, OWNER);
		const ev = (t: string, ip = '5.5.5.5') => ({ params: { token: t }, getClientAddress: () => ip }) as never;
		expect(resetPage.load(ev(token))).toMatchObject({ valid: true, email: 'amy@example.com' });
		for (let i = 0; i < 10; i++) expect((resetPage.load(ev('oscr_' + 'x'.repeat(43))) as { valid: boolean }).valid).toBe(false);
		expect(() => resetPage.load(ev(token))).toThrow(); // 429, even for a good link, until the window ends
		expect(resetPage.load(ev(token, '5.5.5.6'))).toMatchObject({ valid: true });
	});
	it('the reset page action: the two passwords must match; success signs this browser in and goes home', async () => {
		const id = member('amy@example.com');
		const old = createSession();
		const { token } = createPasswordReset(id, OWNER);
		const j = jar({ osc_session: old.id });
		const run = (body: Record<string, string>) => resetPage.actions.default({ params: { token }, request: form(body), cookies: j.cookies, getClientAddress: () => '6.6.6.6', url: new URL('https://s.example/reset/x') } as never);
		expect(failed(await run({ password: 'a-brand-new-password', confirm: 'a-different-password' })).data.error).toMatch(/not the same/);
		expect(failed(await run({ password: 'short', confirm: 'short' })).data.error).toMatch(/at least 10/);
		expect(await redirectOf(() => run({ password: 'a-brand-new-password', confirm: 'a-brand-new-password' }))).toBe('/');
		expect(validSession(old.id)).toBe(false); // whoever was signed in on this browser was signed out first
		expect(sessionUser(j.m.get('osc_session'))).toMatchObject({ id });
		expect(failed(await run({ password: 'a-brand-new-password', confirm: 'a-brand-new-password' })).status).toBe(400); // used up
	});
	it('the team page action makes the link for an admin, never for oneself, and the page lists who has one pending', async () => {
		const id = member('amy@example.com');
		const admin = member('admin@example.com', 'admin');
		const call = (target: number, user: CurrentUser) => teamPage.actions.resetLink({ request: form({ id: String(target) }), locals: { user } } as never) as Promise<{ resetLink?: string; resetFor?: string; resetExpires?: number; status?: number; data?: { error: string } }>;
		const r = await call(id, asUser(admin));
		expect(r.resetLink).toMatch(new RegExp(`^${config.origin}/reset/oscr_[\\w-]{43}$`));
		expect(r.resetFor).toBe('amy');
		expect(failed(await call(admin, asUser(admin))).data.error).toMatch(/your own password/);
		const data = teamPage.load({ locals: { user: asUser(admin) } } as never) as { pendingResets: number[] };
		expect(data.pendingResets).toEqual([id]);
		const nonAdmin = teamPage.load({ locals: { user: asUser(id) } } as never) as { pendingResets: number[] };
		expect(nonAdmin.pendingResets).toEqual([]);
	});
});

// ───────────────────────────── the request gate ─────────────────────────────
describe('the request gate for the new routes', () => {
	beforeEach(fresh);
	const ORIGIN = 'http://localhost:5173';
	const run = async (method: string, path: string, cookie?: string) => {
		const url = new URL(ORIGIN + path);
		const event = { url, request: new Request(url, { method, headers: { host: 'localhost:5173', ...(method === 'GET' ? {} : { origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' }) } }), locals: {} as Record<string, unknown>, cookies: { get: (k: string) => (k === 'osc_session' ? cookie : undefined) }, getClientAddress: () => '127.0.0.1' };
		return (await handle({ event: event as never, resolve: (async () => new Response('ran')) as never })).status;
	};

	it('Google sign-in and reset links are reachable signed out; the account page is not', async () => {
		expect(await run('GET', '/login/google')).toBe(200);
		expect(await run('GET', '/login/google/callback?code=x&state=y')).toBe(200);
		expect(await run('GET', '/reset/oscr_abc')).toBe(200);
		expect(await run('POST', '/reset/oscr_abc')).toBe(200);
		expect(await run('GET', '/profile')).toBe(303);
		expect(await run('POST', '/profile?/password')).toBe(303);
		expect(await run('GET', '/login/google/other')).toBe(303);
	});
	it('every role may use their own account page, including a viewer and a member limited to some sites; making a reset link needs an admin', async () => {
		const viewer = createSession(Date.now(), member('v@example.com', 'viewer', { siteIds: [1] }));
		const admin = createSession(Date.now(), member('a@example.com', 'admin'));
		const editor = createSession(Date.now(), member('e@example.com', 'editor'));
		expect(await run('GET', '/profile', viewer.id)).toBe(200);
		for (const a of ['name', 'email', 'password', 'linkGoogle', 'unlinkGoogle']) expect(await run('POST', `/profile?/${a}`, viewer.id), a).toBe(200);
		expect(await run('POST', '/team?/resetLink', editor.id)).toBe(403);
		expect(await run('POST', '/team?/resetLink', viewer.id)).toBe(403);
		expect(await run('POST', '/team?/resetLink', admin.id)).toBe(200);
		expect(requiredRole('POST', new URL(`${ORIGIN}/team?/resetLink`))).toBe('admin');
		expect(accessRefusal(asUser(1), 'POST', new URL(`${ORIGIN}/profile?/name`))).toBeNull();
	});
});
