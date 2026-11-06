/** IndexNow: the pure parts (key rules, grouping, response meaning). Checked against indexnow.org's documentation. */

/** "A minimum of 8 and a maximum of 128" characters: a-z, A-Z, 0-9 and "-". */
export const isValidKey = (k: string) => /^[A-Za-z0-9-]{8,128}$/.test(k);

export const MAX_URLS_PER_POST = 10_000;

/** What each HTTP answer means, in the protocol's own terms. ok = the engines received the submission (not that anything is indexed). */
export function explainStatus(status: number): { ok: boolean; message: string } {
	switch (status) {
		case 200: return { ok: true, message: 'Received. This means the search engine got the list, not that the pages are indexed.' };
		case 202: return { ok: true, message: 'Received; the engine is still validating your key (normal the first time).' };
		case 400: return { ok: false, message: 'Rejected: invalid format.' };
		case 403: return { ok: false, message: 'Rejected: the key is not valid. The key file was not found on your host, or it does not contain the key.' };
		case 422: return { ok: false, message: 'Rejected: the URLs do not belong to the host, or the key does not fit the protocol.' };
		case 429: return { ok: false, message: 'Too many requests: the engine suspects spam. Back off; do not resubmit for at least an hour.' };
		case 0: return { ok: false, message: 'No answer from the IndexNow endpoint.' };
		default: return { ok: false, message: `Unexpected answer: HTTP ${status}.` };
	}
}

/** Group URLs by host (lower-cased, as written: IndexNow's `host` must match the URLs exactly), dropping anything that is not http(s). */
export function groupByHost(urls: string[]): { byHost: Map<string, string[]>; invalid: string[] } {
	const byHost = new Map<string, string[]>();
	const invalid: string[] = [];
	const seen = new Set<string>();
	for (const raw of urls) {
		const u = raw.trim();
		if (!u) continue;
		try {
			const x = new URL(u);
			if (x.protocol !== 'http:' && x.protocol !== 'https:') throw new Error('scheme');
			// De-duplicate on the normalised address: "https://Example.com/a" and "https://example.com/a" are one URL.
			if (seen.has(x.href)) continue;
			seen.add(x.href);
			const list = byHost.get(x.hostname.toLowerCase()) ?? [];
			list.push(x.href);
			byHost.set(x.hostname.toLowerCase(), list);
		} catch {
			invalid.push(u);
		}
	}
	return { byHost, invalid };
}

export interface SitemapChanges { added: string[]; updated: string[]; removed: string[]; lastmodUnreliable: boolean }

/**
 * What changed between two reads of a sitemap. "Updated" means its lastmod moved forward. Some sites stamp every URL with the
 * build time, so when a large share of URLs "changed" at once the dates are not telling us anything: then only genuinely new URLs
 * are reported as changes and `lastmodUnreliable` is set.
 */
export function diffSitemaps(before: Map<string, string | null>, after: Map<string, string | null>): SitemapChanges {
	const added: string[] = [], updated: string[] = [], removed: string[] = [];
	for (const [u, m] of after) {
		if (!before.has(u)) added.push(u);
		else {
			const old = before.get(u);
			if (m && old && m > old) updated.push(u);
		}
	}
	for (const u of before.keys()) if (!after.has(u)) removed.push(u);
	const unreliable = updated.length > Math.max(100, 0.3 * after.size);
	return { added, updated: unreliable ? [] : updated, removed, lastmodUnreliable: unreliable };
}
