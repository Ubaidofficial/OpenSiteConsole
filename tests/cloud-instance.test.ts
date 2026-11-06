import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '../src/lib/server/password';
import { checkAdminPassword } from '../src/lib/server/adminauth';
import { config } from '../src/lib/server/config';
import { createSession, validSession } from '../src/lib/server/sessions';
import { handle } from '../src/hooks.server';
import { originFromState, slugOfOrigin, stateWithOrigin } from '../src/lib/oauthrelay';
import { buildAuthUrl, redirectUri } from '../src/lib/server/google';
import { GET as connect } from '../src/routes/auth/connect/+server';

const keep = { ...process.env };
afterEach(() => {
	for (const k of ['ADMIN_PASSWORD', 'ADMIN_PASSWORD_HASH', 'OAUTH_REDIRECT_URI', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ORIGIN']) {
		if (keep[k] === undefined) delete process.env[k];
		else process.env[k] = keep[k];
	}
});

describe('password hashes', () => {
	it('verify the right password only, salt every hash, and use the documented format', () => {
		const h = hashPassword('correct horse battery');
		expect(h).toMatch(/^scrypt:16384:8:1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/);
		expect(h).not.toContain('$'); // safe in compose files, .env files and shells
		expect(verifyPassword('correct horse battery', h)).toBe(true);
		expect(verifyPassword('correct horse batterz', h)).toBe(false);
		expect(verifyPassword('', h)).toBe(false);
		expect(hashPassword('correct horse battery')).not.toBe(h); // random salt
		expect(MIN_PASSWORD_LENGTH).toBe(12);
	});
	it('treat equivalent Unicode spellings as one password', () => {
		expect(verifyPassword('café-password-1', hashPassword('café-password-1'))).toBe(true);
	});
	it('refuse malformed or absurd stored values instead of crashing or exhausting memory', () => {
		for (const bad of ['', 'plain', 'scrypt:', 'scrypt:16384:8:1::', 'md5:1:2:3:a:b', 'scrypt:x:8:1:AAAA:AAAA', 'scrypt:1073741824:8:1:AAAA:AAAA', 'scrypt:16384:9999:1:AAAA:AAAA', 'scrypt:16384:8:1:AAAA:', 'scrypt$16384$8$1$AAAA$AAAA']) expect(verifyPassword('anything', bad), bad).toBe(false);
	});
});

describe('the login check', () => {
	it('uses the hash when there is one (it wins over a plain password), else the plain password, else nothing', () => {
		process.env.ADMIN_PASSWORD = 'plain-password-1';
		expect(checkAdminPassword('plain-password-1')).toBe(true);
		expect(checkAdminPassword('nope')).toBe(false);
		process.env.ADMIN_PASSWORD_HASH = hashPassword('hashed-password-2');
		expect(checkAdminPassword('hashed-password-2')).toBe(true);
		expect(checkAdminPassword('plain-password-1')).toBe(false);
		delete process.env.ADMIN_PASSWORD;
		delete process.env.ADMIN_PASSWORD_HASH;
		expect(checkAdminPassword('')).toBe(false);
		expect(checkAdminPassword('anything')).toBe(false);
	});
	it('a hash alone counts as "a password is configured"', () => {
		delete process.env.ADMIN_PASSWORD;
		expect(config.hasPassword).toBe(false);
		process.env.ADMIN_PASSWORD_HASH = hashPassword('hashed-password-2');
		expect(config.hasPassword).toBe(true);
	});
	it('the request gate honours a hash-only configuration, and changing the hash ends old sessions', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.SCHEDULER = '0';
		delete process.env.ADMIN_PASSWORD;
		process.env.ADMIN_PASSWORD_HASH = hashPassword('hashed-password-2');
		const ev = (path: string, cookie?: string) => {
			const url = new URL('http://localhost:5173' + path);
			return { url, request: new Request(url, { headers: { host: 'localhost:5173' } }), locals: {} as Record<string, unknown>, cookies: { get: () => cookie }, getClientAddress: () => '127.0.0.1' };
		};
		const run = (e: ReturnType<typeof ev>) => handle({ event: e as never, resolve: (async () => new Response('page')) as never });
		expect((await run(ev('/accounts'))).status).toBe(303); // a password is configured, so no session means the login page
		const s = createSession();
		expect(validSession(s.id)).toBe(true);
		expect((await run(ev('/accounts', s.id))).status).toBe(200);
		process.env.ADMIN_PASSWORD_HASH = hashPassword('another-password-3');
		expect(validSession(s.id)).toBe(false);
		expect((await run(ev('/accounts', s.id))).status).toBe(303);
	});
});

