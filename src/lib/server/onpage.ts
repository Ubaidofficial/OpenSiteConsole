import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { Readable } from 'node:stream';
import { db } from './db';
import { env } from './config';
import { hostKey } from './hosts';
import { getSite } from './clients';
import { periodFor, topPages } from './queries';
import { checkPage, onPageScore, parseOnPage, type PageCheck } from '../onpage';
import { demoPageFetch } from './demo-channels';

const MAX_BYTES = 1_500_000;
const MAX_HOPS = 4;
const TIMEOUT_MS = 10_000;

/** ONPAGE_ALLOW_PRIVATE=1 lets the check reach private addresses and non-standard ports: for sites on an intranet or a dev machine. */
const allowPrivate = () => env('ONPAGE_ALLOW_PRIVATE') === '1';

/** Loopback, private, link-local (cloud metadata lives at 169.254.169.254), carrier-grade NAT, multicast and reserved ranges. */
export function isPrivateIp(addr: string): boolean {
	const a = addr.replace(/^\[|\]$/g, '').toLowerCase();
	const v = net.isIP(a);
	if (v === 4) {
		const [p, q] = a.split('.').map(Number);
		return p === 0 || p === 10 || p === 127 || p >= 224 || (p === 169 && q === 254) || (p === 172 && q >= 16 && q <= 31) || (p === 192 && q === 168) || (p === 100 && q >= 64 && q <= 127) || (p === 192 && q === 0);
	}
	if (v === 6) {
		if (a === '::' || a === '::1') return true;
		const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
		if (mapped) return isPrivateIp(mapped[1]);
		return /^f[cd]/.test(a) || /^fe[89ab]/.test(a) || /^ff/.test(a);
	}
	return false;
}

/**
 * The page must be on the site itself: its host, or a subdomain of it (never a parent domain, never an IP address, only the
 * standard ports). The URL comes from Search Console, but the property's DNS is not under this app's control, so this is only
 * the first of two checks: guardedFetch also refuses private addresses at connect time.
 */
export function hostAllowed(url: string, siteUrl: string): boolean {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return false;
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
	if (allowPrivate()) return hostKey(url) === hostKey(siteUrl) || hostKey(url).endsWith('.' + hostKey(siteUrl));
	if (u.port && u.port !== '80' && u.port !== '443') return false;
	if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) return false;
	const h = hostKey(url);
	const site = hostKey(siteUrl);
	return h === site || h.endsWith('.' + site);
}

/**
 * fetch over node:http(s) whose DNS lookup refuses private addresses AT CONNECT TIME, so a name that resolves to 127.0.0.1 or
 * 169.254.169.254, or that is re-pointed between a check and the connection (DNS rebinding), is never connected to. IP literals
 * skip the lookup hook entirely, so they are checked up front. Redirects are not followed; fetchPage does that by hand.
 */
export const guardedFetch = ((input: RequestInfo | URL, init: RequestInit = {}) =>
	new Promise<Response>((resolve, reject) => {
		const u = new URL(String(input));
		if (!allowPrivate() && net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateIp(u.hostname)) return reject(new Error('Private address refused'));
		const lookup = (hostname: string, options: dns.LookupOptions, cb: (...a: any[]) => void) => {
			dns.lookup(hostname, options, (err, address, family) => {
				if (err) return cb(err, address, family);
				const list = Array.isArray(address) ? address.map((x) => x.address) : [address as string];
				if (!allowPrivate() && list.some(isPrivateIp)) return cb(Object.assign(new Error('Private address refused'), { code: 'EPRIVATE' }), '', 0);
				cb(null, address, family);
			});
		};
		const req = (u.protocol === 'https:' ? https : http).request(u, { method: 'GET', headers: init.headers as Record<string, string>, lookup: lookup as never }, (res) => {
			const headers = new Headers();
			for (const [k, v] of Object.entries(res.headers)) for (const x of Array.isArray(v) ? v : v === undefined ? [] : [v]) headers.append(k, x);
			const status = res.statusCode ?? 0;
			const bodyless = [204, 205, 304].includes(status) || (status >= 300 && status < 400);
			if (bodyless) res.resume();
			resolve(new Response(bodyless ? null : (Readable.toWeb(res) as ReadableStream), { status, headers }));
		});
		req.on('error', reject);
		init.signal?.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
		req.end();
	})) as typeof fetch;

export interface Fetched { status: number; finalUrl: string; html: string | null; error?: string }

/**
 * Fetch one page for checking: only the site's own host (see hostAllowed, checked again on every redirect hop; redirects are
 * followed by hand), a 10 s timeout, a 1.5 MB cap, HTML only. Nothing from the response other than the parsed tags is kept.
 * Never throws: every failure becomes an `error`.
 */
