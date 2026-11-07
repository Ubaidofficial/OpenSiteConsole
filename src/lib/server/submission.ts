import { audit, db } from './db';
import { config } from './config';
import { clientForSite, type SiteRow } from './clients';
import { bingClientFor } from './channels';
import { BING_MAX_URLS_PER_CALL, BingApiError, type BingClient } from './bing';
import { getKey, indexNowStatus, recentSitemapUrls, removedUrls, submitUrls as indexNowSubmit } from './indexnow';
import { indexingApiDailyCap, indexingApiEnabled, indexingApiUsed, pageEligibility, publishUrls } from './indexingapi';
import { flatten, addWatch } from './indexmon';
import { storedInspection } from './inspect';
import { neverShownUrls } from './sitemapcov';
import { linksFor } from './links';
import { hostAllowed } from './onpage';
import { inProperty } from '../property';
import { indexState } from '../indexing';
import { pacificToday } from './dates';

/**
 * "Submit for indexing": one place that pushes URLs to every channel that genuinely accepts them, and says honestly what each did.
 *
 *   indexnow             Bing, Yandex, Naver, Seznam, Yep and others. Google is not part of IndexNow.
 *   bing                 Bing's own URL submission API (needs Bing linked), on top of IndexNow.
 *   google_indexing_api  Google's Indexing API. Google documents it for job-posting and livestream pages only, so every other
 *                        page is refused here (checked from the page's own structured data), not sent.
 *
 * There is no "Request Indexing" call for ordinary pages on Google's side. For those, the sitemap is the route: see the sitemap
 * functions below. Everything sent is logged, and the URLs are put on the indexing monitor's watch list so the next run checks
 * whether Google indexed them.
 */
export type Channel = 'indexnow' | 'bing' | 'google_indexing_api';
export const CHANNELS: Channel[] = ['indexnow', 'bing', 'google_indexing_api'];
export const CHANNEL_LABEL: Record<Channel, string> = { indexnow: 'IndexNow (Bing, Yandex, Naver, …)', bing: 'Bing URL submission', google_indexing_api: 'Google Indexing API (job and livestream pages only)' };
export const MAX_SUBMIT_URLS = 100;

export interface ChannelResult {
	channel: Channel;
	/** false: this channel cannot be used for this site right now; `reason` says why and what to do */
	available: boolean;
	reason?: string;
	/** URLs this channel was asked to take, after its own filtering */
	attempted: number;
	accepted: number;
	skipped: { reason: string; count: number }[];
	error: string | null;
	notes: string[];
}
export interface SubmitReport {
	dryRun: boolean;
	/** valid URLs of this site that were considered */
	urls: string[];
	rejected: { url: string; reason: string }[];
	channels: ChannelResult[];
	/** how many URLs were added to the indexing monitor's watch list */
	watching: number;
	note: string;
}
export interface SubmitOptions {
	channels?: Channel[];
	dryRun?: boolean;
	/** IndexNow only: resend even if sent in the last 24 hours */
	force?: boolean;
	source: 'app' | 'mcp';
	keyId?: number;
	/** for tests */
	fetchImpl?: typeof fetch;
	bingClient?: BingClient;
	now?: number;
}

export class SubmitRefused extends Error {}

/** One spelling per page (no #fragment), only http(s) URLs inside the property, no duplicates. */
export function cleanUrls(input: string[], site: Pick<SiteRow, 'site_url'>): { urls: string[]; rejected: { url: string; reason: string }[] } {
	const urls: string[] = [];
	const rejected: { url: string; reason: string }[] = [];
	const seen = new Set<string>();
	for (const raw of input) {
		const t = String(raw ?? '').trim();
		if (!t) continue;
		let u: URL;
		try {
			u = new URL(t);
		} catch {
			rejected.push({ url: t.slice(0, 200), reason: 'not a full http(s) address' });
			continue;
		}
		if (u.protocol !== 'http:' && u.protocol !== 'https:') {
			rejected.push({ url: t.slice(0, 200), reason: 'not a full http(s) address' });
			continue;
		}
		u.hash = '';
		const href = u.href;
		if (!inProperty(href, site.site_url) || !hostAllowed(href, site.site_url)) {
			rejected.push({ url: href.slice(0, 200), reason: `outside this site (${site.site_url})` });
			continue;
		}
		if (seen.has(href)) continue;
		seen.add(href);
		urls.push(href);
	}
	return { urls, rejected };
}

