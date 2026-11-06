import { gunzipSync } from 'node:zlib';
import { db } from './db';
import { clientForSite, type SiteRow } from './clients';
import type { GscClient, SitemapInfo } from './google';
import { addDays } from './dates';
import { periodFor, siteEnd, historyCoversPrevious } from './queries';
import { fetchBytes } from './onpage';
import { parseSitemapXml } from '../sitemap';
import { normalizeUrl } from '../analytics';
import { demoSitemapFetch } from './demo-channels';
import { diffSitemaps, type SitemapChanges } from '../indexnow';
import { inProperty } from '../property';

const MAX_FILES = 25;
const MAX_URLS = 200_000;
const RAW_CAP = 12_000_000;
const UNZIPPED_CAP = 40_000_000;
const NEW_PAGE_DAYS = 14;

export interface SitemapSyncResult { /** URLs listed in the sitemaps that are outside the property (other host, scheme or path), left out */ offProperty?: number; sitemaps: number; urls: number; truncated: boolean; error: string | null; /** what changed since the previous read; null on the first read (nothing to compare with) */ changes: SitemapChanges | null }

/** Sitemap files are often served gzipped (.xml.gz): detect the magic bytes rather than trusting a header or a name. */
export function sitemapText(buf: Buffer): string {
	return (buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf, { maxOutputLength: UNZIPPED_CAP }) : buf).toString('utf8');
}

/**
 * Read the sitemaps the site has submitted to Search Console (the API gives their addresses and counts, not their URLs) and
 * store every URL they list. Follows sitemap indexes two levels deep, at most 25 files and 200,000 URLs. Fetching is confined to
 * the site's own host like every other fetch here, and one broken file does not stop the others; the first problem is kept.
 */
export async function syncSitemapUrls(siteId: number, o: { client?: GscClient; fetchImpl?: typeof fetch } = {}): Promise<SitemapSyncResult> {
	const { client, site } = o.client ? { client: o.client, site: clientForSite(siteId).site } : clientForSite(siteId);
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number }).is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoSitemapFetch(siteId) : undefined);
	let error: string | null = null;
	const note = (e: string) => void (error ??= e);
	const urls = new Map<string, { lastmod: string | null; sitemap: string }>();
	let files = 0;
	let truncated = false;
	let offProperty = 0;
	try {
		const listed = (await client.listSitemaps(site.site_url)).map((s) => s.path).filter((p) => /^https?:\/\//i.test(p)).slice(0, 10);
		const queue: { url: string; depth: number }[] = listed.map((url) => ({ url, depth: 0 }));
		const seen = new Set<string>();
		for (let item = queue.shift(); item; item = queue.shift()) {
			if (seen.has(item.url) || files >= MAX_FILES) continue;
			seen.add(item.url);
			const r = await fetchBytes(item.url, site.site_url, { fetchImpl, max: RAW_CAP, accept: 'application/xml,text/xml,application/gzip,*/*' });
			files++;
			if (!r.body) { note(`${item.url}: ${r.error ?? 'could not be read'}`); continue; }
			let parsed;
			try {
				parsed = parseSitemapXml(sitemapText(r.body));
			} catch {
				note(`${item.url}: could not be decompressed (too large or damaged)`);
				continue;
			}
			if (parsed.kind === 'unknown') { note(`${item.url}: not a sitemap`); continue; }
			if (parsed.truncated) truncated = true;
			if (parsed.kind === 'index') {
				if (item.depth < 2) for (const e of parsed.entries) queue.push({ url: e.loc, depth: item.depth + 1 });
				continue;
			}
			for (const e of parsed.entries) {
				if (urls.size >= MAX_URLS) { truncated = true; break; }
				// Only URLs of this property: Google refuses to inspect others, and they are not this site's coverage.
				if (!inProperty(e.loc, site.site_url)) { offProperty++; continue; }
				if (!urls.has(e.loc)) urls.set(e.loc, { lastmod: e.lastmod, sitemap: item.url });
			}
		}
	} catch (e) {
		note(e instanceof Error ? `Could not list the sitemaps: ${e.message}` : 'Could not list the sitemaps.');
	}
	const d = db();
	// If nothing at all could be read, keep the previous snapshot rather than wiping it.
	if (urls.size === 0 && error) {
		d.prepare('INSERT INTO sitemap_sync (site_id, fetched_at, sitemaps, urls, truncated, error) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET fetched_at = excluded.fetched_at, error = excluded.error').run(siteId, Date.now(), files, 0, 0, error);
		return { sitemaps: files, urls: 0, truncated: false, error, changes: null, offProperty };
	}
	// What changed since the last read, for IndexNow. The first read has nothing to compare with, so it reports no changes.
	const hadSnapshot = !!d.prepare('SELECT 1 FROM sitemap_sync WHERE site_id = ? AND urls > 0').get(siteId);
	const before = hadSnapshot ? new Map((d.prepare('SELECT url, lastmod FROM sitemap_urls WHERE site_id = ?').all(siteId) as { url: string; lastmod: string | null }[]).map((r) => [r.url, r.lastmod])) : null;
	// A read in which some file failed is partial: comparing it with the last full one would report the missing file's URLs as
	// removed, and again as added once it recovers (and IndexNow would announce them as new). So only a complete read is diffed,
	// and a partial one adds what it found without deleting anything.
	const partial = !!error && hadSnapshot;
	const changes = before && !partial ? diffSitemaps(before, new Map([...urls].map(([u, v]) => [u, v.lastmod]))) : null;
	const ins = d.prepare('INSERT OR REPLACE INTO sitemap_urls (site_id, url, norm, lastmod, sitemap) VALUES (?,?,?,?,?)');
	d.transaction(() => {
		if (!partial) d.prepare('DELETE FROM sitemap_urls WHERE site_id = ?').run(siteId);
		for (const [url, v] of urls) ins.run(siteId, url, normalizeUrl(url), v.lastmod, v.sitemap);
		const total = (d.prepare('SELECT COUNT(*) n FROM sitemap_urls WHERE site_id = ?').get(siteId) as { n: number }).n;
		d.prepare('INSERT OR REPLACE INTO sitemap_sync (site_id, fetched_at, sitemaps, urls, truncated, error) VALUES (?,?,?,?,?,?)').run(siteId, Date.now(), files, total, truncated ? 1 : 0, error);
	})();
	return { sitemaps: files, urls: urls.size, truncated, error, changes, offProperty };
}

