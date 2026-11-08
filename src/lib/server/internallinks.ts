/**
 * The internal-link tool: crawl the pages Search Console shows for a site, store their text and links, and suggest which pages
 * should link to the pages that are close to ranking better (striking distance), with the anchor text already on the page.
 * Free and without credits: the crawl uses the same hardened fetcher as the on-page check (this site's own host only, private
 * addresses refused at connect time, 10 s timeout, 1.5 MB cap), four pages at a time. The matching and scoring are in src/lib/linking.ts.
 */
import { db } from './db';
import { config } from './config';
import type { SiteRow } from './clients';
import { getSite } from './clients';
import { brandTerms, fittedCurve, periodFor, queryPageRows } from './queries';
import { fetchPage, guardedFetch, hostAllowed } from './onpage';
import { demoPageFetch } from './demo-channels';
import { computeStriking, isBranded, normalizeUrl } from '../analytics';
import { extractPage, orphanPages, suggestLinks, type LinkTarget, type PageLink, type SourcePage, type Suggestion } from '../linking';

/** A crawl left "running" longer than this belongs to a process that died. */
const STALE_MS = 30 * 60_000;
export const RECRAWL_MS = 7 * 86_400_000;

export interface CrawlInfo { status: 'idle' | 'running'; startedAt: number | null; finishedAt: number | null; pages: number; ok: number; failed: number; error: string | null }

export function crawlInfo(siteId: number, now = Date.now()): CrawlInfo | null {
	const r = db().prepare('SELECT status, started_at, finished_at, pages, ok, failed, error FROM link_crawls WHERE site_id = ?').get(siteId) as { status: string; started_at: number | null; finished_at: number | null; pages: number; ok: number; failed: number; error: string | null } | undefined;
	if (!r) return null;
	const running = r.status === 'running' && !!r.started_at && now - r.started_at < STALE_MS;
	return { status: running ? 'running' : 'idle', startedAt: r.started_at, finishedAt: r.finished_at, pages: r.pages, ok: r.ok, failed: r.failed, error: r.error };
}

/** The pages to crawl: every page Search Console showed in the last 90 days, most impressions first, on this site's own host. */
export function pagesToCrawl(site: SiteRow, max = config.linkCrawlPages): { page: string; clicks: number; impressions: number }[] {
	const p = periodFor(site, 90);
	return (db()
		.prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page HAVING SUM(impressions) > 0 ORDER BY impressions DESC, clicks DESC LIMIT ?')
		.all(site.id, p.start, p.end, Math.max(max * 3, 500)) as { page: string; clicks: number; impressions: number }[])
		.filter((r) => hostAllowed(r.page, site.site_url));
}

/**
 * Fetch up to `max` pages (four at a time) and replace the stored crawl with what came back. Never throws for a page: a page that
 * fails is stored with its error, so the view can say how many could not be read.
 */
