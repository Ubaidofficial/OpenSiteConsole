import { db } from './db';
import { addDays } from './dates';
import { fetchBytes } from './onpage';
import { demoPageFetch } from './demo-channels';
import { sitemapSyncedAt } from './sitemapcov';
import type { SiteRow } from './clients';

/**
 * Is the sitemap's <lastmod> worth Google's trust?
 *
 * Google says it uses lastmod as a signal for re-crawling pages it already knows, but only when the date is in a supported format and
 * Google can trust it: a date that keeps claiming a change that did not happen is eventually ignored
 * (https://developers.google.com/search/blog/2023/06/sitemaps-lastmod-ping). The thresholds below are this app's own rules of thumb, not
 * numbers from Google, and every finding says what it saw so the owner can judge.
 *
 * Three views: (1) the dates themselves, for every URL in the stored sitemap read; (2) whether Google has re-crawled the pages whose
 * date moved, from the URL Inspections already stored (a sample, not every page); (3) on request, a live comparison with the
 * Last-Modified header some pages send.
 */
export const STAMP_MIN_URLS = 20;           // below this many dated URLs, "everything has the same date" proves little
export const SAME_DATE_BAD = 0.8;           // this share of URLs with one and the same date looks like a build stamp
export const SAME_DATE_WARN = 0.5;
export const ALL_RECENT_WARN = 0.9;         // this share changed in the last 7 days: probably regenerated on every deploy
export const MISSING_WARN = 0.2;
export const RECRAWL_GRACE_DAYS = 2;        // a crawl up to 2 days older than the date is not "missed"
export const RECRAWL_WAIT_DAYS = 7;         // give Google a week before calling a page not re-crawled
export const NOT_RECRAWLED_WARN = 0.5;
export const HEADER_TOLERANCE_DAYS = 2;     // time zones and caches: a header up to 2 days off the sitemap date still agrees
export const HEADER_MISMATCH_WARN = 0.3;
export const HEADER_MISMATCH_BAD = 0.6;
export const LIVE_MIN_COMPARED = 5;
export const LIVE_SAMPLE = 20;

export type Level = 'bad' | 'warn' | 'info' | 'good';
export interface Finding { level: Level; text: string }
// Worst first; then the reassuring findings; neutral notes last.
const order: Record<Level, number> = { bad: 0, warn: 1, good: 2, info: 3 };
const worst = (f: Finding[]): 'good' | 'warn' | 'bad' => (f.some((x) => x.level === 'bad') ? 'bad' : f.some((x) => x.level === 'warn') ? 'warn' : 'good');
const pct = (n: number) => `${Math.round(n * 100)}%`;
const DAY = 86_400_000;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

export interface LastmodReport {
	synced: boolean;
	readAt: number | null;
	/** the sitemap read's own problem, if it had one */
	error: string | null;
	total: number;
	withDate: number;
	/** no <lastmod> at all */
	missing: number;
	/** a <lastmod> that is not a valid W3C date (empty, wrong format, a day that does not exist) */
	invalid: number;
	/** later than tomorrow (UTC) */
	future: number;
	newest: string | null;
	oldest: string | null;
	distinctDays: number;
	commonest: { day: string; count: number; share: number } | null;
	changedLast7d: number;
	recrawl: { compared: number; notRecrawled: number; notRecrawledWeek: number; examples: { url: string; lastmod: string; lastCrawl: string }[] };
	verdict: 'unknown' | 'good' | 'warn' | 'bad';
	findings: Finding[];
}

interface Row { url: string; lastmod: string | null; bad: number }

