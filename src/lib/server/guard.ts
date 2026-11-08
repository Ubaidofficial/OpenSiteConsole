/**
 * Decides whether a request may be served WITHOUT a password. Only a request that really comes from this machine qualifies.
 *
 * Judging by the address in the URL is not enough: that address comes from the ORIGIN setting, so an app started with
 * HOST=0.0.0.0 and ORIGIN=http://localhost:5173 would treat every visitor on the network as local. So the connection's own peer
 * address must be loopback too, and any sign of a reverse proxy in front (which makes every visitor look like the proxy) means
 * "not local".
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const PROXY_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'cf-connecting-ip', 'true-client-ip', 'via'];

export function isLoopbackAddress(addr: string | null | undefined): boolean {
	if (!addr) return false;
	const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, '');
	if (a === '::1') return true;
	const v4 = a.startsWith('::ffff:') ? a.slice(7) : a;
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** Host name from a Host header value ("localhost:5173" -> "localhost", "[::1]:80" -> "[::1]"); null if absent. */
export function hostnameOf(hostHeader: string | null | undefined): string | null {
	if (!hostHeader) return null;
	const h = hostHeader.trim().toLowerCase();
	if (h.startsWith('[')) return h.slice(0, h.indexOf(']') + 1) || null;
	return h.split(':')[0] || null;
}

/**
 * `hostHeader` is the Host header the client actually sent. It matters for DNS rebinding: a malicious website can point its own
 * name at 127.0.0.1, and the owner's browser then reaches this app (from a loopback address, with no proxy headers) with a Host
 * header naming the attacker's site. Only a Host header that itself says localhost is local.
 */
export function isLocalRequest(hostHeader: string | null, peer: string | null, headers: Headers): boolean {
	const hostname = hostnameOf(hostHeader);
	if (!hostname || !LOOPBACK_HOSTS.has(hostname)) return false;
	if (!isLoopbackAddress(peer)) return false;
	return !PROXY_HEADERS.some((h) => headers.has(h));
}

/** Where to send the browser back to after an action: the Referer's path, but only if it points into this app. */
export function safeBack(referer: string | null, origin: string, fallback: string): string {
	try {
		const r = new URL(referer ?? '');
		if (r.origin === origin) return r.pathname + r.search;
	} catch {
		/* no usable Referer */
	}
	return fallback;
}

/**
 * The visitor's address for counting login attempts. If the server is told to read it from a proxy header
 * (ADDRESS_HEADER) and a request arrives without that header, SvelteKit throws; a request that bypassed the proxy must not become
 * a 500 on the login page, so it is counted in one shared "unknown" bucket instead.
 */
export function clientKey(getClientAddress: () => string): string {
	try {
		return getClientAddress() || 'unknown';
	} catch {
		return 'unknown';
	}
}

const FORM_TYPES = new Set(['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain']);
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Should this request be refused as a cross-site attack? Used for every request that can change something.
 *
 * Programs that call us from a server (the MCP endpoint, OAuth registration and token exchange) send no browser headers and carry no cookie, so
 * there is nothing to forge: `programEndpoint` exempts them. For everything else:
 *  - a request that names a different origin, or that the browser marks cross-site, is refused;
 *  - a form-type POST/PUT/PATCH/DELETE must come from this origin. That is SvelteKit's own check (which only runs when it is switched on in
 *    svelte.config.js; it cannot exempt a path, so it is off and this function does the same job with the exemption), so a bare form POST
 *    with no Origin header is refused here too.
 */
export function crossSiteRefused(o: { method: string; origin: string | null; secFetchSite: string | null; contentType: string | null; urlOrigin: string; programEndpoint: boolean }): boolean {
	if (SAFE_METHODS.has(o.method.toUpperCase())) return false;
	if (o.programEndpoint) return false;
	if (o.origin && o.origin !== o.urlOrigin) return true;
	if (o.secFetchSite === 'cross-site') return true;
	const type = (o.contentType ?? '').split(';')[0].trim().toLowerCase();
	return FORM_TYPES.has(type) && o.origin !== o.urlOrigin;
}

/** Where to return after an outside sign-in: a path inside this app only (never //host, a backslash trick or a full URL). */
export const safeReturn = (p: string | null | undefined) => (p && /^\/(?![\/\\])[\w\-./?=&%]*$/.test(p) ? p : null);