export async function crawlLinks(siteId: number, o: { fetchImpl?: typeof fetch; max?: number } = {}): Promise<{ pages: number; ok: number; failed: number }> {
	const site = getSite(siteId);
	if (!site) throw new Error('No such site.');
	const max = Math.min(500, Math.max(1, o.max ?? config.linkCrawlPages));
	const queue = pagesToCrawl(site, max).slice(0, max).map((r) => r.page);
	const d = db();
	if (!queue.length) {
		d.prepare("INSERT INTO link_crawls (site_id, status, started_at, finished_at, pages, ok, failed, error) VALUES (?, 'idle', ?, ?, 0, 0, 0, ?) ON CONFLICT(site_id) DO UPDATE SET status = 'idle', error = excluded.error").run(siteId, Date.now(), Date.now(), 'Search Console has no pages with impressions for this site in the last 90 days yet.');
		return { pages: 0, ok: 0, failed: 0 };
	}
	const isDemo = !!(d.prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : guardedFetch);
	const started = Date.now();
	d.prepare("INSERT INTO link_crawls (site_id, status, started_at, pages) VALUES (?, 'running', ?, ?) ON CONFLICT(site_id) DO UPDATE SET status = 'running', started_at = excluded.started_at, error = NULL").run(siteId, started, queue.length);
	type Row = { url: string; final: string; status: number; error: string | null; title: string | null; h1: string | null; body: string; links: PageLink[]; at: number };
	const rows: Row[] = [];
	const todo = [...queue];
	const worker = async () => {
		for (let u = todo.shift(); u; u = todo.shift()) {
			const f = await fetchPage(u, site.site_url, fetchImpl);
			if (!f.html) {
				rows.push({ url: u, final: f.finalUrl, status: f.status, error: f.error ?? 'Could not fetch the page.', title: null, h1: null, body: '', links: [], at: Date.now() });
				continue;
			}
			try {
				const x = extractPage(f.html, f.finalUrl);
				rows.push({ url: u, final: f.finalUrl, status: f.status, error: null, title: x.title, h1: x.h1, body: x.text, links: x.links, at: Date.now() });
			} catch {
				rows.push({ url: u, final: f.finalUrl, status: f.status, error: 'The page could not be read.', title: null, h1: null, body: '', links: [], at: Date.now() });
			}
		}
	};
	try {
		await Promise.all([worker(), worker(), worker(), worker()]);
	} catch (e) {
		d.prepare("UPDATE link_crawls SET status = 'idle', finished_at = ?, error = ? WHERE site_id = ?").run(Date.now(), e instanceof Error ? e.message : 'The crawl failed.', siteId);
		throw e;
	}
	const ok = rows.filter((r) => !r.error).length;
	const failed = rows.length - ok;
	d.transaction(() => {
		d.prepare('DELETE FROM link_pages WHERE site_id = ?').run(siteId);
		const put = d.prepare('INSERT OR REPLACE INTO link_pages (site_id, url, final_url, status, error, title, h1, body, links, fetched_at) VALUES (?,?,?,?,?,?,?,?,?,?)');
		for (const r of rows) put.run(siteId, r.url, r.final, r.status, r.error, r.title, r.h1, r.body, JSON.stringify(r.links), r.at);
		d.prepare("UPDATE link_crawls SET status = 'idle', finished_at = ?, pages = ?, ok = ?, failed = ?, error = NULL WHERE site_id = ?").run(Date.now(), rows.length, ok, failed, siteId);
	})();
	return { pages: rows.length, ok, failed };
}

export interface CrawledPage { url: string; finalUrl: string; status: number; error: string | null; title: string | null; h1: string | null; text: string; links: PageLink[]; fetchedAt: number }

export function crawledPages(siteId: number): CrawledPage[] {
	return (db().prepare('SELECT url, final_url, status, error, title, h1, body, links, fetched_at FROM link_pages WHERE site_id = ? ORDER BY url').all(siteId) as { url: string; final_url: string; status: number; error: string | null; title: string | null; h1: string | null; body: string; links: string; fetched_at: number }[]).map((r) => ({
		url: r.url, finalUrl: r.final_url, status: r.status, error: r.error, title: r.title, h1: r.h1, text: r.body, links: JSON.parse(r.links) as PageLink[], fetchedAt: r.fetched_at
	}));
}

/**
 * The pages worth linking to: pages with searches at positions 4 to 20 and real impressions (the same striking-distance rows and
 * click-curve estimate as the Opportunities tab, brand searches left out), biggest estimated gain first.
 */
export function linkTargets(site: SiteRow, days = 28, max = 40): LinkTarget[] {
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const qp = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	const minImpressions = Math.max(10, Math.round((days / 28) * 30));
	const rows = computeStriking(qp.filter((r) => !isBranded(r.query, terms)), curve, { minImpressions, minPos: 4, maxPos: 20, limit: 5_000 }) as unknown as (ReturnType<typeof computeStriking>[number] & { page: string })[];
	const byPage = new Map<string, LinkTarget>();
	for (const r of rows) {
		if (r.expectedGain <= 0) continue;
		const t = byPage.get(r.page) ?? { page: r.page, queries: [], prize: 0 };
		t.queries.push({ query: r.query, position: r.position, impressions: r.impressions, clicks: r.clicks, prize: r.expectedGain });
		t.prize += r.expectedGain;
		byPage.set(r.page, t);
	}
	return [...byPage.values()].sort((a, b) => b.prize - a.prize).slice(0, max);
}