describe('the shared OAuth redirect (hosted plan)', () => {
	it('puts the instance origin into the state and reads it back, rejecting anything that is not a plain https origin', () => {
		const st = stateWithOrigin('abc123', 'https://c-abc123.cloud.example.com');
		expect(st.startsWith('abc123.')).toBe(true);
		expect(originFromState(st)).toBe('https://c-abc123.cloud.example.com');
		for (const bad of ['', 'nodot', 'abc.', 'abc.!!!', stateWithOrigin('x', 'http://c-abc.cloud.example.com'), stateWithOrigin('x', 'https://u:p@c-abc.cloud.example.com'), stateWithOrigin('x', 'https://c-abc.cloud.example.com/path'), stateWithOrigin('x', 'https://c-abc.cloud.example.com/?q=1'), stateWithOrigin('x', 'javascript:alert(1)')]) expect(originFromState(bad), bad).toBeNull();
	});
	it('maps an origin to a customer slug only under the base domain', () => {
		expect(slugOfOrigin('https://c-abc123.cloud.example.com', 'cloud.example.com')).toBe('c-abc123');
		expect(slugOfOrigin('https://C-ABC123.Cloud.Example.com', 'cloud.example.com')).toBe('c-abc123');
		for (const bad of ['https://cloud.example.com', 'https://evil.com', 'https://c-abc123.cloud.example.com.evil.com', 'https://a.b.cloud.example.com', 'https://ab.cloud.example.com', 'https://-bad.cloud.example.com', 'not a url']) expect(slugOfOrigin(bad, 'cloud.example.com'), bad).toBeNull();
	});
	it('a normal install keeps its own /auth/callback; the hosted plan swaps in the shared address', () => {
		process.env.ORIGIN = 'https://c-abc123.cloud.example.com';
		process.env.GOOGLE_CLIENT_ID = 'id';
		delete process.env.OAUTH_REDIRECT_URI;
		expect(redirectUri()).toBe('https://c-abc123.cloud.example.com/auth/callback');
		process.env.OAUTH_REDIRECT_URI = 'https://cloud.example.com/oauth/callback';
		expect(redirectUri()).toBe('https://cloud.example.com/oauth/callback');
		expect(new URL(buildAuthUrl('s')).searchParams.get('redirect_uri')).toBe('https://cloud.example.com/oauth/callback');
	});
	it('starting a Google connection in hosted mode carries the origin in the state cookie and in the redirect', () => {
		process.env.ORIGIN = 'https://c-abc123.cloud.example.com';
		process.env.GOOGLE_CLIENT_ID = 'id';
		process.env.GOOGLE_CLIENT_SECRET = 'secret';
		process.env.OAUTH_REDIRECT_URI = 'https://cloud.example.com/oauth/callback';
		const jar = new Map<string, string>();
		let location = '';
		try {
			connect({ cookies: { set: (k: string, v: string) => jar.set(k, v) }, url: new URL('https://c-abc123.cloud.example.com/auth/connect') } as never);
		} catch (e) {
			location = (e as { location?: string }).location ?? '';
		}
		const state = new URL(location).searchParams.get('state')!;
		expect(state).toBe(jar.get('osc_oauth_state')); // the callback still compares the whole value with the cookie
		expect(originFromState(state)).toBe('https://c-abc123.cloud.example.com');
		delete process.env.OAUTH_REDIRECT_URI;
		const plain = new Map<string, string>();
		try {
			connect({ cookies: { set: (k: string, v: string) => plain.set(k, v) }, url: new URL('https://c-abc123.cloud.example.com/auth/connect') } as never);
		} catch { /* redirect */ }
		expect(originFromState(plain.get('osc_oauth_state')!)).toBeNull(); // a normal install adds nothing
	});
});
