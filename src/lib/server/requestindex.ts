import { audit, db } from './db';
import { env } from './config';
import type { SiteRow } from './clients';
import { inspectUrls, storedInspection } from './inspect';
import { neverShownUrls } from './sitemapcov';
import { cleanUrls, recordManualRequests, submissionStatus, type SubmissionRow } from './submission';
import { flatten } from './indexmon';
import { indexState } from '../indexing';
import { addDays } from './dates';

/**
 * The "Request indexing" list. Search Console's Request Indexing button is the one fast, official way to ask Google about a page, and it has
 * no API, so a tool cannot press it. What a tool can do is the part that costs time: pick the few pages worth asking about, drop the ones
 * Google already has, set aside the ones where asking is pointless (blocked, gone, another canonical), give a link straight to each, and keep
 * track of what was asked and whether it worked.
 *
 * Google does not publish the daily limit. Third-party sources put it at about 10 to 12 a day (https://quickfixseo.pages.dev/articles/request-indexing-google-guide
 * and a tool's own docs say about 11 per property); that is unverified, so it is a setting (REQUEST_INDEXING_PER_DAY, default 10).
 */
export const requestsPerDay = () => {
	const n = Number(env('REQUEST_INDEXING_PER_DAY', '10'));
	return Number.isInteger(n) && n >= 1 && n <= 50 ? n : 10;
};
export const REQUEST_COOLDOWN_DAYS = 14;
export const DISMISS_DAYS = 30;
const DAY = 86_400_000;
const MAX_PROBLEMS = 20;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY);

/** A link from Google's own answer, used only if it really points at Search Console (it goes into an href). */
export function safeConsoleLink(link: unknown): string | null {
	if (typeof link !== 'string') return null;
	try {
		const u = new URL(link);
		return u.protocol === 'https:' && u.hostname === 'search.google.com' && !u.username && !u.password ? u.href : null;
	} catch {
		return null;
	}
}

export type RequestStatus = 'pending' | 'requested' | 'dismissed' | 'problem';
export interface RequestItem {
	url: string;
	status: RequestStatus;
	tier: number;
	reason: string;
	state: 'indexed' | 'not_indexed' | 'unknown' | null;
	coverage: string | null;
	link: string | null;
	builtAt: number;
	actedAt: number | null;
}
const rowToItem = (r: { url: string; status: RequestStatus; tier: number; reason: string; state: string | null; coverage: string | null; link: string | null; built_at: number; acted_at: number | null }): RequestItem => ({
	url: r.url, status: r.status, tier: r.tier, reason: r.reason, state: r.state as RequestItem['state'], coverage: r.coverage, link: safeConsoleLink(r.link), builtAt: r.built_at, actedAt: r.acted_at
});

export function budget(siteId: number, now = Date.now()) {
	const per = requestsPerDay();
	const used = db().prepare("SELECT acted_at a FROM index_requests WHERE site_id = ? AND status = 'requested' AND acted_at > ? ORDER BY acted_at").all(siteId, now - DAY) as { a: number }[];
	const left = Math.max(0, per - used.length);
	return { perDay: per, usedLast24h: used.length, left, nextSlotAt: left === 0 && used.length ? used[used.length - per]?.a + DAY || used[0].a + DAY : null };
}

export interface Candidate { url: string; tier: 1 | 2 | 3 | 4; lastmod: string | null }