type CovSite = Pick<SiteRow, 'id' | 'synced_through' | 'backfill_done' | 'backfilled_to'>;

export interface Coverage {
	synced: boolean;
	fetchedAt: number | null;
	sitemapFiles: number;
	error: string | null;
	truncated: boolean;
	/** the window of Search Console data used, and whether it is fully downloaded */
	window: { start: string; end: string; days: number; complete: boolean };
	totalUrls: number;
	shown: number;
	neverShown: { count: number; tooNew: number; sample: { url: string; lastmod: string | null; index: string }[] };
	notInSitemap: { count: number; clicks: number; sample: { url: string; clicks: number; impressions: number }[] };
}

/**
 * Sitemap URLs against the pages Search Console has shown in the last `days` (90 by default: a page can be quiet for a month
 * and still be fine). "Never shown" means no impression at all in that window, which is where indexing problems hide; a page
 * whose sitemap date is under two weeks old is counted separately as too new to judge. "Not in the sitemap" are pages that earn
 * clicks but are missing from every submitted sitemap. URLs are compared without scheme, www, query or trailing slash.
 */
export function sitemapCoverage(site: CovSite, days = 90, limit = 300): Coverage {
	const d = db();
	const meta = d.prepare('SELECT fetched_at, sitemaps, urls, truncated, error FROM sitemap_sync WHERE site_id = ?').get(site.id) as { fetched_at: number; sitemaps: number; urls: number; truncated: number; error: string | null } | undefined;
	const p = periodFor(site, days);
	const complete = historyCoversPrevious(site, addDays(p.start, -1)) || !!site.backfill_done || (!!site.backfilled_to && site.backfilled_to <= p.start);
	const empty: Coverage = { synced: !!meta, fetchedAt: meta?.fetched_at ?? null, sitemapFiles: meta?.sitemaps ?? 0, error: meta?.error ?? null, truncated: !!meta?.truncated, window: { start: p.start, end: p.end, days, complete }, totalUrls: 0, shown: 0, neverShown: { count: 0, tooNew: 0, sample: [] }, notInSitemap: { count: 0, clicks: 0, sample: [] } };
	if (!meta) return empty;
	const rows = d.prepare('SELECT url, norm, lastmod FROM sitemap_urls WHERE site_id = ?').all(site.id) as { url: string; norm: string; lastmod: string | null }[];
	const pages = d.prepare('SELECT page, SUM(clicks) clicks, SUM(impressions) impressions FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page HAVING SUM(impressions) > 0').all(site.id, p.start, p.end) as { page: string; clicks: number; impressions: number }[];
	const seen = new Map<string, { page: string; clicks: number; impressions: number }>();
	for (const r of pages) {
		const k = normalizeUrl(r.page);
		const cur = seen.get(k);
		seen.set(k, cur ? { page: cur.page, clicks: cur.clicks + r.clicks, impressions: cur.impressions + r.impressions } : r);
	}
	const inSitemap = new Set(rows.map((r) => r.norm));
	const insp = new Map((d.prepare('SELECT url, result FROM url_inspections WHERE site_id = ?').all(site.id) as { url: string; result: string }[]).map((r) => [r.url, r.result]));
	const stateOf = (url: string) => {
		const raw = insp.get(url);
		if (!raw) return 'not checked';
		const j = JSON.parse(raw) as { error?: string; indexStatusResult?: { verdict?: string } };
		return j.error ? 'unknown' : j.indexStatusResult?.verdict === 'PASS' ? 'indexed' : j.indexStatusResult?.verdict ? 'not indexed' : 'unknown';
	};
	const newCutoff = addDays(siteEnd(site), -NEW_PAGE_DAYS);
	const never = rows.filter((r) => !seen.has(r.norm));
	const tooNew = never.filter((r) => r.lastmod && r.lastmod >= newCutoff);
	const judged = never.filter((r) => !(r.lastmod && r.lastmod >= newCutoff));
	const shown = rows.length - never.length;
	const missing = [...seen].filter(([k, v]) => !inSitemap.has(k) && v.clicks > 0).map(([, v]) => v).sort((a, b) => b.clicks - a.clicks);
	return {
		...empty,
		totalUrls: rows.length,
		shown,
		neverShown: {
			count: judged.length,
			tooNew: tooNew.length,
			// newest first: a recently touched page that is invisible is the likeliest to be fixable
			sample: judged.sort((a, b) => (b.lastmod ?? '').localeCompare(a.lastmod ?? '')).slice(0, limit).map((r) => ({ url: r.url, lastmod: r.lastmod, index: stateOf(r.url) }))
		},
		notInSitemap: { count: missing.length, clicks: missing.reduce((a, r) => a + r.clicks, 0), sample: missing.slice(0, limit).map((r) => ({ url: r.page, clicks: r.clicks, impressions: r.impressions })) }
	};
}

