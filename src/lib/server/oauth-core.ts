/**
 * OAuth for the MCP endpoint, the parts that need no database: PKCE, redirect-address rules, client registration checks, form
 * parsing. Kept pure so every rule can be tested on its own. The flow itself is in oauth.ts and the routes under /oauth.
 *
 * What Claude requires of the server is documented at https://claude.com/docs/connectors/building/authentication.md
 * (PKCE S256 on every request, a 401 that points at the discovery document, dynamic client registration, a form-encoded token
 * endpoint, refresh tokens that rotate, the fixed callback https://claude.ai/api/mcp/auth_callback and a loopback callback for Claude Code).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const SCOPE = 'mcp';

/** Callback addresses a client may register without any setting. Everything else on the internet needs MCP_OAUTH_REDIRECTS. */
export const DEFAULT_REDIRECTS = ['https://claude.ai/api/mcp/auth_callback'];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const b64url = (b: Buffer) => b.toString('base64url');

/** RFC 7636: the challenge is the base64url of the verifier's SHA-256. */
export const pkceChallenge = (verifier: string) => b64url(createHash('sha256').update(verifier, 'ascii').digest());

/** RFC 7636 section 4.1: 43 to 128 characters from the unreserved set. */
export const verifierValid = (v: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(v);
/** A SHA-256 challenge is always exactly 43 base64url characters. */
export const challengeValid = (c: string) => /^[A-Za-z0-9_-]{43}$/.test(c);

/** Whether a verifier proves possession of a challenge. Constant-time, and false for malformed input. */
export function pkceMatches(verifier: string, challenge: string): boolean {
	if (!verifierValid(verifier) || !challengeValid(challenge)) return false;
	const a = Buffer.from(pkceChallenge(verifier)), b = Buffer.from(challenge);
	return a.length === b.length && timingSafeEqual(a, b);
}

/** A redirect address as a URL, or null when it is not one this server would ever use (too long, a fragment, credentials, a scheme other than http/https). */
export function parseRedirect(uri: unknown): URL | null {
	if (typeof uri !== 'string' || uri.length === 0 || uri.length > 512 || /[\s\u0000-\u001f]/.test(uri)) return null;
	let u: URL;
	try {
		u = new URL(uri);
	} catch {
		return null;
	}
	if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
	if (u.hash || uri.includes('#') || u.username || u.password) return null;
	return u;
}

export const isLoopback = (u: URL) => u.protocol === 'http:' && LOOPBACK_HOSTS.has(u.hostname);

/** Settings value: exact callback addresses to allow in addition to the defaults, comma separated. Anything that is not a valid https address is ignored. */
export function extraRedirects(setting: string | undefined): string[] {
	return (setting ?? '').split(',').map((s) => s.trim()).filter(Boolean).filter((s) => parseRedirect(s)?.protocol === 'https:');
}

/** May a client register this callback? Loopback addresses (desktop and command-line clients) and the exact allowed https addresses. */
export function redirectRegisterable(uri: unknown, extra: string[] = []): boolean {
	const u = parseRedirect(uri);
	if (!u) return false;
	if (isLoopback(u)) return true;
	if (u.protocol !== 'https:') return false;
	return [...DEFAULT_REDIRECTS, ...extra].some((a) => parseRedirect(a)?.href === u.href);
}

/**
 * Does the address in an authorization request match one the client registered? Exact, except that a loopback address may use
 * any port (RFC 8252 section 7.3: a command-line client picks a free port each time). The scheme, host and path still have to match.
 */
export function redirectMatches(registered: string[], candidate: unknown): boolean {
	const c = parseRedirect(candidate);
	if (!c) return false;
	return registered.some((r) => {
		const u = parseRedirect(r);
		if (!u) return false;
		if (isLoopback(u) && isLoopback(c)) return u.hostname === c.hostname && u.pathname === c.pathname && u.search === c.search;
		return u.href === c.href;
	});
}

/** A client name for a screen: control characters removed, spaces collapsed, at most 80 characters. Never trusted as markup; it is only ever shown as text. */
export function cleanName(s: unknown): string {
	const t = typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
	return t || 'MCP client';
}

export type Registration = { ok: true; name: string; redirectUris: string[] } | { ok: false; error: 'invalid_redirect_uri' | 'invalid_client_metadata'; description: string };

/** Checks an RFC 7591 client registration. Only public clients that use the authorization-code flow are accepted. */
export function parseRegistration(body: unknown, extra: string[] = []): Registration {
	const bad = (error: 'invalid_redirect_uri' | 'invalid_client_metadata', description: string): Registration => ({ ok: false, error, description });
	if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('invalid_client_metadata', 'The registration must be a JSON object.');
	const b = body as Record<string, unknown>;
	const uris = b.redirect_uris;
	if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) return bad('invalid_redirect_uri', 'redirect_uris must list between 1 and 5 addresses.');
	for (const u of uris) if (!redirectRegisterable(u, extra)) return bad('invalid_redirect_uri', 'A redirect address is not allowed for this server. Only the Claude callback and loopback addresses are accepted.');
	const grants = b.grant_types;
	if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => g === 'authorization_code' || g === 'refresh_token'))) return bad('invalid_client_metadata', 'Only the authorization_code and refresh_token grants are supported.');
	const types = b.response_types;
	if (types !== undefined && (!Array.isArray(types) || !types.every((t) => t === 'code'))) return bad('invalid_client_metadata', 'Only the code response type is supported.');
	const method = b.token_endpoint_auth_method;
	if (method !== undefined && method !== 'none') return bad('invalid_client_metadata', 'Only public clients are supported (token_endpoint_auth_method "none").');
	return { ok: true, name: cleanName(b.client_name), redirectUris: [...new Set(uris as string[])] };
}

/** Parses an application/x-www-form-urlencoded body. A parameter that appears twice is an error (RFC 6749 section 3.2), signalled by null. */
export function parseForm(text: string): Map<string, string> | null {
	const out = new Map<string, string>();
	for (const [k, v] of new URLSearchParams(text)) {
		if (out.has(k)) return null;
		out.set(k, v);
	}
	return out;
}

/** The address of the MCP endpoint, which is the "resource" a token is for. */
export const resourceUrl = (origin: string) => `${origin}/api/mcp`;
/** RFC 8707 resource indicator: absent is fine; present has to name this server's MCP endpoint (a trailing slash is ignored). */
export const resourceMatches = (resource: string | null | undefined, origin: string) => !resource || resource.replace(/\/+$/, '') === resourceUrl(origin);

/**
 * Where to send someone after the sign-in page: only the authorization page itself, so a crafted link cannot bounce them anywhere else.
 * The result is a path on this site (it starts with /oauth/authorize), so a "//" later in the query, as in an unencoded redirect_uri=https://..., is harmless and must be allowed.
 */
export function safeNext(next: string | null | undefined): string | null {
	if (!next || next.length > 2000 || /[\\\r\n\u0000]/.test(next)) return null;
	return next === '/oauth/authorize' || next.startsWith('/oauth/authorize?') ? next : null;
}

/** A redirect back to the client: its own address plus our parameters. The issuer is included (RFC 9207) so a client can tell which server answered. */
export function callbackUrl(redirectUri: string, params: Record<string, string | null | undefined>, issuer: string): string {
	const u = new URL(redirectUri);
	for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
	u.searchParams.set('iss', issuer);
	return u.toString();
}
