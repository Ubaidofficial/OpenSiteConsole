import { db } from './db';
import { config } from './config';
import { clientForSite } from './clients';
import { GoogleApiError, type GscClient, type InspectionResult } from './google';
import { pacificToday } from './dates';
import { periodFor, topPages } from './queries';
import { diffInspection, indexState, type IndexEvent, type Inspected, type IndexState } from '../indexing';

/** The nested API shape -> the flat one the diff works on. */
export const flatten = (r: (InspectionResult & { error?: string }) | null | undefined): Inspected | null => (r ? { ...r.indexStatusResult, error: r.error } : null);

const TTL_MS = 20 * 3600_000;

export interface MonitorRun { checked: number; events: number; errors: number; stoppedEarly: string | null }

/**
 * Re-inspect a site's most valuable URLs (its top pages by clicks, plus pages that had visibility and lost it) and record
 * what changed since the last look: de-indexed, newly indexed, canonical swapped, robots-blocked, fetch errors.
 * Least recently checked first, at most `limit` per run (INDEX_MONITOR_URLS, default 40), three at a time. A failed call
 * never overwrites the last good result; a quota error (429) stops the run.
 */
export async function monitorSite(siteId: number, o: { client?: GscClient; limit?: number; force?: boolean } = {}): Promise<MonitorRun> {
	const { client, site } = o.client ? { client: o.client, site: clientForSite(siteId).site } : clientForSite(siteId);
	const d = db();
	const limit = o.limit ?? config.indexMonitorUrls;
	const p = periodFor(site, 28);
	const now = topPages(site.id, p.start, p.end, {}, 500).map((r) => r.page);
	const nowSet = new Set(now);
	const lost = topPages(site.id, p.prevStart, p.prevEnd, {}, 200).map((r) => r.page).filter((u) => !nowSet.has(u)).slice(0, 20);
	const candidates = [...new Set([...lost, ...now])];
	const seen = new Map((d.prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ?').all(siteId) as { url: string; fetched_at: number; result: string }[]).map((r) => [r.url, r]));
	const queue = candidates
		.filter((u) => o.force || !seen.has(u) || Date.now() - seen.get(u)!.fetched_at > TTL_MS)
		.sort((a, b) => (seen.get(a)?.fetched_at ?? 0) - (seen.get(b)?.fetched_at ?? 0))
		.slice(0, limit);
	const put = d.prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
	const ev = d.prepare('INSERT INTO index_events (site_id, url, at, kind, detail) VALUES (?,?,?,?,?)');
	const run: MonitorRun = { checked: 0, events: 0, errors: 0, stoppedEarly: null };
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
				if (e instanceof GoogleApiError && e.status === 429) run.stoppedEarly = 'Google\'s URL Inspection quota was reached; the rest will be checked on the next run.';
				else if (e instanceof GoogleApiError && (e.status === 401 || e.status === 403)) run.stoppedEarly = e.message;
			}
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	d.prepare('UPDATE sites SET index_checked_on = ? WHERE id = ?').run(pacificToday(), siteId);
	return run;
}

export function indexSummary(siteId: number) {
	const rows = db().prepare('SELECT url, fetched_at, result FROM url_inspections WHERE site_id = ?').all(siteId) as { url: string; fetched_at: number; result: string }[];
	const counts: Record<IndexState, number> = { indexed: 0, not_indexed: 0, unknown: 0 };
	const notIndexed: { url: string; coverage: string | null; at: number }[] = [];
	let newest = 0;
	for (const r of rows) {
		const f = flatten(JSON.parse(r.result));
		const s = indexState(f);
		counts[s]++;
		newest = Math.max(newest, r.fetched_at);
		if (s === 'not_indexed') notIndexed.push({ url: r.url, coverage: f?.coverageState ?? null, at: r.fetched_at });
	}
	return { checked: rows.length, counts, lastCheck: newest || null, notIndexed: notIndexed.slice(0, 200) };
}

export function recentEvents(siteId: number, limit = 100) {
	return db().prepare('SELECT url, at, kind, detail FROM index_events WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(siteId, limit) as { url: string; at: number; kind: string; detail: string | null }[];
}