/** Pages worth considering, best first: new or changed in the sitemap, pinned by the owner, never shown in search, sent earlier and still not indexed. */
export function candidates(site: SiteRow, now = Date.now()): Candidate[] {
	const d = db();
	const skip = new Set((d.prepare("SELECT url FROM index_requests WHERE site_id = ? AND ((status = 'requested' AND acted_at > ?) OR (status = 'dismissed' AND acted_at > ?) OR (status = 'pending' AND tier = 0))").all(site.id, now - REQUEST_COOLDOWN_DAYS * DAY, now - DISMISS_DAYS * DAY) as { url: string }[]).map((r) => r.url));
	const lm = new Map((d.prepare('SELECT url, lastmod FROM sitemap_urls WHERE site_id = ?').all(site.id) as { url: string; lastmod: string | null }[]).map((r) => [r.url, r.lastmod]));
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const add = (url: string, tier: Candidate['tier']) => {
		if (seen.has(url) || skip.has(url)) return;
		seen.add(url);
		out.push({ url, tier, lastmod: lm.get(url) ?? null });
	};
	const weekAgo = addDays(day(now), -7);
	for (const r of d.prepare('SELECT url FROM sitemap_urls WHERE site_id = ? AND lastmod >= ? ORDER BY lastmod DESC, url LIMIT 200').all(site.id, weekAgo) as { url: string }[]) add(r.url, 1);
	for (const r of d.prepare('SELECT url FROM index_watch WHERE site_id = ? AND source IS NULL ORDER BY added_at').all(site.id) as { url: string }[]) add(r.url, 2);
	for (const u of neverShownUrls(site, 200)) add(u, 3);
	for (const r of submissionStatus(site.id, 200, now)) if (r.verdict === 'still_not_indexed') add(r.url, 4);
	return out;
}

interface Verdict { keep: boolean; problem?: string; reason: string; state: RequestItem['state']; coverage: string | null; link: string | null }

/** What Google's stored answer means for asking about this page. */
export function judge(c: Candidate, stored: ReturnType<typeof storedInspection>, now: number): Verdict {
	const ok = stored && !stored.r.error ? stored.r : null;
	const ix = ok?.indexStatusResult ?? {};
	const state = ok ? indexState(flatten(stored!.r)) : 'unknown';
	const coverage = ok ? (ix.coverageState ?? null) : null;
	const link = ok ? safeConsoleLink(ok.inspectionResultLink) : null;
	const base = { state: state as RequestItem['state'], coverage, link };
	const cov = coverage ? `: ${coverage}` : '';
	if (!ok) return { ...base, keep: true, reason: `${c.lastmod ? `Dated ${c.lastmod} in your sitemap. ` : ''}Google could not be asked about it just now, so its state is unknown.` };
	let problem: string | undefined;
	if (ix.robotsTxtState === 'DISALLOWED') problem = 'robots.txt blocks Google from it. Asking will not help until that is fixed.';
	else if (ix.indexingState && /^BLOCKED/.test(ix.indexingState)) problem = 'It carries a noindex (meta tag or header). Remove that first.';
	else if (ix.pageFetchState && !['SUCCESSFUL', 'PAGE_FETCH_STATE_UNSPECIFIED'].includes(ix.pageFetchState)) problem = `Google cannot fetch it (${ix.pageFetchState.toLowerCase().replace(/_/g, ' ')}). Fix the page or its status first.`;
	else if (ix.googleCanonical && ix.userCanonical && ix.googleCanonical.replace(/\/+$/, '') !== ix.userCanonical.replace(/\/+$/, '')) problem = `Google chose another page as the canonical (${ix.googleCanonical}), so asking for this address will not index it.`;
	if (problem) return { ...base, keep: false, problem, reason: problem };
	if (state === 'indexed') {
		const crawl = ix.lastCrawlTime?.slice(0, 10);
		if (c.lastmod && crawl && /^\d{4}-\d{2}-\d{2}$/.test(crawl) && daysBetween(crawl, c.lastmod) > 2) return { ...base, keep: true, reason: `Indexed, but changed ${c.lastmod} (sitemap) and Google last crawled it ${crawl}.` };
		return { ...base, keep: false, reason: 'Already indexed and up to date.' };
	}
	const age = (t: number) => Math.max(0, Math.floor((now - t) / DAY));
	void age;
	switch (c.tier) {
		case 1: return { ...base, keep: true, reason: `New or changed ${c.lastmod ?? 'recently'} and not indexed yet${cov}` };
		case 2: return { ...base, keep: true, reason: `You pinned it on the watch list, and Google has not indexed it${cov}` };
		case 3: return { ...base, keep: true, reason: `In your sitemap but never shown in search in 90 days${cov}` };
		default: return { ...base, keep: true, reason: `Sent earlier and still not indexed${cov}. Improve the page first: asking again does not change what Google thinks of its quality.` };
	}
}

