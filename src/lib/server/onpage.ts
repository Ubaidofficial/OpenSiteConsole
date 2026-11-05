import { db } from './db';
import { hostsMatch } from './hosts';
import { getSite } from './clients';
import { periodFor, topPages } from './queries';
import { checkPage, onPageScore, parseOnPage, type PageCheck } from '../onpage';
import { demoPageFetch } from './demo-channels';

const MAX_BYTES = 1_500_000;
const MAX_HOPS = 4;
const TIMEOUT_MS = 10_000;

export interface Fetched { status: number; finalUrl: string; html: string | null; error?: string }

/**
 * Fetch one page for checking. Server-side fetching of user-supplied URLs is a classic SSRF hole, so: only http(s), only
 * the site's own host (checked again on every redirect hop, redirects are followed by hand), a 10 s timeout and a
 * 1.5 MB cap. HTML only. Nothing from the response other than the parsed tags is kept.
 */
export async function fetchPage(url: string, siteUrl: string, fetchImpl: typeof fetch = fetch): Promise<Fetched> {
	let current = url;
	for (let hop = 0; hop <= MAX_HOPS; hop++) {
		let u: URL;
		try {
			u = new URL(current);
		} catch {
			return { status: 0, finalUrl: current, html: null, error: 'Not a valid URL.' };
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') return { status: 0, finalUrl: current, html: null, error: 'Only http and https URLs can be checked.' };
		if (!hostsMatch(current, siteUrl)) return { status: 0, finalUrl: current, html: null, error: hop ? `Redirects to another site (${u.host}); not followed.` : 'That URL is not on this site.' };
		let res: Response;
		try {
			res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': 'OpenSiteConsole-OnPageCheck/1.0 (+self-hosted)', accept: 'text/html,application/xhtml+xml' } });
		} catch (e) {
			return { status: 0, finalUrl: current, html: null, error: e instanceof Error && e.name === 'TimeoutError' ? 'Timed out after 10 seconds.' : 'Could not fetch the page.' };
		}
		if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
			current = new URL(res.headers.get('location')!, current).href;
			continue;
		}
		if (!res.ok) return { status: res.status, finalUrl: current, html: null, error: `The page answered ${res.status}.` };
		if (!/html|xml/i.test(res.headers.get('content-type') ?? 'text/html')) return { status: res.status, finalUrl: current, html: null, error: 'Not an HTML page.' };
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
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : fetch);
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
				ok++;
				const check = checkPage(parseOnPage(f.html), topQueriesFor(siteId, u), { pageUrl: f.finalUrl });
				payload = { status: f.status, finalUrl: f.finalUrl, ...check, score: onPageScore(check.issues) };
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
