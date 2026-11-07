/**
 * OAuth sign-in for the MCP endpoint, so claude.ai's custom connector can use "Sign in" instead of a pasted key.
 *
 * The flow (public client, authorization code + PKCE S256, refresh tokens that rotate):
 *   1. /oauth/register   the client registers its callback address (dynamic client registration).
 *   2. /oauth/authorize  the owner signs in with the admin password and approves; we hand back a one-time code.
 *   3. /oauth/token      the client trades the code (plus its PKCE verifier) for an access token and a refresh token.
 * An access token is an ordinary API key row (osc_...) with an expiry, so the MCP endpoint, its rate limits, site scoping and the
 * revoke button on the Agents page all work unchanged. Refreshing swaps that key's secret in place.
 */
import { createHash, randomBytes } from 'node:crypto';
import { config } from './config';
import { audit, db } from './db';
import { createApiKey, deleteApiKey, rotateApiKey } from './apikeys';
import { callbackUrl, challengeValid, cleanName, parseForm, pkceMatches, redirectMatches, resourceMatches, resourceUrl, SCOPE } from './oauth-core';

export const CODE_TTL_MS = 5 * 60_000;
export const REQUEST_TTL_MS = 10 * 60_000;
export const ACCESS_TTL_MS = 60 * 60_000;
export const REFRESH_TTL_MS = 60 * 24 * 3600_000; // a refresh token unused for 60 days stops working
export const MAX_CLIENTS = 200;

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const rand = (bytes = 32) => randomBytes(bytes).toString('base64url');

// ── a small fixed-window limiter for the public endpoints ──────────────────────────────────────
const buckets = new Map<string, { n: number; reset: number }>();
const MAX_BUCKETS = 5000;
/** Counts one use of `bucket` by `key`; false once it has been used more than `max` times within `windowMs`. */
export function withinLimit(bucket: string, key: string, max: number, windowMs: number, now = Date.now()): boolean {
	if (buckets.size >= MAX_BUCKETS) {
		for (const [k, v] of buckets) if (v.reset <= now) buckets.delete(k);
		if (buckets.size >= MAX_BUCKETS) buckets.clear(); // an attacker filling the table gets a fresh start, not unbounded memory
	}
	const id = `${bucket}|${key}`;
	const cur = buckets.get(id);
	if (!cur || cur.reset <= now) {
		buckets.set(id, { n: 1, reset: now + windowMs });
		return true;
	}
	cur.n++;
	return cur.n <= max;
}
export const resetOAuthLimits = () => buckets.clear();

// ── discovery documents ──────────────────────────────────────────────────────────────────────
export const protectedResourceMetadata = (origin: string) => ({
	resource: resourceUrl(origin),
	authorization_servers: [origin],
	scopes_supported: [SCOPE],
	bearer_methods_supported: ['header'],
	resource_name: 'SEOConsole (read-only search data)'
});

export const authorizationServerMetadata = (origin: string) => ({
	issuer: origin,
	authorization_endpoint: `${origin}/oauth/authorize`,
	token_endpoint: `${origin}/oauth/token`,
	registration_endpoint: `${origin}/oauth/register`,
	response_types_supported: ['code'],
	grant_types_supported: ['authorization_code', 'refresh_token'],
	code_challenge_methods_supported: ['S256'],
	token_endpoint_auth_methods_supported: ['none'], // public clients only; no secret exists to leak
	scopes_supported: [SCOPE],
	authorization_response_iss_parameter_supported: true
});

// ── clients ──────────────────────────────────────────────────────────────────────────────────
export interface OAuthClient { id: string; name: string; redirectUris: string[] }

/** Stores a registered client, or returns null if the table is full of clients that are in use. Unused ones, oldest first, make room. */
export function registerClient(name: string, redirectUris: string[]): OAuthClient | null {
	const d = db();
	const count = () => (d.prepare('SELECT COUNT(*) n FROM oauth_clients').get() as { n: number }).n;
	if (count() >= MAX_CLIENTS) {
		d.prepare('DELETE FROM oauth_clients WHERE id IN (SELECT c.id FROM oauth_clients c WHERE NOT EXISTS (SELECT 1 FROM oauth_grants g WHERE g.client_id = c.id) ORDER BY c.created_at LIMIT ?)').run(Math.max(1, MAX_CLIENTS / 4));
		if (count() >= MAX_CLIENTS) return null;
	}
	const c = { id: `ocl_${rand(16)}`, name: cleanName(name), redirectUris };
	d.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)').run(c.id, c.name, JSON.stringify(c.redirectUris), Date.now());
	return c;
}

export function getClient(id: string | null | undefined): OAuthClient | undefined {
	if (!id) return undefined;
	const r = db().prepare('SELECT id, name, redirect_uris FROM oauth_clients WHERE id = ?').get(id) as { id: string; name: string; redirect_uris: string } | undefined;
	return r ? { id: r.id, name: r.name, redirectUris: JSON.parse(r.redirect_uris) as string[] } : undefined;
}