export const doneKeys = (siteId: number) => new Set((db().prepare('SELECT key FROM link_done WHERE site_id = ?').all(siteId) as { key: string }[]).map((r) => r.key));

export function setLinkDone(siteId: number, key: string, done: boolean) {
	if (done) db().prepare('INSERT OR REPLACE INTO link_done (site_id, key, at) VALUES (?,?,?)').run(siteId, key.slice(0, 2000), Date.now());
	else db().prepare('DELETE FROM link_done WHERE site_id = ? AND key = ?').run(siteId, key);
}

export interface LinkReport {
	days: number;
	crawl: CrawlInfo | null;
	pagesCrawled: number;
	pagesFailed: number;
	/** same-site links found on the crawled pages (a link repeated on one page counts once) */
	linksFound: number;
	targets: number;
	/** open suggestions, best first */
	suggestions: Suggestion[];
	/** the ones marked done that the crawl still does not see (once the link is there, a suggestion disappears by itself) */
	done: Suggestion[];
	/** pages earning impressions that no crawled page links to */
	orphans: { page: string; clicks: number; impressions: number; crawled: boolean }[];
}

/** Everything the Internal links view, the action queue and the MCP tool show, from the stored crawl and the stored Search Console data. */
export function linkReport(site: SiteRow, days = 28): LinkReport {
	const pages = crawledPages(site.id);
	const okPages = pages.filter((p) => !p.error);
	// No crawl (or nothing readable): nothing to compute, and the action queue calls this for every site.
	if (!okPages.length) return { days, crawl: crawlInfo(site.id), pagesCrawled: 0, pagesFailed: pages.length, linksFound: 0, targets: 0, suggestions: [], done: [], orphans: [] };
	const p = periodFor(site, days);
	const traffic = new Map<string, { clicks: number; impressions: number }>();
	for (const r of db().prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page').all(site.id, p.start, p.end) as { page: string; clicks: number; impressions: number }[]) {
		const k = normalizeUrl(r.page);
		const t = traffic.get(k) ?? { clicks: 0, impressions: 0 };
		t.clicks += r.clicks;
		t.impressions += r.impressions;
		traffic.set(k, t);
	}
	const sources: SourcePage[] = okPages.map((x) => ({ url: x.url, finalUrl: x.finalUrl, text: x.text, links: x.links, ...(traffic.get(normalizeUrl(x.url)) ?? { clicks: 0, impressions: 0 }) }));
	const finalOf = new Map(pages.map((x) => [normalizeUrl(x.url), x.finalUrl]));
	const targets = linkTargets(site, days).map((t) => ({ ...t, aliases: finalOf.has(normalizeUrl(t.page)) ? [finalOf.get(normalizeUrl(t.page))!] : [] }));
	const all = suggestLinks(targets, sources);
	const done = doneKeys(site.id);
	const crawledSet = new Set(pages.flatMap((x) => [normalizeUrl(x.url), normalizeUrl(x.finalUrl)]));
	const shown = pagesToCrawl(site, 500).slice(0, 500);
	return {
		days,
		crawl: crawlInfo(site.id),
		pagesCrawled: okPages.length,
		pagesFailed: pages.length - okPages.length,
		linksFound: okPages.reduce((a, x) => a + new Set(x.links.map((l) => normalizeUrl(l.url))).size, 0),
		targets: targets.length,
		suggestions: all.filter((s) => !done.has(s.key)),
		done: all.filter((s) => done.has(s.key)),
		orphans: orphanPages(shown, okPages).map((o) => ({ page: o.page, clicks: o.clicks, impressions: o.impressions, crawled: crawledSet.has(normalizeUrl(o.page)) }))
	};
}

/** Suggestions grouped by target page, the targets in order of their best suggestion. */
export function groupByTarget(s: Suggestion[]): { target: string; prize: number; rows: Suggestion[] }[] {
	const m = new Map<string, Suggestion[]>();
	for (const x of s) m.set(x.target, [...(m.get(x.target) ?? []), x]);
	return [...m.entries()].map(([target, rows]) => ({ target, prize: Math.max(...rows.map((r) => r.prize)), rows }));
}