export interface BuildResult {
	/** the list could not be built: the daily allowance is used up */
	limitReached: boolean;
	nextSlotAt: number | null;
	candidates: number;
	asked: number;
	liveInspections: number;
	listed: number;
	alreadyIndexed: number;
	problems: number;
}

/**
 * Build today's list: take candidates in order, ask Google about them (URL Inspection, cached 12 h, at most `inspectCap` URLs, 10 at a time),
 * drop what is already indexed, set blocked or pointless ones aside as "problems", and keep as many as the daily allowance still has room for.
 * It replaces the previous unanswered list; what you already requested or skipped is kept.
 */
export async function buildQueue(site: SiteRow, o: { now?: number; inspectCap?: number } = {}): Promise<BuildResult> {
	const now = o.now ?? Date.now();
	const b = budget(site.id, now);
	const res: BuildResult = { limitReached: false, nextSlotAt: b.nextSlotAt, candidates: 0, asked: 0, liveInspections: 0, listed: 0, alreadyIndexed: 0, problems: 0 };
	if (b.left === 0) return { ...res, limitReached: true };
	const cands = candidates(site, now);
	res.candidates = cands.length;
	const cap = Math.max(0, Math.min(o.inspectCap ?? 30, 60));
	const kept: { c: Candidate; v: Verdict }[] = [];
	const problems: { c: Candidate; v: Verdict }[] = [];
	for (let i = 0; i < cands.length && kept.length < b.left && res.asked < cap; ) {
		// Ask only about as many as there is room for (at least two, so one indexed page does not cost a round trip), never more than 10 at once.
		const chunk = cands.slice(i, i + Math.min(10, Math.max(2, b.left - kept.length), cap - res.asked));
		i += chunk.length;
		try {
			res.liveInspections += (await inspectUrls(site.id, chunk.map((c) => c.url), false)).live;
		} catch {
			/* what is stored is still used below */
		}
		res.asked += chunk.length;
		for (const c of chunk) {
			if (kept.length >= b.left) break;
			const v = judge(c, storedInspection(site.id, c.url), now);
			if (v.keep) kept.push({ c, v });
			else if (v.problem) problems.push({ c, v });
			else res.alreadyIndexed++;
		}
	}
	const d = db();
	const ins = d.prepare('INSERT OR REPLACE INTO index_requests (site_id, url, status, tier, reason, state, coverage, link, built_at, acted_at) VALUES (?,?,?,?,?,?,?,?,?,NULL)');
	d.transaction(() => {
		d.prepare("DELETE FROM index_requests WHERE site_id = ? AND status IN ('pending','problem') AND tier > 0").run(site.id);
		for (const { c, v } of kept) ins.run(site.id, c.url, 'pending', c.tier, v.reason, v.state, v.coverage, v.link, now);
		for (const { c, v } of problems.slice(0, MAX_PROBLEMS)) ins.run(site.id, c.url, 'problem', c.tier, v.reason, v.state, v.coverage, v.link, now);
	})();
	res.listed = kept.length;
	res.problems = Math.min(problems.length, MAX_PROBLEMS);
	audit('index.request_list', { siteId: site.id, detail: `${kept.length} listed, ${res.problems} problems, ${res.liveInspections} live inspections` });
	return res;
}

export interface RecentRequest extends RequestItem { verdict: SubmissionRow['verdict'] | null; daysSince: number | null; nextCheckAt: number | null }
export interface RequestQueue {
	budget: ReturnType<typeof budget>;
	pending: RequestItem[];
	problems: RequestItem[];
	recent: RecentRequest[];
	builtAt: number | null;
}
export function requestQueue(siteId: number, now = Date.now()): RequestQueue {
	const rows = db().prepare('SELECT url, status, tier, reason, state, coverage, link, built_at, acted_at FROM index_requests WHERE site_id = ? ORDER BY tier, built_at DESC, url').all(siteId) as Parameters<typeof rowToItem>[0][];
	const items = rows.map(rowToItem);
	const sub = new Map(submissionStatus(siteId, 500, now).map((s) => [s.url, s]));
	return {
		budget: budget(siteId, now),
		pending: items.filter((i) => i.status === 'pending'),
		problems: items.filter((i) => i.status === 'problem'),
		recent: items.filter((i) => i.status === 'requested').sort((a, b) => (b.actedAt ?? 0) - (a.actedAt ?? 0)).slice(0, 50).map((i) => ({ ...i, verdict: sub.get(i.url)?.verdict ?? null, daysSince: sub.get(i.url)?.daysSince ?? null, nextCheckAt: sub.get(i.url)?.nextCheckAt ?? null })),
		builtAt: items.reduce((m, i) => (i.status === 'pending' || i.status === 'problem' ? Math.max(m ?? 0, i.builtAt) : m), null as number | null)
	};
}