// ── authorization requests ───────────────────────────────────────────────────────────────────
export type AuthorizeCheck =
	| { kind: 'error'; message: string } // shown to the person; never redirected, because the address cannot be trusted
	| { kind: 'redirect'; location: string } // an error handed back to the client at its own registered address
	| { kind: 'consent'; requestId: string; clientName: string; redirectHost: string };

/** Forget what has expired. Called whenever the flow is used, so no timer is needed. */
function prune(now: number) {
	const d = db();
	d.prepare('DELETE FROM oauth_requests WHERE created_at < ?').run(now - REQUEST_TTL_MS);
	d.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(now - REQUEST_TTL_MS); // kept a while after expiry so a replay is recognised as one
}

/** Checks an /authorize request. Only when it is sound is anything stored, and what is stored is what the consent screen acts on. */
export function checkAuthorize(search: string, origin: string, now = Date.now()): AuthorizeCheck {
	prune(now);
	const q = parseForm(search.replace(/^\?/, ''));
	if (!q) return { kind: 'error', message: 'This sign-in link repeats a parameter, so it was refused.' };
	const client = getClient(q.get('client_id'));
	if (!client) return { kind: 'error', message: 'This sign-in link names an app this server does not know. Start again from the app.' };
	const redirect = q.get('redirect_uri') ?? '';
	if (!redirectMatches(client.redirectUris, redirect)) return { kind: 'error', message: 'This sign-in link comes back to an address the app did not register, so it was refused.' };
	const state = q.get('state');
	const fail = (error: string, description: string) => ({ kind: 'redirect' as const, location: callbackUrl(redirect, { error, error_description: description, state }, origin) });
	if (state != null && state.length > 512) return fail('invalid_request', 'state is too long');
	if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported.');
	const challenge = q.get('code_challenge') ?? '';
	if (q.get('code_challenge_method') !== 'S256' || !challengeValid(challenge)) return fail('invalid_request', 'PKCE with the S256 method is required.');
	if (!resourceMatches(q.get('resource'), origin)) return fail('invalid_target', 'The resource must be this server\'s MCP endpoint.');
	const id = rand(24);
	db().prepare('INSERT INTO oauth_requests (id, client_id, redirect_uri, code_challenge, state, created_at) VALUES (?,?,?,?,?,?)').run(id, client.id, redirect, challenge, state, now);
	return { kind: 'consent', requestId: id, clientName: client.name, redirectHost: new URL(redirect).host };
}

/** Takes a waiting request out of the table, once. A second use, or one that waited too long, finds nothing. */
function takeRequest(id: string, now: number) {
	const d = db();
	const row = d.prepare('SELECT id, client_id, redirect_uri, code_challenge, state, created_at FROM oauth_requests WHERE id = ?').get(id) as
		| { id: string; client_id: string; redirect_uri: string; code_challenge: string; state: string | null; created_at: number }
		| undefined;
	if (!row || d.prepare('DELETE FROM oauth_requests WHERE id = ?').run(id).changes !== 1) return undefined;
	return row.created_at + REQUEST_TTL_MS > now ? row : undefined;
}

/** The owner approved: a one-time code, and the address to send them (and the code) back to. `siteIds` null means every site. */
export function approveRequest(requestId: string, siteIds: number[] | null, now = Date.now(), canWrite = false): { location: string } | undefined {
	const req = takeRequest(requestId, now);
	if (!req) return undefined;
	const client = getClient(req.client_id);
	if (!client) return undefined;
	const code = rand(32);
	db().prepare('INSERT INTO oauth_codes (hash, client_id, redirect_uri, code_challenge, site_ids, expires_at, can_write) VALUES (?,?,?,?,?,?,?)').run(sha(code), req.client_id, req.redirect_uri, req.code_challenge, siteIds && siteIds.length ? JSON.stringify(siteIds) : null, now + CODE_TTL_MS, canWrite ? 1 : 0);
	audit('oauth.approve', { detail: `${client.name}${canWrite ? ' (changes allowed)' : ' (read-only)'}` });
	return { location: callbackUrl(req.redirect_uri, { code, state: req.state }, config.origin) };
}

export function denyRequest(requestId: string, now = Date.now()): { location: string } | undefined {
	const req = takeRequest(requestId, now);
	if (!req) return undefined;
	audit('oauth.deny', { detail: getClient(req.client_id)?.name ?? req.client_id });
	return { location: callbackUrl(req.redirect_uri, { error: 'access_denied', error_description: 'The owner declined.', state: req.state }, config.origin) };
}

// ── the token endpoint ───────────────────────────────────────────────────────────────────────
export type TokenError = 'invalid_request' | 'invalid_grant' | 'unsupported_grant_type';
export type TokenResult =
	| { ok: true; body: { access_token: string; token_type: 'Bearer'; expires_in: number; refresh_token: string; scope: string } }
	| { ok: false; error: TokenError; description: string };
const refused = (error: TokenError, description: string): TokenResult => ({ ok: false, error, description });

