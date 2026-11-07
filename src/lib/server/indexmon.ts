import { db } from './db';
import { config } from './config';
import { clientForSite } from './clients';
import { GoogleApiError, type GscClient, type InspectionResult } from './google';
import { pacificToday } from './dates';
import { periodFor, topPages } from './queries';
import { comparability } from './insights';
import { neverShownUrls } from './sitemapcov';
import { diffInspection, indexState, type IndexEvent, type Inspected, type IndexState } from '../indexing';

/** The nested API shape -> the flat one the diff works on. */
export const flatten = (r: (InspectionResult & { error?: string }) | null | undefined): Inspected | null => (r ? { ...r.indexStatusResult, error: r.error } : null);

const TTL_MS = 20 * 3600_000;
const AUTH_BACKOFF_MS = 6 * 3600_000;
const FAIL_BACKOFF_MS = 2 * 3600_000;

export type MonitorOutcome = 'done' | 'quota' | 'auth' | 'failed';
export interface MonitorRun { checked: number; events: number; errors: number; stoppedEarly: string | null; outcome: MonitorOutcome; candidates: Record<'pinned' | 'new' | 'gap' | 'lost' | 'top', number> }

// ── watch list: URLs that must always be checked first ───────────────────────
export const watchList = (siteId: number) => (db().prepare('SELECT url FROM index_watch WHERE site_id = ? ORDER BY added_at').all(siteId) as { url: string }[]).map((r) => r.url);
/** `source` 'submit' marks URLs put here by a submission, so they can be taken off again; a URL the owner pinned stays pinned (INSERT OR IGNORE keeps its NULL source). */
export const addWatch = (siteId: number, urls: string[], source: 'submit' | null = null) => {
	const ins = db().prepare('INSERT OR IGNORE INTO index_watch (site_id, url, added_at, source) VALUES (?,?,?,?)');
	for (const u of urls.slice(0, 200)) ins.run(siteId, u, Date.now(), source);
};
export const removeWatch = (siteId: number, url: string) => void db().prepare('DELETE FROM index_watch WHERE site_id = ? AND url = ?').run(siteId, url);

/**
 * Re-inspect a site's URLs with Google's URL Inspection and record what changed since the last look: de-indexed, newly
 * indexed, canonical swapped, robots-blocked, fetch errors.
 *
 * Which URLs, in priority order, because the daily quota is the scarce resource and the pages whose indexing is in doubt
 * matter most:
 *   1. the watch list (money pages and templates the owner pinned)
 *   2. new pages: shown for the first time in the last period, so whether they got indexed is still open
 *   3. sitemap URLs that Search Console has never shown (no impression in 90 days): the classic hiding place of an indexing problem
 *   4. pages that lost their visibility
 *   5. the biggest pages by clicks
 * Within a tier the least recently checked go first, so coverage rotates. At most `limit` per run (INDEX_MONITOR_URLS),
 * three at a time. A failed call never overwrites the last good result.
 *
 * How a run ends decides when it tries again (see the `outcome`): finished -> tomorrow; quota (429) -> tomorrow, since the quota
 * resets daily; refused (401/403) -> in 6 h, with the reason shown; every call failed -> in 2 h.
 */