const logRow = (siteId: number, url: string, channel: Channel, at: number, ok: boolean, message: string, source: 'app' | 'mcp', keyId?: number) =>
	void db().prepare('INSERT INTO index_submissions (site_id, url, channel, at, ok, message, source, key_id) VALUES (?,?,?,?,?,?,?,?)').run(siteId, url, channel, at, ok ? 1 : 0, message.slice(0, 300), source, keyId ?? null);

const empty = (channel: Channel): ChannelResult => ({ channel, available: true, attempted: 0, accepted: 0, skipped: [], error: null, notes: [] });

async function runIndexNow(site: SiteRow, urls: string[], o: SubmitOptions, now: number): Promise<{ r: ChannelResult; per: Map<string, { ok: boolean; message: string }> }> {
	const r = empty('indexnow');
	const per = new Map<string, { ok: boolean; message: string }>();
	const st = indexNowStatus(site, now);
	if (!getKey(site.id)) return { r: { ...r, available: false, reason: 'No IndexNow key yet: create one on the IndexNow tab, upload the key file to your site and verify it.' }, per };
	if (!st.hosts.some((h) => h.ok)) return { r: { ...r, available: false, reason: 'The IndexNow key file is not verified on any host yet (IndexNow tab → Check).' }, per };
	r.attempted = urls.length;
	if (o.dryRun) {
		r.notes.push('Dry run: IndexNow would take the URLs on verified hosts that were not sent in the last 24 hours, up to the daily limit.');
		return { r, per };
	}
	const res = await indexNowSubmit(site, urls, { force: o.force, fetchImpl: o.fetchImpl, now, source: 'manual' });
	r.accepted = res.accepted;
	r.skipped = res.skipped;
	r.error = res.error;
	const ok = new Set((db().prepare('SELECT url FROM indexnow_urls WHERE site_id = ? AND submitted_at = ?').all(site.id, now) as { url: string }[]).map((x) => x.url));
	for (const u of urls) per.set(u, ok.has(u) ? { ok: true, message: 'IndexNow engines received it.' } : { ok: false, message: res.error ?? (res.skipped.map((s) => s.reason).join('; ') || 'Not sent.') });
	return { r, per };
}

async function runBing(site: SiteRow, urls: string[], o: SubmitOptions): Promise<{ r: ChannelResult; per: Map<string, { ok: boolean; message: string }> }> {
	const r = empty('bing');
	const per = new Map<string, { ok: boolean; message: string }>();
	const link = linksFor(site.id).bing;
	if (!link || link.integration_id == null) return { r: { ...r, available: false, reason: 'Bing is not linked to this site (Connect page).' }, per };
	const client = o.bingClient ?? bingClientFor(link.integration_id);
	const siteUrl = link.external_id;
	let allowance = urls.length;
	try {
		const q = await client.urlSubmissionQuota(siteUrl);
		if (q.daily != null) {
			allowance = Math.max(0, Math.min(urls.length, q.daily));
			r.notes.push(`Bing allows ${q.daily.toLocaleString('en-US')} more URLs today${q.monthly != null ? ` and ${q.monthly.toLocaleString('en-US')} this month` : ''}.`);
		}
	} catch (e) {
		r.notes.push(`Could not read Bing's quota (${e instanceof BingApiError ? e.message : 'unknown error'}); sending anyway, Bing will refuse what is over.`);
	}
	const todo = urls.slice(0, allowance);
	if (urls.length > todo.length) r.skipped.push({ reason: "over Bing's daily allowance", count: urls.length - todo.length });
	r.attempted = todo.length;
	if (o.dryRun) return { r, per };
	for (let i = 0; i < todo.length; i += BING_MAX_URLS_PER_CALL) {
		const part = todo.slice(i, i + BING_MAX_URLS_PER_CALL);
		try {
			await client.submitUrlBatch(siteUrl, part);
			r.accepted += part.length;
			for (const u of part) per.set(u, { ok: true, message: 'Bing received it.' });
		} catch (e) {
			const message = e instanceof BingApiError ? e.message : 'Could not reach Bing.';
			r.error = message;
			for (const u of todo.slice(i)) per.set(u, { ok: false, message });
			break; // a refused batch (bad key, quota) would be refused again
		}
	}
	return { r, per };
}