/** The dates view and the re-crawl view, from stored data only (no network). */
export function lastmodReport(site: Pick<SiteRow, 'id'>, now = Date.now()): LastmodReport {
	const d = db();
	const sync = sitemapSyncedAt(site.id);
	const rows = d.prepare('SELECT url, lastmod, lastmod_bad bad FROM sitemap_urls WHERE site_id = ?').all(site.id) as Row[];
	const empty: LastmodReport = {
		synced: false, readAt: null, error: null, total: 0, withDate: 0, missing: 0, invalid: 0, future: 0, newest: null, oldest: null, distinctDays: 0, commonest: null, changedLast7d: 0,
		recrawl: { compared: 0, notRecrawled: 0, notRecrawledWeek: 0, examples: [] }, verdict: 'unknown', findings: []
	};
	const s = sync as { f?: number; e?: string | null; fetchedAt?: number | null; error?: string | null } | null | undefined;
	const readAt = (s && (s.f ?? s.fetchedAt)) || null;
	if (!rows.length) return { ...empty, readAt, error: s ? (s.e ?? s.error ?? null) : null, findings: [{ level: 'info', text: 'No sitemap has been read for this site yet. Submit one, then use "Read sitemaps now" on the Indexing tab.' }] };
	const today = day(now);
	const tomorrow = addDays(today, 1);
	const weekAgo = addDays(today, -7);
	const dated = rows.filter((r) => r.lastmod);
	const counts = new Map<string, number>();
	for (const r of dated) counts.set(r.lastmod!, (counts.get(r.lastmod!) ?? 0) + 1);
	const top = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))[0];
	const sorted = dated.map((r) => r.lastmod!).sort();
	const rep: LastmodReport = {
		...empty,
		synced: true,
		readAt,
		error: s ? (s.e ?? s.error ?? null) : null,
		total: rows.length,
		withDate: dated.length,
		missing: rows.filter((r) => !r.lastmod && !r.bad).length,
		invalid: rows.filter((r) => r.bad).length,
		future: dated.filter((r) => r.lastmod! > tomorrow).length,
		newest: sorted[sorted.length - 1] ?? null,
		oldest: sorted[0] ?? null,
		distinctDays: counts.size,
		commonest: top ? { day: top[0], count: top[1], share: top[1] / dated.length } : null,
		changedLast7d: dated.filter((r) => r.lastmod! >= weekAgo).length
	};

	// Has Google re-crawled the pages whose date moved? Only URLs inspected after their date can say.
	const insp = d.prepare('SELECT s.url url, s.lastmod lastmod, i.fetched_at at, i.result result FROM sitemap_urls s JOIN url_inspections i ON i.site_id = s.site_id AND i.url = s.url WHERE s.site_id = ? AND s.lastmod IS NOT NULL').all(site.id) as { url: string; lastmod: string; at: number; result: string }[];
	for (const r of insp) {
		let crawl: string | undefined;
		try {
			const j = JSON.parse(r.result) as { error?: string; indexStatusResult?: { lastCrawlTime?: string } };
			crawl = j.error ? undefined : j.indexStatusResult?.lastCrawlTime?.slice(0, 10);
		} catch {
			crawl = undefined;
		}
		const seenOn = day(r.at);
		if (!crawl || !/^\d{4}-\d{2}-\d{2}$/.test(crawl) || seenOn < r.lastmod) continue; // no crawl date, or the inspection predates the change
		rep.recrawl.compared++;
		if (daysBetween(crawl, r.lastmod) > RECRAWL_GRACE_DAYS) {
			rep.recrawl.notRecrawled++;
			if (daysBetween(r.lastmod, seenOn) >= RECRAWL_WAIT_DAYS) {
				rep.recrawl.notRecrawledWeek++;
				if (rep.recrawl.examples.length < 10) rep.recrawl.examples.push({ url: r.url, lastmod: r.lastmod, lastCrawl: crawl });
			}
		}
	}

	const f: Finding[] = [];
	if (rep.error) f.push({ level: 'warn', text: `The last sitemap read had a problem (${rep.error}), so these figures may be partial.` });
	if (rep.invalid) f.push({ level: 'bad', text: `${rep.invalid.toLocaleString('en-US')} URL${rep.invalid === 1 ? ' has' : 's have'} a <lastmod> that is not a valid date (empty, in the wrong format, or a day that does not exist). The sitemap format wants YYYY-MM-DD, optionally with a time and zone. Google cannot use these.` });
	if (rep.future) f.push({ level: 'bad', text: `${rep.future.toLocaleString('en-US')} URL${rep.future === 1 ? ' has' : 's have'} a <lastmod> in the future (latest ${rep.newest}). A date that cannot be true is the quickest way to teach Google to ignore the rest.` });
	if (!dated.length) {
		f.push({ level: 'info', text: 'No URL has a <lastmod>. That is allowed, but it means the sitemap gives Google no hint about which pages changed.' });
	} else {
		if (rep.commonest && dated.length >= STAMP_MIN_URLS && rep.commonest.share >= SAME_DATE_WARN) {
			f.push({ level: rep.commonest.share >= SAME_DATE_BAD ? 'bad' : 'warn', text: `${pct(rep.commonest.share)} of the dated URLs (${rep.commonest.count.toLocaleString('en-US')} of ${dated.length.toLocaleString('en-US')}) share the date ${rep.commonest.day}. That looks like a build or deploy stamp rather than real edits, and Google learns to ignore dates like that. Set each page's date to when its content last changed in a meaningful way.` });
		}
		if (dated.length >= STAMP_MIN_URLS && rep.changedLast7d / dated.length >= ALL_RECENT_WARN && !(rep.commonest && rep.commonest.share >= SAME_DATE_WARN)) {
			f.push({ level: 'warn', text: `${pct(rep.changedLast7d / dated.length)} of the dated URLs changed in the last 7 days. Unless the whole site really was rewritten, the dates are probably regenerated on every deploy.` });
		}
	}
	if (rep.missing) {
		const share = rep.missing / rep.total;
		f.push({ level: share >= MISSING_WARN && dated.length ? 'warn' : 'info', text: `${rep.missing.toLocaleString('en-US')} of ${rep.total.toLocaleString('en-US')} URLs (${pct(share)}) have no <lastmod>${dated.length ? ', so Google gets the hint for some pages and not for these' : ''}.` });
	}
	if (rep.recrawl.compared >= 5) {
		const share = rep.recrawl.notRecrawledWeek / rep.recrawl.compared;
		if (rep.recrawl.notRecrawledWeek && share >= NOT_RECRAWLED_WARN) {
			f.push({ level: 'warn', text: `Google had not re-crawled ${rep.recrawl.notRecrawledWeek} of ${rep.recrawl.compared} inspected pages in the ${RECRAWL_WAIT_DAYS}+ days since their sitemap date. Either it does not trust these dates yet or it is crawling the site slowly. Link to the changed pages from busy pages, and ask for indexing on the ones that matter (Request tab). This is a sample: the indexing monitor inspects only some pages.` });
		} else if (rep.recrawl.notRecrawledWeek) {
			f.push({ level: 'info', text: `${rep.recrawl.notRecrawledWeek} of ${rep.recrawl.compared} inspected pages had not been re-crawled ${RECRAWL_WAIT_DAYS}+ days after their sitemap date. Most were, which is a good sign for the dates. (A sample of pages, not all.)` });
		} else {
			f.push({ level: 'good', text: `Google re-crawled every one of the ${rep.recrawl.compared} inspected pages whose date moved. (A sample of pages, not all.)` });
		}
	} else {
		f.push({ level: 'info', text: 'Too few inspected pages whose date has moved to tell whether Google re-crawls after a change. The indexing monitor fills this in over time.' });
	}
	if (!f.some((x) => x.level === 'bad' || x.level === 'warn') && dated.length) f.unshift({ level: 'good', text: `The dates look like real edits: ${rep.distinctDays.toLocaleString('en-US')} different days across ${dated.length.toLocaleString('en-US')} dated URLs, none invalid or in the future.` });
	f.sort((a, b) => order[a.level] - order[b.level]);
	rep.findings = f;
	rep.verdict = worst(f);
	return rep;
}