/** You pressed the button in Search Console for these URLs: record it (with the re-checks), and take them off the list. */
export function markRequested(site: SiteRow, urlsIn: string[], source: 'app' | 'mcp', now = Date.now(), keyId?: number): { marked: number; rejected: { url: string; reason: string }[] } {
	const { urls, rejected } = cleanUrls(urlsIn, site);
	const d = db();
	const up = d.prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at, acted_at) VALUES (?,?,'requested',0,'You asked for indexing in Search Console.',?,?) ON CONFLICT(site_id, url) DO UPDATE SET status = 'requested', acted_at = excluded.acted_at");
	d.transaction(() => urls.forEach((u) => up.run(site.id, u, now, now)))();
	recordManualRequests(site, urls, source, now, keyId);
	return { marked: urls.length, rejected };
}

/** Hide URLs from the list for 30 days ("not worth asking about"). */
export function dismissRequests(site: SiteRow, urlsIn: string[], now = Date.now()): number {
	const { urls } = cleanUrls(urlsIn, site);
	const d = db();
	const up = d.prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at, acted_at) VALUES (?,?,'dismissed',0,'Skipped by you.',?,?) ON CONFLICT(site_id, url) DO UPDATE SET status = 'dismissed', acted_at = excluded.acted_at");
	d.transaction(() => urls.forEach((u) => up.run(site.id, u, now, now)))();
	return urls.length;
}

/**
 * Put URLs on the list by hand (for example from the Inspect tab). Each is judged on Google's stored answer like the automatic ones: indexed and
 * up to date is left off, a blocked or pointless one goes under "fix these first", and one you already asked about in the last 14 days is skipped.
 */
export function addPending(site: SiteRow, urlsIn: string[], now = Date.now()): { added: number; problems: number; alreadyIndexed: number; recentlyAsked: number; rejected: number } {
	const { urls, rejected } = cleanUrls(urlsIn, site);
	const d = db();
	const out = { added: 0, problems: 0, alreadyIndexed: 0, recentlyAsked: 0, rejected: rejected.length };
	const lm = d.prepare('SELECT lastmod FROM sitemap_urls WHERE site_id = ? AND url = ?');
	const asked = d.prepare("SELECT 1 FROM index_requests WHERE site_id = ? AND url = ? AND status = 'requested' AND acted_at > ?");
	const ins = d.prepare('INSERT OR REPLACE INTO index_requests (site_id, url, status, tier, reason, state, coverage, link, built_at, acted_at) VALUES (?,?,?,0,?,?,?,?,?,NULL)');
	d.transaction(() => {
		for (const url of urls) {
			if (asked.get(site.id, url, now - REQUEST_COOLDOWN_DAYS * DAY)) { out.recentlyAsked++; continue; }
			const v = judge({ url, tier: 1, lastmod: (lm.get(site.id, url) as { lastmod: string | null } | undefined)?.lastmod ?? null }, storedInspection(site.id, url), now);
			if (v.problem) { ins.run(site.id, url, 'problem', v.reason, v.state, v.coverage, v.link, now); out.problems++; }
			else if (!v.keep) out.alreadyIndexed++;
			else { ins.run(site.id, url, 'pending', `You added it${v.coverage ? `. Google: ${v.coverage}` : v.state === 'unknown' ? '. Google has not been asked about it yet' : ''}`, v.state, v.coverage, v.link, now); out.added++; }
		}
	})();
	return out;
}