/** Sitemap URLs with no impression in the window, for the indexing monitor to look at first. */
export const neverShownUrls = (site: CovSite, max = 200) => sitemapCoverage(site, 90, max).neverShown.sample.map((s) => s.url);

export const sitemapSyncedAt = (siteId: number) => (db().prepare('SELECT fetched_at f, error e FROM sitemap_sync WHERE site_id = ?').get(siteId) as { f: number; e: string | null } | undefined) ?? null;


export interface SitemapCheck {
	url: string;
	reachable: boolean;
	status: number;
	finalUrl: string;
	bytes: number;
	contentType: string;
	kind: 'urlset' | 'index' | 'unknown' | 'unreadable';
	urls: number;
	withLastmod: number;
	duplicates: number;
	otherHosts: string[];
	queryUrls: number;
	googleCounted: number | null;
	googleRead: string | null;
	googleSubmitted: string | null;
	googlePending: boolean;
	robotsListsIt: boolean | null;
	/** plain-language findings, worst first */
	notes: { level: 'bad' | 'warn' | 'info'; text: string }[];
}

/**
 * Fetch one submitted sitemap the way a crawler would (same-site only, redirects checked, size capped) and say what is wrong
 * with it, or that nothing is, next to what Google last reported for it. Answers "why is it pending / why does Google show
 * a different count?" without guessing.
 */