// ── live comparison with the pages' own Last-Modified header ─────────────────
export interface LiveCompare {
	at: number;
	checked: number;
	/** pages that sent a usable Last-Modified that is not simply "now" */
	compared: number;
	mismatched: number;
	/** no header, or one that could not be read */
	noHeader: number;
	/** the header is today's time: the page is generated on request, so it says nothing about edits */
	dynamic: number;
	unreachable: number;
	/** daysApart: how many days later the sitemap date is than the page's header (negative: earlier) */
	examples: { url: string; lastmod: string; header: string; daysApart: number }[];
	findings: Finding[];
}
const liveKey = (siteId: number) => `lastmod_live:${siteId}`;
export const lastLiveCompare = (siteId: number): LiveCompare | null => {
	const r = db().prepare('SELECT value FROM kv WHERE key = ?').get(liveKey(siteId)) as { value: string } | undefined;
	try {
		return r ? (JSON.parse(r.value) as LiveCompare) : null;
	} catch {
		return null;
	}
};

/** An even spread over the dated URLs, newest to oldest, so both fresh and old dates are tried. */
export function spread<T>(items: T[], n: number): T[] {
	if (items.length <= n) return items;
	return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))]);
}

/**
 * Fetch a sample of up to LIVE_SAMPLE dated pages (only from the site itself, redirects checked, 4 at a time) and compare each page's
 * Last-Modified header with its sitemap date. Many sites send no such header, or send the current time; those pages cannot be judged
 * and are counted as such, so "cannot tell" is never reported as "all fine".
 */