async function runGoogleIndexing(site: SiteRow, urls: string[], o: SubmitOptions, now: number): Promise<{ r: ChannelResult; per: Map<string, { ok: boolean; message: string }> }> {
	const r = empty('google_indexing_api');
	const per = new Map<string, { ok: boolean; message: string }>();
	if (!indexingApiEnabled()) {
		return { r: { ...r, available: false, reason: 'Off. Google documents its Indexing API for job-posting and livestream pages only. To use it for those, set GOOGLE_INCLUDE_INDEXING=1, reconnect the Google account (an extra permission is asked) and make sure it is a verified owner of the property.' }, per };
	}
	// Only pages that carry the structured data Google documents the API for; the check reads the page itself.
	const eligible: string[] = [];
	let i = 0;
	const worker = async () => {
		for (let u = urls[i++]; u; u = urls[i++]) {
			const e = await pageEligibility(u, site.site_url, o.fetchImpl);
			if (e.eligible) eligible.push(u);
			else per.set(u, { ok: false, message: e.reason });
		}
	};
	await Promise.all([worker(), worker(), worker(), worker()]);
	const refused = urls.length - eligible.length;
	if (refused) r.skipped.push({ reason: 'not a job-posting or livestream page (Google documents the Indexing API for those only)', count: refused });
	const left = Math.max(0, indexingApiDailyCap() - indexingApiUsed(site.id, now));
	r.notes.push(`${left} of ${indexingApiDailyCap()} Indexing API notifications left today for this site.`);
	r.attempted = eligible.length;
	if (o.dryRun || !eligible.length) return { r, per };
	const acct = db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined;
	const out = await publishUrls(site, eligible, { fetchImpl: o.fetchImpl, now, demo: !!acct?.is_demo });
	for (const x of out) per.set(x.url, { ok: x.ok, message: x.message });
	r.accepted = out.filter((x) => x.ok).length;
	const firstBad = out.find((x) => !x.ok);
	if (firstBad && !r.accepted) r.error = firstBad.message;
	return { r, per };
}

/**
 * Push `urlsIn` (at most MAX_SUBMIT_URLS) to the chosen channels (default: all of them; one that cannot be used says why).
 * `dryRun` sends nothing and logs nothing: it shows what each channel would do. Refused entirely when READ_ONLY=1 (a dry run is fine).
 */
export async function submitForIndexing(site: SiteRow, urlsIn: string[], o: SubmitOptions): Promise<SubmitReport> {
	if (config.readOnly && !o.dryRun) throw new SubmitRefused('READ_ONLY=1: submitting is disabled on this server. A dry run still works.');
	const now = o.now ?? Date.now();
	const { urls: all, rejected } = cleanUrls(urlsIn, site);
	if (all.length > MAX_SUBMIT_URLS) throw new SubmitRefused(`At most ${MAX_SUBMIT_URLS} URLs per submission; send the rest in another one.`);
	if (!all.length) throw new SubmitRefused(rejected.length ? `None of the URLs can be submitted: ${rejected[0].reason}.` : 'Give at least one full URL of this site.');
	const want = (o.channels?.length ? o.channels : CHANNELS).filter((c) => CHANNELS.includes(c));
	const results: { r: ChannelResult; per: Map<string, { ok: boolean; message: string }> }[] = [];
	for (const c of want) {
		results.push(c === 'indexnow' ? await runIndexNow(site, all, o, now) : c === 'bing' ? await runBing(site, all, o) : await runGoogleIndexing(site, all, o, now));
	}
	let watching = 0;
	if (!o.dryRun) {
		const accepted = new Set<string>();
		for (const { r, per } of results) {
			for (const [url, v] of per) {
				logRow(site.id, url, r.channel, now, v.ok, v.message, o.source, o.keyId);
				if (v.ok) accepted.add(url);
			}
		}
		if (accepted.size) {
			addWatch(site.id, [...accepted]);
			watching = Math.min(200, accepted.size);
		}
		audit('index.submit', { siteId: site.id, detail: `${all.length} URL${all.length === 1 ? '' : 's'} via ${results.map((x) => `${x.r.channel}:${x.r.accepted}`).join(', ')} (${o.source})` });
	}
	return {
		dryRun: !!o.dryRun,
		urls: all,
		rejected,
		channels: results.map((x) => x.r),
		watching,
		note: 'Accepted means the channel received the list, not that the pages are indexed. Google has no "request indexing" call for ordinary pages: for those, keep the sitemap current and watch the status below; the submitted URLs are now checked first by the indexing monitor.'
	};
}

// ── presets: URL lists worth submitting ─────────────────────────────────────
export type Preset = 'new' | 'never_shown' | 'removed';
export function presetUrls(site: SiteRow, preset: Preset, limit = MAX_SUBMIT_URLS): string[] {
	const list = preset === 'new' ? recentSitemapUrls(site.id, pacificToday()) : preset === 'never_shown' ? neverShownUrls(site, limit) : removedUrls(site);
	return list.slice(0, limit);
}