export async function diagnoseSitemap(feed: string, siteUrl: string, google?: SitemapInfo, fetchImpl?: typeof fetch): Promise<SitemapCheck> {
	const r = await fetchBytes(feed, siteUrl, { fetchImpl, max: RAW_CAP, accept: 'application/xml,text/xml,application/gzip,*/*' });
	const googleCounted = google?.contents?.length ? google.contents.reduce((a, c) => a + Number(c.submitted ?? 0), 0) : null;
	const out: SitemapCheck = { url: feed, reachable: !!r.body, status: r.status, finalUrl: r.finalUrl, bytes: r.body?.length ?? 0, contentType: r.contentType, kind: 'unreadable', urls: 0, withLastmod: 0, duplicates: 0, otherHosts: [], queryUrls: 0, googleCounted, googleRead: google?.lastDownloaded ?? null, googleSubmitted: google?.lastSubmitted ?? null, googlePending: !!google?.isPending, robotsListsIt: null, notes: [] };
	const note = (level: 'bad' | 'warn' | 'info', text: string) => void out.notes.push({ level, text });
	if (!r.body) {
		note('bad', `Could not fetch it: ${r.error ?? 'unknown problem'} Google would hit the same wall.`);
		return out;
	}
	let parsed;
	try {
		parsed = parseSitemapXml(sitemapText(r.body));
	} catch {
		note('bad', 'The file looks gzipped but could not be decompressed (damaged or far too large).');
		return out;
	}
	out.kind = parsed.kind;
	if (parsed.kind === 'unknown') note('bad', 'The response is not a sitemap (no <urlset> or <sitemapindex>). Is a login page or an HTML error page being served at this address?');
	const locs = parsed.entries.map((e) => e.loc);
	out.urls = locs.length;
	out.withLastmod = parsed.entries.filter((e) => e.lastmod).length;
	out.duplicates = locs.length - new Set(locs).size;
	out.queryUrls = locs.filter((l) => l.includes('?')).length;
	out.otherHosts = [...new Set(locs.map((l) => { try { return new URL(l).hostname; } catch { return ''; } }).filter((h) => h && !hostAllowedName(h, siteUrl)))].slice(0, 5);
	try {
		const robots = await fetchBytes(new URL('/robots.txt', feed).href, siteUrl, { fetchImpl, max: 500_000, accept: 'text/plain,*/*' });
		if (robots.body) out.robotsListsIt = robots.body.toString('utf8').split(/\r?\n/).some((l) => /^\s*sitemap\s*:/i.test(l) && l.split(/:(.*)/s)[1]?.trim().replace(/\/$/, '') === feed.replace(/\/$/, ''));
	} catch {
		/* robots is optional */
	}
	if (out.finalUrl !== feed) note('warn', `It redirects to ${out.finalUrl}. Submit that final address instead.`);
	if (r.contentType && !/xml|gzip|octet-stream|text\/plain/i.test(r.contentType)) note('warn', `It is served as "${r.contentType}", not XML. Google may still read it, but fix the content type.`);
	if (out.otherHosts.length) note('warn', `It lists URLs on other hosts (${out.otherHosts.join(', ')}). Google ignores sitemap URLs that are not on the property's own site.`);
	if (out.duplicates) note('info', `${out.duplicates} URL${out.duplicates === 1 ? ' is' : 's are'} listed more than once.`);
	if (out.queryUrls) note('info', `${out.queryUrls} URL${out.queryUrls === 1 ? ' has' : 's have'} a query string; make sure they are meant to be indexed.`);
	if (parsed.truncated || out.urls >= 50_000) note('warn', 'A sitemap file may hold at most 50,000 URLs; split it with a sitemap index.');
	if (googleCounted != null && out.urls !== googleCounted) {
		const read = google?.lastDownloaded ? google.lastDownloaded.slice(0, 10) : 'an earlier date';
		note('info', out.urls > googleCounted ? `The file lists ${out.urls - googleCounted} more URLs than Google last counted (${googleCounted}, read ${read}): Google has not re-read it since they were added.` : `The file lists ${googleCounted - out.urls} fewer URLs than Google last counted (${googleCounted}, read ${read}).`);
	}
	if (out.robotsListsIt === false) note('info', 'Your robots.txt does not list this sitemap. Not required when you submit it in Search Console, but harmless to add.');
	if (google?.isPending) note('info', 'Google marks it pending: it accepted the submission and has not processed it yet. After a resubmit this is normal, and the "Last read" date stays the old one until Google fetches the file again. Google decides when; resubmitting again does not speed it up.');
	if (!out.notes.some((n) => n.level !== 'info')) note('info', 'Nothing is wrong with the file itself: it is reachable, valid and on the right host.');
	return out;
}

/** Same rule as the fetch confinement: the site's own host or a subdomain of it. */
function hostAllowedName(host: string, siteUrl: string): boolean {
	const h = host.toLowerCase().replace(/^www\./, '');
	const s = normalizeUrl('https://' + siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '')).split('/')[0];
	return h === s || h.endsWith('.' + s);
}