export async function monitorSite(siteId: number, o: { client?: GscClient; limit?: number; force?: boolean } = {}): Promise<MonitorRun> {
	const { client, site } = o.client ? { client: o.client, site: clientForSite(siteId).site } : clientForSite(siteId);
	const d = db();
	const limit = o.limit ?? config.indexMonitorUrls;
	const p = periodFor(site, 28);
	const cmp = comparability(site, p);
	const nowRows = topPages(site.id, p.start, p.end, {}, 5000).map((r) => r.page);
	const nowSet = new Set(nowRows);
	const prevSet = new Set(cmp.comparable ? topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000).map((r) => r.page) : []);
	const pinned = watchList(siteId);
	const pinnedSet = new Set(pinned);
	const fresh = cmp.comparable ? nowRows.filter((u) => !prevSet.has(u) && !pinnedSet.has(u)) : [];
	const freshSet = new Set(fresh);
	const gap = neverShownUrls(site, 200).filter((u) => !pinnedSet.has(u) && !freshSet.has(u));
	const gapSet = new Set(gap);
	const lost = cmp.comparable ? topPages(site.id, p.prevStart, p.prevEnd, {}, 200).map((r) => r.page).filter((u) => !nowSet.has(u) && !pinnedSet.has(u)).slice(0, 20) : [];
	const lostSet = new Set(lost);
	const top = nowRows.slice(0, 500).filter((u) => !pinnedSet.has(u) && !freshSet.has(u) && !lostSet.has(u) && !gapSet.has(u));
	const tiers: [string[], number][] = [[pinned, 0], [fresh, 1], [gap, 2], [lost, 3], [top, 4]];
	const tierOf = new Map<string, number>();
	for (const [urls, t] of tiers) for (const u of urls) if (!tierOf.has(u)) tierOf.set(u, t);
	const seen = new Map((d.prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ?').all(siteId) as { url: string; fetched_at: number; result: string }[]).map((r) => [r.url, r]));
	const queue = [...tierOf.keys()]
		.filter((u) => o.force || !seen.has(u) || Date.now() - seen.get(u)!.fetched_at > TTL_MS)
		.sort((a, b) => tierOf.get(a)! - tierOf.get(b)! || (seen.get(a)?.fetched_at ?? 0) - (seen.get(b)?.fetched_at ?? 0))
		.slice(0, limit);
	const picked = { pinned: 0, new: 0, gap: 0, lost: 0, top: 0 };
	for (const u of queue) picked[(['pinned', 'new', 'gap', 'lost', 'top'] as const)[tierOf.get(u)!]]++;
	const put = d.prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
	const ev = d.prepare('INSERT INTO index_events (site_id, url, at, kind, detail) VALUES (?,?,?,?,?)');
	const run: MonitorRun = { checked: 0, events: 0, errors: 0, stoppedEarly: null, outcome: 'done', candidates: picked };
	let lastError = '';
	const worker = async () => {
		for (let u = queue.shift(); u && !run.stoppedEarly; u = queue.shift()) {
			try {
				const next = await client.inspectUrl(site.site_url, u);
				const prev = seen.get(u) ? flatten(JSON.parse(seen.get(u)!.result)) : null;
				const events: IndexEvent[] = diffInspection(prev, flatten(next)!);
				d.transaction(() => {
					put.run(siteId, u, Date.now(), JSON.stringify(next));
					for (const e of events) ev.run(siteId, u, Date.now(), e.kind, e.detail);
				})();
				run.checked++;
				run.events += events.length;
			} catch (e) {
				run.errors++;
				lastError = e instanceof Error ? e.message : String(e);
				if (e instanceof GoogleApiError && e.status === 429) (run.stoppedEarly = "Google's URL Inspection quota was reached; the rest will be checked tomorrow."), (run.outcome = 'quota');
				else if (e instanceof GoogleApiError && (e.status === 401 || e.status === 403)) (run.stoppedEarly = e.message), (run.outcome = 'auth');
			}
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	if (run.outcome === 'done' && run.checked === 0 && run.errors > 0) run.outcome = 'failed';
	finishRun(siteId, run, lastError);
	return run;
}

/** Record how the run ended: when to try again and what to tell the user. */
function finishRun(siteId: number, run: MonitorRun, lastError: string) {
	const d = db();
	const today = pacificToday();
	const set = d.prepare('UPDATE sites SET index_checked_on = ?, index_message = ?, index_next_at = ? WHERE id = ?');
	if (run.outcome === 'done') set.run(today, null, null, siteId);
	else if (run.outcome === 'quota') set.run(today, `Google's URL Inspection quota was reached after ${run.checked} URL${run.checked === 1 ? '' : 's'}. It resumes tomorrow.`, null, siteId);
	else if (run.outcome === 'auth') set.run(null, `Google refused the inspection (${run.stoppedEarly}). Reconnect the Google account on the Accounts page; it will retry in a few hours.`, Date.now() + AUTH_BACKOFF_MS, siteId);
	else set.run(null, `Every inspection failed (last error: ${lastError || 'unknown'}). It will retry in a couple of hours.`, Date.now() + FAIL_BACKOFF_MS, siteId);
	if (run.checked > 0) {
		const s = indexSummary(siteId);
		d.prepare('INSERT OR REPLACE INTO index_history (site_id, day, indexed, not_indexed, unknown) VALUES (?,?,?,?,?)').run(siteId, today, s.counts.indexed, s.counts.not_indexed, s.counts.unknown);
	}
}

export function indexSummary(siteId: number) {
	const rows = db().prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ?').all(siteId) as { url: string; fetched_at: number; result: string }[];
	const counts: Record<IndexState, number> = { indexed: 0, not_indexed: 0, unknown: 0 };
	const notIndexed: { url: string; coverage: string | null; at: number }[] = [];
	const reasons = new Map<string, number>();
	let newest = 0;
	for (const r of rows) {
		const f = flatten(JSON.parse(r.result));
		const s = indexState(f);
		counts[s]++;
		newest = Math.max(newest, r.fetched_at);
		if (s === 'not_indexed') {
			notIndexed.push({ url: r.url, coverage: f?.coverageState ?? null, at: r.fetched_at });
			const why = f?.coverageState ?? 'No reason given';
			reasons.set(why, (reasons.get(why) ?? 0) + 1);
		}
	}
	return {
		checked: rows.length,
		counts,
		indexedShare: counts.indexed + counts.not_indexed ? counts.indexed / (counts.indexed + counts.not_indexed) : null,
		lastCheck: newest || null,
		reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
		notIndexed: notIndexed.slice(0, 200)
	};
}

export const indexHistory = (siteId: number, days = 90) =>
	db().prepare('SELECT day, indexed, not_indexed notIndexed, unknown FROM index_history WHERE site_id = ? ORDER BY day DESC LIMIT ?').all(siteId, days).reverse() as { day: string; indexed: number; notIndexed: number; unknown: number }[];

export function recentEvents(siteId: number, limit = 100) {
	return db().prepare('SELECT url, at, kind, detail FROM index_events WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(siteId, limit) as { url: string; at: number; kind: string; detail: string | null }[];
}
