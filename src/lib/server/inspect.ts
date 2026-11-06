import { clientForSite } from './clients';
import { db } from './db';
import type { InspectionResult } from './google';

/** URL Inspection answers are reused for 12 hours: the API is quota-limited. */
export const INSPECT_TTL = 12 * 3600_000;
export const MAX_INSPECT_URLS = 20;

export interface InspectOutcome { url: string; fromCache: boolean }
export interface StoredInspection { url: string; at: number; r: InspectionResult & { error?: string } }

/** Inspect URLs through Google (3 at a time, newest cached answer reused unless `force`), storing each answer. */
export async function inspectUrls(siteId: number, urls: string[], force: boolean): Promise<{ live: number; cached: number; outcomes: InspectOutcome[] }> {
	const { client, site } = clientForSite(siteId);
	const d = db();
	const get = d.prepare('SELECT fetched_at, result FROM url_inspections WHERE site_id = ? AND url = ?');
	const put = d.prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
	let live = 0;
	let cached = 0;
	const outcomes: InspectOutcome[] = [];
	const queue = [...new Set(urls)].slice(0, MAX_INSPECT_URLS);
	const worker = async () => {
		for (let u = queue.shift(); u; u = queue.shift()) {
			const hit = get.get(siteId, u) as { fetched_at: number; result: string } | undefined;
			if (hit && !force && Date.now() - hit.fetched_at < INSPECT_TTL) {
				cached++;
				outcomes.push({ url: u, fromCache: true });
				continue;
			}
			try {
				put.run(siteId, u, Date.now(), JSON.stringify(await client.inspectUrl(site.site_url, u)));
			} catch (e) {
				// Keep the last good result (the indexing monitor diffs against it); only record the error if there is nothing better.
				const good = hit && !(JSON.parse(hit.result) as { error?: string }).error;
				if (!good) put.run(siteId, u, Date.now(), JSON.stringify({ error: e instanceof Error ? e.message : 'Inspection failed' }));
			}
			live++;
			outcomes.push({ url: u, fromCache: false });
		}
	};
	await Promise.all([worker(), worker(), worker()]);
	return { live, cached, outcomes };
}

export function storedInspection(siteId: number, url: string): StoredInspection | null {
	const r = db().prepare('SELECT fetched_at, result FROM url_inspections WHERE site_id = ? AND url = ?').get(siteId, url) as { fetched_at: number; result: string } | undefined;
	return r ? { url, at: r.fetched_at, r: JSON.parse(r.result) } : null;
}