export async function compareWithPages(site: SiteRow, o: { fetchImpl?: typeof fetch; now?: number; sample?: number } = {}): Promise<LiveCompare> {
	const now = o.now ?? Date.now();
	const rows = (db().prepare('SELECT url, lastmod FROM sitemap_urls WHERE site_id = ? AND lastmod IS NOT NULL ORDER BY lastmod DESC, url').all(site.id) as { url: string; lastmod: string }[]);
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : undefined);
	const pick = spread(rows, Math.min(LIVE_SAMPLE, o.sample ?? LIVE_SAMPLE));
	const out: LiveCompare = { at: now, checked: pick.length, compared: 0, mismatched: 0, noHeader: 0, dynamic: 0, unreachable: 0, examples: [], findings: [] };
	let i = 0;
	const worker = async () => {
		for (let r = pick[i++]; r; r = pick[i++]) {
			const res = await fetchBytes(r.url, site.site_url, { fetchImpl, max: 2048, htmlOnly: true });
			if (!res.body) { out.unreachable++; continue; }
			const ms = res.lastModified ? Date.parse(res.lastModified) : NaN;
			if (Number.isNaN(ms)) { out.noHeader++; continue; }
			if (Math.abs(now - ms) < 36 * 3600_000) { out.dynamic++; continue; }
			out.compared++;
			const apart = daysBetween(day(ms), r.lastmod);
			if (Math.abs(apart) > HEADER_TOLERANCE_DAYS) {
				out.mismatched++;
				if (out.examples.length < 10) out.examples.push({ url: r.url, lastmod: r.lastmod, header: day(ms), daysApart: apart });
			}
		}
	};
	await Promise.all([worker(), worker(), worker(), worker()]);
	const f = out.findings;
	if (!pick.length) f.push({ level: 'info', text: 'No URL has a sitemap date to compare.' });
	else if (out.compared < LIVE_MIN_COMPARED) {
		f.push({ level: 'info', text: `Of ${out.checked} pages fetched, ${out.compared} sent a usable Last-Modified header (${out.noHeader} sent none, ${out.dynamic} sent the current time, ${out.unreachable} could not be fetched). That is too few to judge the dates, and it is common: it does not mean the dates are wrong.` });
	} else {
		const share = out.mismatched / out.compared;
		const text = `${out.mismatched} of ${out.compared} pages that send a Last-Modified header disagree with their sitemap date by more than ${HEADER_TOLERANCE_DAYS} days (${pct(share)}).`;
		f.push(share >= HEADER_MISMATCH_BAD ? { level: 'bad', text: text + ' One of the two dates is wrong; Google can see both.' } : share >= HEADER_MISMATCH_WARN ? { level: 'warn', text: text + ' Worth checking which one is right.' } : { level: 'good', text: text + ' The two mostly agree.' });
	}
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(liveKey(site.id), JSON.stringify(out));
	return out;
}