// ── sitemaps (Google) ────────────────────────────────────────────────────────
function checkFeed(site: SiteRow, feed: string): string {
	const f = feed.trim();
	if (!/^https?:\/\/\S+$/i.test(f)) throw new SubmitRefused('Give a full sitemap address, e.g. https://example.com/sitemap.xml');
	if (!inProperty(f, site.site_url)) throw new SubmitRefused(`${f} is outside the property ${site.site_url}; Search Console only takes sitemaps from inside it.`);
	return f;
}
const guardWrite = () => {
	if (config.readOnly) throw new SubmitRefused('READ_ONLY=1: sitemap changes are disabled on this server.');
};

export async function submitSitemapTo(site: SiteRow, feed: string, source: 'app' | 'mcp'): Promise<string> {
	guardWrite();
	const f = checkFeed(site, feed);
	try {
		await clientForSite(site.id).client.submitSitemap(site.site_url, f);
	} catch (e) {
		throw new SubmitRefused(`Search Console refused it: ${e instanceof Error ? e.message : 'unknown error'}`);
	}
	audit('sitemap.submitted', { siteId: site.id, detail: `${f} (${source})` });
	return f;
}

/** Submit again every sitemap Search Console already lists for the site. Google may not read it sooner for it; it is the closest thing to a nudge it offers. */
export async function resubmitSitemaps(site: SiteRow, source: 'app' | 'mcp'): Promise<{ submitted: string[]; failed: { path: string; error: string }[] }> {
	guardWrite();
	const { client } = clientForSite(site.id);
	let list;
	try {
		list = await client.listSitemaps(site.site_url);
	} catch (e) {
		throw new SubmitRefused(`Search Console could not list the sitemaps: ${e instanceof Error ? e.message : 'unknown error'}`);
	}
	const submitted: string[] = [];
	const failed: { path: string; error: string }[] = [];
	for (const s of list) {
		try {
			await client.submitSitemap(site.site_url, s.path);
			submitted.push(s.path);
		} catch (e) {
			failed.push({ path: s.path, error: e instanceof Error ? e.message : 'failed' });
		}
	}
	audit('sitemap.resubmitted', { siteId: site.id, detail: `${submitted.length} of ${list.length} (${source})` });
	return { submitted, failed };
}

export async function deleteSitemapFrom(site: SiteRow, feed: string, source: 'app' | 'mcp'): Promise<string> {
	guardWrite();
	const f = checkFeed(site, feed);
	try {
		await clientForSite(site.id).client.deleteSitemap(site.site_url, f);
	} catch (e) {
		throw new SubmitRefused(`Search Console refused it: ${e instanceof Error ? e.message : 'unknown error'}`);
	}
	audit('sitemap.deleted', { siteId: site.id, detail: `${f} (${source})` });
	return f;
}

// ── what happened to what was submitted ──────────────────────────────────────
export interface SubmissionRow {
	url: string;
	submittedAt: number;
	channels: { channel: Channel; ok: boolean; message: string }[];
	/** what the newest stored Google inspection says; null when never inspected */
	google: { state: 'indexed' | 'not_indexed' | 'unknown'; coverage: string | null; checkedAt: number; checkedAfterSubmit: boolean } | null;
}

/** The most recently submitted URLs, each with its channels' answers and Google's latest known index state. */
export function submissionStatus(siteId: number, limit = 50): SubmissionRow[] {
	const d = db();
	const urls = d.prepare('SELECT url, MAX(at) at FROM index_submissions WHERE site_id = ? GROUP BY url ORDER BY MAX(at) DESC LIMIT ?').all(siteId, Math.min(500, Math.max(1, limit))) as { url: string; at: number }[];
	const rows = d.prepare('SELECT channel, ok, message FROM index_submissions WHERE site_id = ? AND url = ? AND at = ? ORDER BY id');
	return urls.map((u) => {
		const s = storedInspection(siteId, u.url);
		const flat = s ? flatten(s.r) : null;
		return {
			url: u.url,
			submittedAt: u.at,
			channels: (rows.all(siteId, u.url, u.at) as { channel: Channel; ok: number; message: string }[]).map((x) => ({ channel: x.channel, ok: !!x.ok, message: x.message })),
			google: s ? { state: indexState(flat), coverage: s.r.error ? null : (s.r.indexStatusResult?.coverageState ?? null), checkedAt: s.at, checkedAfterSubmit: s.at >= u.at } : null
		};
	});
}

export { indexingApiEnabled };