function tokenBody(accessToken: string, refreshToken: string): TokenResult {
	return { ok: true, body: { access_token: accessToken, token_type: 'Bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refreshToken, scope: SCOPE } };
}

/** authorization_code grant. The code is spent the moment it is looked up, so a wrong verifier or a wrong address burns it; a second use revokes what the first one produced. */
export function redeemCode(p: { code: string; clientId: string; redirectUri: string; verifier: string }, now = Date.now()): TokenResult {
	const { code, clientId, redirectUri, verifier } = p;
	if (!code || !clientId || !redirectUri || !verifier) return refused('invalid_request', 'code, client_id, redirect_uri and code_verifier are all required.');
	const d = db();
	const row = d.prepare('SELECT hash, client_id, redirect_uri, code_challenge, site_ids, expires_at, used, key_id, can_write FROM oauth_codes WHERE hash = ?').get(sha(code)) as
		| { hash: string; client_id: string; redirect_uri: string; code_challenge: string; site_ids: string | null; expires_at: number; used: number; key_id: number | null; can_write: number }
		| undefined;
	if (!row) return refused('invalid_grant', 'Unknown or expired code.');
	if (row.used) {
		// Replay: someone has this code besides the client it was given to. Take back the token the first use produced.
		if (row.key_id != null) deleteApiKey(row.key_id);
		return refused('invalid_grant', 'This code was already used.');
	}
	if (d.prepare('UPDATE oauth_codes SET used = 1 WHERE hash = ? AND used = 0').run(row.hash).changes !== 1) return refused('invalid_grant', 'This code was already used.');
	if (row.expires_at <= now) return refused('invalid_grant', 'Unknown or expired code.');
	if (row.client_id !== clientId) return refused('invalid_grant', 'This code was issued to a different app.');
	if (row.redirect_uri !== redirectUri) return refused('invalid_grant', 'redirect_uri does not match the sign-in request.');
	if (!pkceMatches(verifier, row.code_challenge)) return refused('invalid_grant', 'code_verifier does not match the code_challenge.');
	const client = getClient(clientId);
	if (!client) return refused('invalid_grant', 'Unknown app.');

	const key = createApiKey(`${client.name} (sign-in)`, row.site_ids ? (JSON.parse(row.site_ids) as number[]) : null, now + ACCESS_TTL_MS, row.can_write === 1);
	const refresh = `ocr_${rand(32)}`;
	d.prepare('INSERT INTO oauth_grants (client_id, key_id, refresh_hash, refresh_expires_at, created_at) VALUES (?,?,?,?,?)').run(clientId, key.id, sha(refresh), now + REFRESH_TTL_MS, now);
	d.prepare('UPDATE oauth_codes SET key_id = ? WHERE hash = ?').run(key.id, row.hash);
	audit('oauth.token', { detail: client.name });
	return tokenBody(key.key, refresh);
}

/**
 * refresh_token grant. Each refresh token works once: using it returns a new one and a new access token. If an OLD refresh token
 * turns up again, two parties hold the same grant, so the whole grant is revoked (OAuth 2.1 section 4.3.1).
 */
export function refreshTokens(p: { refreshToken: string; clientId: string }, now = Date.now()): TokenResult {
	const { refreshToken, clientId } = p;
	if (!refreshToken || !clientId) return refused('invalid_request', 'refresh_token and client_id are required.');
	const d = db();
	const h = sha(refreshToken);
	const row = d.prepare('SELECT id, client_id, key_id, refresh_expires_at FROM oauth_grants WHERE refresh_hash = ?').get(h) as { id: number; client_id: string; key_id: number; refresh_expires_at: number } | undefined;
	if (!row) {
		const old = d.prepare('SELECT key_id FROM oauth_grants WHERE prev_refresh_hash = ?').get(h) as { key_id: number } | undefined;
		if (old) deleteApiKey(old.key_id); // replay of a superseded refresh token: revoke the grant (its row goes with the key)
		return refused('invalid_grant', 'The refresh token is not valid.');
	}
	if (row.client_id !== clientId) return refused('invalid_grant', 'The refresh token was issued to a different app.');
	if (row.refresh_expires_at <= now) {
		deleteApiKey(row.key_id);
		return refused('invalid_grant', 'The refresh token has expired. Sign in again.');
	}
	const access = rotateApiKey(row.key_id, now + ACCESS_TTL_MS);
	if (!access) return refused('invalid_grant', 'The sign-in was revoked.');
	const next = `ocr_${rand(32)}`;
	d.prepare('UPDATE oauth_grants SET refresh_hash = ?, prev_refresh_hash = ?, refresh_expires_at = ? WHERE id = ?').run(sha(next), h, now + REFRESH_TTL_MS, row.id);
	return tokenBody(access, next);
}

/** For the Agents page: which keys are OAuth sign-ins, and for which app. */
export function oauthLabels(): Map<number, string> {
	const rows = db().prepare('SELECT g.key_id, c.name FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id').all() as { key_id: number; name: string }[];
	return new Map(rows.map((r) => [r.key_id, r.name]));
}
