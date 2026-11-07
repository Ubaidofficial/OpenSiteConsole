import { db } from './db';
import { accessToken, googleJson, GoogleApiError } from './google';
import { fetchPage } from './onpage';
import type { SiteRow } from './clients';

/**
 * Google's Indexing API. Google's documentation says it is only for pages with JobPosting structured data or BroadcastEvent
 * (livestream) data embedded in a VideoObject. It is NOT a way to get ordinary pages indexed, so this module refuses every
 * other page: eligibility is checked from the page's own JSON-LD before anything is sent. Ordinary pages go through the sitemap.
 *
 * It needs an extra Google permission (the "indexing" scope) and the signed-in Google account must be a verified owner of the
 * property. Both are opt-in: GOOGLE_INCLUDE_INDEXING=1 adds the scope to new connections.
 */
export const SCOPE_INDEXING = 'https://www.googleapis.com/auth/indexing';
export const indexingApiEnabled = () => process.env.GOOGLE_INCLUDE_INDEXING === '1';
const ENDPOINT = 'https://indexing.googleapis.com/v3/urlNotifications:publish';

/** URLs a site may send a day. The documented default quota, as far as I know, is 200 a day; raise it with INDEXING_API_MAX_PER_DAY if Google granted more. */
export const indexingApiDailyCap = () => {
	const n = Number(process.env.INDEXING_API_MAX_PER_DAY ?? '200');
	return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : 200;
};

const ELIGIBLE_TYPES = new Set(['jobposting', 'broadcastevent']);

/** Collect every "@type" in the page's application/ld+json blocks (also inside @graph and nested objects). */
export function jsonLdTypes(html: string): Set<string> {
	const found = new Set<string>();
	const walk = (v: unknown, depth = 0) => {
		if (depth > 12 || v === null || typeof v !== 'object') return;
		if (Array.isArray(v)) return void v.forEach((x) => walk(x, depth + 1));
		const o = v as Record<string, unknown>;
		const t = o['@type'];
		for (const x of Array.isArray(t) ? t : [t]) if (typeof x === 'string') found.add(x.toLowerCase().replace(/^https?:\/\/schema\.org\//, ''));
		for (const k of Object.keys(o)) walk(o[k], depth + 1);
	};
	for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
		try {
			walk(JSON.parse(m[1].trim()));
		} catch {
			/* a broken block contributes nothing */
		}
	}
	return found;
}

export interface Eligibility { eligible: boolean; reason: string }

/** Whether the page has the structured data the Indexing API is documented for. `reason` says why not, in words a person can act on. */
export function eligibilityFromHtml(html: string): Eligibility {
	const types = jsonLdTypes(html);
	const hit = [...types].find((t) => ELIGIBLE_TYPES.has(t));
	if (hit) return { eligible: true, reason: hit === 'jobposting' ? 'The page has JobPosting structured data.' : 'The page has BroadcastEvent structured data.' };
	return { eligible: false, reason: 'No JobPosting or BroadcastEvent structured data on the page: Google documents the Indexing API for those pages only. Use the sitemap for this one.' };
}

export async function pageEligibility(url: string, siteUrl: string, fetchImpl?: typeof fetch): Promise<Eligibility> {
	const p = await fetchPage(url, siteUrl, fetchImpl);
	if (!p.html) return { eligible: false, reason: `Could not fetch the page to check it (${p.error ?? 'HTTP ' + p.status}), so it was not sent.` };
	return eligibilityFromHtml(p.html);
}

const usedKey = (siteId: number, day: string) => `indexingapi:${siteId}:${day}`;
export const indexingApiUsed = (siteId: number, now = Date.now()) => Number((db().prepare('SELECT value FROM kv WHERE key = ?').get(usedKey(siteId, new Date(now).toISOString().slice(0, 10))) as { value: string } | undefined)?.value ?? 0);
const addUsed = (siteId: number, n: number, now: number) => {
	if (n > 0) db().prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?').run(usedKey(siteId, new Date(now).toISOString().slice(0, 10)), String(n), n);
};

export interface PublishOutcome { url: string; ok: boolean; message: string }

/** What a refusal from Google means for the person, not the raw error. */
export function explainIndexingError(e: unknown): string {
	if (!(e instanceof GoogleApiError)) return 'Could not reach Google.';
	if (e.status === 403) return 'Google refused: the account is not a verified owner of this property, or the Indexing API permission was not granted. Set GOOGLE_INCLUDE_INDEXING=1 and reconnect the Google account.';
	if (e.status === 429) return 'Google says the Indexing API daily quota is used up. Try again tomorrow.';
	if (e.status === 401) return 'Google rejected the sign-in: reconnect the Google account.';
	return e.message;
}

/** Notify Google that eligible pages were added or changed (URL_UPDATED). One request per URL, as the API takes one. */
export async function publishUrls(site: SiteRow, urls: string[], o: { fetchImpl?: typeof fetch; now?: number; demo?: boolean } = {}): Promise<PublishOutcome[]> {
	const now = o.now ?? Date.now();
	const out: PublishOutcome[] = [];
	let budget = indexingApiDailyCap() - indexingApiUsed(site.id, now);
	let sent = 0;
	for (const url of urls) {
		if (budget <= 0) {
			out.push({ url, ok: false, message: `Daily limit of ${indexingApiDailyCap()} Indexing API notifications reached for this site.` });
			continue;
		}
		if (o.demo) {
			out.push({ url, ok: true, message: 'Demo: not sent to Google.' });
			budget--;
			sent++;
			continue;
		}
		try {
			await googleJson<unknown>(() => accessToken(site.account_id), ENDPOINT, { method: 'POST', body: JSON.stringify({ url, type: 'URL_UPDATED' }) }, { fetchImpl: o.fetchImpl, retries: 1 });
			out.push({ url, ok: true, message: 'Google received the notification.' });
			budget--;
			sent++;
		} catch (e) {
			const message = explainIndexingError(e);
			out.push({ url, ok: false, message });
			if (e instanceof GoogleApiError && (e.status === 403 || e.status === 429 || e.status === 401)) {
				for (const rest of urls.slice(urls.indexOf(url) + 1)) out.push({ url: rest, ok: false, message: 'Not sent: ' + message });
				break; // the same refusal would repeat for every remaining URL
			}
		}
	}
	addUsed(site.id, sent, now);
	return out;
}