export async function fetchPage(url: string, siteUrl: string, fetchImpl: typeof fetch = guardedFetch): Promise<Fetched> {
	let current = url;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		let u: URL;
		try {
			u = new URL(current);
		} catch {
			return { status: 0, finalUrl: current, html: null, error: 'Not a valid URL.' };
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 0, finalUrl: current, html: null, error: 'Only http and https URLs can be checked.' };
		if (!hostAllowed(current, siteUrl)) return { status: 0, finalUrl: current, html: null, error: hop ? `Redirects to ${u.host}, which is not part of this site; not followed.` : 'That URL is not on this site.' };
		let res: Response;
		try {
			res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'OpenSiteConsole-OnPageCheck/1.0 (+self-hosted)', accept: 'text/html,application/xhtml+xml' } });
		} catch (e) {
			const code = (e as { code?: string; cause?: { code?: string } }).code ?? (e as { cause?: { code?: string } }).cause?.code;
			return { status: 0, finalUrl: current, html: null, error: e instanceof Error && e.name === 'TimeoutError' ? 'Timed out after 10 seconds.' : code === 'EPRIVATE' || (e instanceof Error && /Private address/.test(e.message)) ? 'That address is private, so it is not fetched (set ONPAGE_ALLOW_PRIVATE=1 if this site really lives on your own network).' : 'Could not fetch the page.' };
		}
		const drop = () => void res.body?.cancel().catch(() => {});
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			drop();
			try {
				current = new URL(res.headers.get('location')!, current).href;
			} catch {
				return { status: res.status, finalUrl: current, html: null, error: 'Bad redirect.' };
			}
			continue;
		}
		if (!res.ok) { drop(); return { status: res.status, finalUrl: current, html: null, error: `The page answered ${res.status}.` }; }
		if (!/html|xml/i.test(res.headers.get('content-type') ?? 'text/html')) { drop(); return { status: res.status, finalUrl: current, html: null, error: 'Not an HTML page.' }; }
		try {
			const reader = res.body?.getReader();
			if (!reader) return { status: res.status, finalUrl: current, html: (await res.text()).slice(0, MAX_BYTES) };
			const chunks: Uint8Array[] = [];
			let size = 0;
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.length;
				chunks.push(value);
				if (size >= MAX_BYTES) {
					await reader.cancel();
					break;
				}
			}
			return { status: res.status, finalUrl: current, html: Buffer.concat(chunks).subarray(0, MAX_BYTES).toString('utf8') };
		} catch (e) {
			return { status: res.status, finalUrl: current, html: null, error: e instanceof Error && e.name === 'TimeoutError' ? 'Timed out reading the page.' : 'The connection broke while reading the page.' };
		}
	}
	return { status: 0, finalUrl: current, html: null, error: 'Too many redirects.' };
}

export interface StoredCheck extends Partial<PageCheck> { status: number; finalUrl: string; error?: string; score: number | null }

/** The queries a page earns the most clicks for, over the last 90 days. */
function topQueriesFor(siteId: number, page: string, n = 5) {
	return db()
		.prepare("SELECT query, SUM(clicks) clicks FROM sa_rows WHERE site_id = ? AND page = ? AND date >= date((SELECT MAX(date) FROM site_daily WHERE site_id = ?), '-90 day') GROUP BY query ORDER BY clicks DESC, SUM(impressions) DESC LIMIT ?")
		.all(siteId, page, siteId, n) as { query: string; clicks: number }[];
}

export async function checkUrls(siteId: number, urls: string[], o: { fetchImpl?: typeof fetch; max?: number } = {}) {
	const site = getSite(siteId)!;
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number }).is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : guardedFetch);
	const queue = [...new Set(urls)].slice(0, o.max ?? 25);
	const put = db().prepare('INSERT OR REPLACE INTO onpage_checks (site_id, url, checked_at, payload) VALUES (?,?,?,?)');
	let ok = 0;
	let failed = 0;
	const worker = async () => {
		for (let u = queue.shift(); u; u = queue.shift()) {
			const f = await fetchPage(u, site.site_url, fetchImpl);
			let payload: StoredCheck;
			if (!f.html) {
				failed++;
				payload = { status: f.status, finalUrl: f.finalUrl, error: f.error, score: null };
			} else {
				try {
					const check = checkPage(parseOnPage(f.html), topQueriesFor(siteId, u), { pageUrl: f.finalUrl });
					payload = { status: f.status, finalUrl: f.finalUrl, ...check, score: onPageScore(check.issues) };
					ok++;
				} catch {
					// One page the parser chokes on must not take the whole run down.
					failed++;
					payload = { status: f.status, finalUrl: f.finalUrl, error: 'The page could not be read.', score: null };
				}
			}
			put.run(siteId, u, Date.now(), JSON.stringify(payload));
		}
	};
	await Promise.all([worker(), worker(), worker(), worker()]);
	return { ok, failed };
}

/** Biggest pages by clicks in the last 28 days: where a title or heading fix pays most. */
export const pagesToCheck = (siteId: number, n = 15) => {
	const p = periodFor(getSite(siteId)!, 28);
	return topPages(siteId, p.start, p.end, {}, n).map((r) => r.page);
};

export function storedChecks(siteId: number) {
	return (db().prepare('SELECT url, checked_at, payload FROM onpage_checks WHERE site_id = ? ORDER BY checked_at DESC').all(siteId) as { url: string; checked_at: number; payload: string }[]).map((r) => ({ url: r.url, checkedAt: r.checked_at, ...(JSON.parse(r.payload) as StoredCheck) }));
}
