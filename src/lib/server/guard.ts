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

export function isLocalRequest(hostname: string, peer: string | null, headers: Headers): boolean {
	if (!LOOPBACK_HOSTS.has(hostname.toLowerCase())) return false;
	if (!isLoopbackAddress(peer)) return false;
	return !PROXY_HEADERS.some((h) => headers.has(h));
}
