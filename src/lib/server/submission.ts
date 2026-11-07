import { audit, db } from './db';
import { config } from './config';
import { clientForSite, type SiteRow } from './clients';
import { bingClientFor } from './channels';
import { BING_MAX_URLS_PER_CALL, BingApiError, type BingClient } from './bing';
import { getKey, indexNowStatus, recentSitemapUrls, removedUrls, submitUrls as indexNowSubmit, backoffUntil } from './indexnow';
import { indexingApiDailyCap, indexingApiEnabled, indexingApiUsed, pageEligibility, publishUrls } from './indexingapi';
import { flatten, addWatch } from './indexmon';
import { inspectUrls, storedInspection } from './inspect';
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
	/** URLs held back in the queue to be sent later (over today's limit, or spread over days) */
	queued: number;
	/** URLs this channel accepted */
	acceptedUrls: string[];
	/** URLs left out only because today's limit was reached (internal: they are what gets queued) */
	overflow: string[];
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
	source: 'app' | 'mcp' | 'queue';
	keyId?: number;
	/** Hold back what does not fit today (a channel's daily limit) and send it on the following days. Default true. */
	queueOverflow?: boolean;
	/** Spread the list over this many days (1-30): each channel gets an even share now and the rest is queued, released one share a day. */
	dripDays?: number;
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

const logRow = (siteId: number, url: string, channel: Channel, at: number, ok: boolean, message: string, source: string, keyId?: number) =>
	void db().prepare('INSERT INTO index_submissions (site_id, url, channel, at, ok, message, source, key_id) VALUES (?,?,?,?,?,?,?,?)').run(siteId, url, channel, at, ok ? 1 : 0, message.slice(0, 300), source, keyId ?? null);

const empty = (channel: Channel): ChannelResult => ({ channel, available: true, attempted: 0, accepted: 0, skipped: [], error: null, notes: [], queued: 0, acceptedUrls: [], overflow: [] });

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
	r.overflow = res.overflow;
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
		rememberBingQuota(site.id, q, o.now ?? Date.now());
		if (q.daily != null) {
			allowance = Math.max(0, Math.min(urls.length, q.daily));
			r.notes.push(`Bing allows ${q.daily.toLocaleString('en-US')} more URLs today${q.monthly != null ? ` and ${q.monthly.toLocaleString('en-US')} this month` : ''}.`);
		}
	} catch (e) {
		r.notes.push(`Could not read Bing's quota (${e instanceof BingApiError ? e.message : 'unknown error'}); sending anyway, Bing will refuse what is over.`);
	}
	const todo = urls.slice(0, allowance);
	if (urls.length > todo.length) {
		r.skipped.push({ reason: "over Bing's daily allowance", count: urls.length - todo.length });
		r.overflow = urls.slice(allowance);
	}
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
	r.overflow = out.filter((x) => x.overflow).map((x) => x.url);
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
	// Drip: an even share goes now, the rest is queued and released one share a day. A drip always needs the queue.
	const drip = Math.min(MAX_DRIP_DAYS, Math.max(1, Math.floor(Number(o.dripDays) || 1)));
	const share = drip > 1 ? Math.ceil(all.length / drip) : all.length;
	const sendNow = all.slice(0, share);
	const deferred = all.slice(share);
	const queueOn = o.queueOverflow !== false || drip > 1;
	const results: { r: ChannelResult; per: Map<string, { ok: boolean; message: string }> }[] = [];
	for (const c of want) {
		results.push(c === 'indexnow' ? await runIndexNow(site, sendNow, o, now) : c === 'bing' ? await runBing(site, sendNow, o) : await runGoogleIndexing(site, sendNow, o, now));
	}
	let watching = 0;
	for (const { r, per } of results) {
		r.acceptedUrls = [...per].filter(([, v]) => v.ok).map(([u]) => u);
		if (!r.available || !queueOn) continue;
		const items = [...r.overflow.map((url) => ({ url, releaseAt: now })), ...deferred.map((url, i) => ({ url, releaseAt: now + (Math.floor(i / share) + 1) * DAY }))];
		if (!items.length) continue;
		const put = enqueueRows(site.id, r.channel, items, o.source, o.keyId, now, !!o.dryRun);
		r.queued = put.queued;
		if (deferred.length) r.notes.push(`Spread over ${drip} days: ${sendNow.length} now, ${deferred.length} queued, ${share} released a day.`);
		if (r.overflow.length) r.notes.push(`${r.overflow.length} did not fit today's limit and ${o.dryRun ? 'would be' : 'were'} queued to go later.`);
		if (put.full) r.notes.push(`The queue is full (${MAX_QUEUE} URLs): ${put.full} were not queued.`);
	}
	if (!o.dryRun) {
		const accepted = new Set<string>();
		for (const { r, per } of results) {
			for (const [url, v] of per) {
				logRow(site.id, url, r.channel, now, v.ok, v.message, o.source, o.keyId);
				if (v.ok) accepted.add(url);
			}
		}
		if (accepted.size) {
			addWatch(site.id, [...accepted], 'submit');
			scheduleRechecks(site.id, [...accepted], now);
			watching = Math.min(200, accepted.size);
		}
		const q = results.reduce((n, x) => n + x.r.queued, 0);
		audit('index.submit', { siteId: site.id, detail: `${all.length} URL${all.length === 1 ? '' : 's'} via ${results.map((x) => `${x.r.channel}:${x.r.accepted}`).join(', ')}${q ? `, ${q} queued` : ''} (${o.source})` });
	}
	return {
		dryRun: !!o.dryRun,
		urls: all,
		rejected,
		channels: results.map((x) => x.r),
		watching,
		note: 'Accepted means the channel received the list, not that the pages are indexed. Google has no "request indexing" call for ordinary pages: for those, keep the sitemap current. Each accepted URL is asked about again at day 1, 3 and 5; the status table shows the answers.'
	};
}

// ── presets: URL lists worth submitting ─────────────────────────────────────
export type Preset = 'new' | 'never_shown' | 'removed';
export function presetUrls(site: SiteRow, preset: Preset, limit = MAX_SUBMIT_URLS): string[] {
	const list = preset === 'new' ? recentSitemapUrls(site.id, pacificToday()) : preset === 'never_shown' ? neverShownUrls(site, limit) : removedUrls(site);
	return list.slice(0, limit);
}

// ── sitemaps (Google) ────────────────────────────────────────────────────────
/** The sitemap address, if it is a full URL inside the property (the only place Search Console takes sitemaps from). */
export function checkFeed(site: SiteRow, feed: string): string {
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

/**
 * The owner pressed "Request indexing" in Search Console for these URLs (the button has no API, so this only records it): log it with the
 * other submissions, put them on the watch list and give them the same day 1, 3 and 5 re-checks.
 */
export function recordManualRequests(site: SiteRow, urls: string[], source: 'app' | 'mcp', now = Date.now(), keyId?: number): number {
	for (const u of urls) logRow(site.id, u, 'search_console' as Channel, now, true, 'You asked for indexing in Search Console.', source, keyId);
	if (urls.length) {
		addWatch(site.id, urls, 'submit');
		scheduleRechecks(site.id, urls, now);
		audit('index.requested', { siteId: site.id, detail: `${urls.length} URL${urls.length === 1 ? '' : 's'} (${source})` });
	}
	return urls.length;
}

// ── what happened to what was submitted ──────────────────────────────────────
export interface SubmissionRow {
	url: string;
	submittedAt: number;
	daysSince: number;
	/** indexed: Google says so, in an inspection taken after the submission. still_not_indexed: 5 or more days on and that inspection says no. waiting: anything else. */
	verdict: 'indexed' | 'still_not_indexed' | 'waiting';
	/** when the next automatic re-check is due; null when none is left */
	nextCheckAt: number | null;
	channels: { channel: Channel | 'search_console'; ok: boolean; message: string }[];
	/** what the newest stored Google inspection says; null when never inspected */
	google: { state: 'indexed' | 'not_indexed' | 'unknown'; coverage: string | null; checkedAt: number; checkedAfterSubmit: boolean } | null;
}

/** The most recently submitted URLs, each with its channels' answers and Google's latest known index state. */
export function submissionStatus(siteId: number, limit = 50, now = Date.now()): SubmissionRow[] {
	const d = db();
	const urls = d.prepare('SELECT url, MAX(at) at FROM index_submissions WHERE site_id = ? GROUP BY url ORDER BY MAX(at) DESC LIMIT ?').all(siteId, Math.min(500, Math.max(1, limit))) as { url: string; at: number }[];
	const rows = d.prepare('SELECT channel, ok, message FROM index_submissions WHERE site_id = ? AND url = ? AND at = ? ORDER BY id');
	const next = d.prepare('SELECT due_at FROM index_rechecks WHERE site_id = ? AND url = ?');
	return urls.map((u) => {
		const s = storedInspection(siteId, u.url);
		const flat = s ? flatten(s.r) : null;
		const google = s ? { state: indexState(flat), coverage: s.r.error ? null : (s.r.indexStatusResult?.coverageState ?? null), checkedAt: s.at, checkedAfterSubmit: s.at >= u.at } : null;
		const daysSince = Math.max(0, Math.floor((now - u.at) / DAY));
		return {
			url: u.url,
			submittedAt: u.at,
			daysSince,
			verdict: google?.checkedAfterSubmit && google.state === 'indexed' ? 'indexed' : daysSince >= RECHECK_DAYS[RECHECK_DAYS.length - 1] && google?.checkedAfterSubmit && google.state === 'not_indexed' ? 'still_not_indexed' : 'waiting',
			nextCheckAt: (next.get(siteId, u.url) as { due_at: number } | undefined)?.due_at ?? null,
			channels: (rows.all(siteId, u.url, u.at) as { channel: Channel | 'search_console'; ok: number; message: string }[]).map((x) => ({ channel: x.channel, ok: !!x.ok, message: x.message })),
			google
		};
	});
}


// ── the queue: what did not fit today, or is being spread over days ──────────
export const MAX_QUEUE = 5000;
export const MAX_DRIP_DAYS = 30;
const DAY = 86_400_000;
const QUEUE_EXPIRES_MS = 7 * DAY;
const CHANNEL_RETRY_MS = 3 * 3600_000;

export const queueSize = (siteId: number) => (db().prepare('SELECT COUNT(*) n FROM index_queue WHERE site_id = ?').get(siteId) as { n: number }).n;

/**
 * Put URLs on a channel's queue. A URL already waiting there counts as queued (it is, and keeps its place); only a URL that really
 * cannot be added because the queue is full is reported as not queued. `dry` counts without writing.
 */
function enqueueRows(siteId: number, channel: Channel, items: { url: string; releaseAt: number }[], source: string, keyId: number | undefined, now: number, dry = false): { queued: number; full: number } {
	const d = db();
	let room = Math.max(0, MAX_QUEUE - queueSize(siteId));
	const has = d.prepare('SELECT 1 FROM index_queue WHERE site_id = ? AND url = ? AND channel = ?');
	const ins = d.prepare('INSERT OR IGNORE INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source, key_id) VALUES (?,?,?,?,?,?,?,?)');
	let queued = 0;
	let full = 0;
	d.transaction(() => {
		for (const it of items) {
			if (has.get(siteId, it.url, channel)) queued++;
			else if (room > 0) {
				if (!dry) ins.run(siteId, it.url, channel, now, it.releaseAt, it.releaseAt, source, keyId ?? null);
				room--;
				queued++;
			} else full++;
		}
	})();
	return { queued, full };
}

export interface QueueStatus { total: number; byChannel: Record<Channel, number>; releasableNow: number; nextReleaseAt: number | null; oldestAt: number | null }
export function queueStatus(siteId: number, now = Date.now()): QueueStatus {
	const d = db();
	const by = Object.fromEntries(CHANNELS.map((c) => [c, 0])) as Record<Channel, number>;
	for (const r of d.prepare('SELECT channel, COUNT(*) n FROM index_queue WHERE site_id = ? GROUP BY channel').all(siteId) as { channel: Channel; n: number }[]) by[r.channel] = r.n;
	const agg = d.prepare('SELECT COUNT(*) total, SUM(release_at <= ?) due, MIN(CASE WHEN release_at > ? THEN release_at END) next, MIN(added_at) oldest FROM index_queue WHERE site_id = ?').get(now, now, siteId) as { total: number; due: number | null; next: number | null; oldest: number | null };
	return { total: agg.total, byChannel: by, releasableNow: agg.due ?? 0, nextReleaseAt: agg.next, oldestAt: agg.oldest };
}

/** Take everything off the queue (or one channel's share). Nothing already sent is affected. */
export function clearQueue(siteId: number, source: 'app' | 'mcp', channel?: Channel): number {
	const n = channel ? db().prepare('DELETE FROM index_queue WHERE site_id = ? AND channel = ?').run(siteId, channel).changes : db().prepare('DELETE FROM index_queue WHERE site_id = ?').run(siteId).changes;
	if (n) audit('index.queue_cleared', { siteId, detail: `${n} URL${n === 1 ? '' : 's'}${channel ? ` (${channel})` : ''} (${source})` });
	return n;
}

/**
 * Send what the queue holds and is due: per channel, up to MAX_SUBMIT_URLS at a time, through the same path as a normal submission
 * (so the same limits, checks, log and re-checks apply). What a channel took, or refused for good, leaves the queue; what still did not fit
 * stays; a whole-channel failure (Bing down, IndexNow told us to slow down) waits 3 hours; a channel that cannot be used stays put.
 * Anything still unsent 7 days after it was first due (a drip's later days count from their own day) is dropped, and the log says so.
 */
export async function drainQueue(site: SiteRow, o: { now?: number; fetchImpl?: typeof fetch; bingClient?: BingClient } = {}): Promise<{ sent: number; remaining: number; expired: number }> {
	const now = o.now ?? Date.now();
	const d = db();
	if (config.readOnly) return { sent: 0, remaining: queueSize(site.id), expired: 0 };
	const old = d.prepare('SELECT id, url, channel FROM index_queue WHERE site_id = ? AND first_release_at < ?').all(site.id, now - QUEUE_EXPIRES_MS) as { id: number; url: string; channel: Channel }[];
	for (const x of old) {
		logRow(site.id, x.url, x.channel, now, false, 'Dropped from the queue: 7 days after it was due it still had not been sent.', 'queue');
		d.prepare('DELETE FROM index_queue WHERE id = ?').run(x.id);
	}
	let sent = 0;
	const drop = (rows: { id: number }[]) => rows.forEach((r) => d.prepare('DELETE FROM index_queue WHERE id = ?').run(r.id));
	for (const channel of CHANNELS) {
		const rows = d.prepare('SELECT id, url FROM index_queue WHERE site_id = ? AND channel = ? AND release_at <= ? ORDER BY release_at, id LIMIT ?').all(site.id, channel, now, MAX_SUBMIT_URLS) as { id: number; url: string }[];
		if (!rows.length) continue;
		let rep: SubmitReport;
		try {
			rep = await submitForIndexing(site, rows.map((r) => r.url), { channels: [channel], source: 'queue', queueOverflow: false, fetchImpl: o.fetchImpl, bingClient: o.bingClient, now });
		} catch (e) {
			if (!(e instanceof SubmitRefused)) throw e;
			drop(rows); // none of them can be submitted at all (for example no longer inside the property)
			continue;
		}
		const r = rep.channels[0];
		if (!r.available) continue;
		if (r.error && !r.accepted) {
			d.prepare(`UPDATE index_queue SET release_at = ? WHERE id IN (${rows.map(() => '?').join(',')})`).run(now + CHANNEL_RETRY_MS, ...rows.map((x) => x.id));
			continue;
		}
		const stays = new Set(r.overflow);
		drop(rows.filter((x) => !stays.has(x.url)));
		sent += r.accepted;
	}
	if (sent || old.length) audit('index.queue_drain', { siteId: site.id, detail: `${sent} sent${old.length ? `, ${old.length} expired` : ''}` });
	return { sent, remaining: queueSize(site.id), expired: old.length };
}

// ── automatic re-checks: is it indexed yet? (day 1, 3 and 5 after a URL was accepted) ──
export const RECHECK_DAYS = [1, 3, 5];
export const recheckPerRun = () => {
	const n = Number(process.env.INDEX_RECHECK_PER_RUN ?? '40');
	return Number.isInteger(n) && n >= 1 && n <= 200 ? n : 40;
};

function scheduleRechecks(siteId: number, urls: string[], now: number) {
	const ins = db().prepare('INSERT OR REPLACE INTO index_rechecks (site_id, url, submitted_at, step, due_at, attempts) VALUES (?,?,?,?,?,0)');
	db().transaction(() => {
		for (const u of urls) ins.run(siteId, u, now, 0, now + RECHECK_DAYS[0] * DAY);
	})();
}

export interface RecheckRun { checked: number; indexed: number; stillNot: number; postponed: number }

/**
 * Ask Google (URL Inspection, answers forced fresh) about the URLs whose re-check is due. A URL that is indexed is finished and comes off
 * the watch list; one that is not moves to its next step; after the last step (day 5) it is finished too and shows as "still not indexed"
 * in the status table. A check that could not be made (Google refused or failed) is tried again in 6 hours, and after 4 tries the URL moves on.
 */
export async function runDueRechecks(site: SiteRow, o: { now?: number; limit?: number } = {}): Promise<RecheckRun> {
	const now = o.now ?? Date.now();
	const d = db();
	const out: RecheckRun = { checked: 0, indexed: 0, stillNot: 0, postponed: 0 };
	const due = d.prepare('SELECT url, submitted_at s, step, attempts FROM index_rechecks WHERE site_id = ? AND due_at <= ? ORDER BY due_at LIMIT ?').all(site.id, now, o.limit ?? recheckPerRun()) as { url: string; s: number; step: number; attempts: number }[];
	const finish = (url: string) => {
		d.prepare('DELETE FROM index_rechecks WHERE site_id = ? AND url = ?').run(site.id, url);
		d.prepare("DELETE FROM index_watch WHERE site_id = ? AND url = ? AND source = 'submit'").run(site.id, url);
	};
	const advance = (row: { url: string; s: number; step: number }, notIndexed: boolean) => {
		const next = row.step + 1;
		if (next >= RECHECK_DAYS.length) {
			finish(row.url);
			if (notIndexed) out.stillNot++;
		} else d.prepare('UPDATE index_rechecks SET step = ?, due_at = ?, attempts = 0 WHERE site_id = ? AND url = ?').run(next, Math.max(now, row.s + RECHECK_DAYS[next] * DAY), site.id, row.url);
	};
	for (let i = 0; i < due.length; i += 20) {
		const chunk = due.slice(i, i + 20);
		const started = Date.now();
		try {
			await inspectUrls(site.id, chunk.map((c) => c.url), true);
		} catch {
			/* each URL is judged below from what was actually stored */
		}
		for (const row of chunk) {
			const st = storedInspection(site.id, row.url);
			if (!st || st.at < started || st.r.error) {
				out.postponed++;
				if (row.attempts + 1 >= 4) advance(row, false);
				else d.prepare('UPDATE index_rechecks SET due_at = ?, attempts = attempts + 1 WHERE site_id = ? AND url = ?').run(now + 6 * 3600_000, site.id, row.url);
				continue;
			}
			out.checked++;
			if (indexState(flatten(st.r)) === 'indexed') {
				finish(row.url);
				out.indexed++;
			} else advance(row, true);
		}
	}
	return out;
}

/** Whether a site has queued URLs that may go now or re-checks that are due. Cheap: two small queries. */
export function submissionWorkDue(siteId: number, now = Date.now()): boolean {
	const d = db();
	return !!d.prepare('SELECT 1 FROM index_queue WHERE site_id = ? AND release_at <= ? LIMIT 1').get(siteId, now) || !!d.prepare('SELECT 1 FROM index_rechecks WHERE site_id = ? AND due_at <= ? LIMIT 1').get(siteId, now);
}
export async function runSubmissionWork(site: SiteRow): Promise<void> {
	await drainQueue(site);
	await runDueRechecks(site);
}

// ── limits and usage, in one place ───────────────────────────────────────────
const bingQuotaKey = (siteId: number) => `bing_quota:${siteId}`;
export function rememberBingQuota(siteId: number, q: { daily: number | null; monthly: number | null }, at: number) {
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(bingQuotaKey(siteId), JSON.stringify({ ...q, at }));
}
/** Ask Bing now how many URLs it still takes (read-only), and remember the answer for the overview. */
export async function refreshBingQuota(site: SiteRow, client?: BingClient): Promise<{ daily: number | null; monthly: number | null; at: number }> {
	const link = linksFor(site.id).bing;
	if (!link || link.integration_id == null) throw new SubmitRefused('Bing is not linked to this site (Connect page).');
	try {
		const q = await (client ?? bingClientFor(link.integration_id)).urlSubmissionQuota(link.external_id);
		const at = Date.now();
		rememberBingQuota(site.id, q, at);
		return { ...q, at };
	} catch (e) {
		throw new SubmitRefused(`Could not read Bing's quota: ${e instanceof BingApiError ? e.message : 'unknown error'}`);
	}
}

export interface QuotaOverview {
	indexnow: { ready: boolean; used24h: number; cap: number; pausedUntil: number | null };
	bing: { linked: boolean; daily: number | null; monthly: number | null; checkedAt: number | null };
	googleIndexingApi: { enabled: boolean; usedToday: number; cap: number };
	urlInspection: { storedToday: number; approxDailyLimit: number; monitorPerRun: number; rechecksPerRun: number };
	queue: QueueStatus;
}
/** Everything that limits how much can be sent or checked, from stored data (Bing's figure is the one last read; refresh it to update). */
export function quotaOverview(site: SiteRow, now = Date.now()): QuotaOverview {
	const st = indexNowStatus(site, now);
	const bq = db().prepare('SELECT value FROM kv WHERE key = ?').get(bingQuotaKey(site.id)) as { value: string } | undefined;
	const q = bq ? (JSON.parse(bq.value) as { daily: number | null; monthly: number | null; at: number }) : null;
	const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
	return {
		indexnow: { ready: st.hasKey && st.hosts.some((h) => h.ok), used24h: st.usedToday, cap: st.dailyCap, pausedUntil: backoffUntil(site.id) > now ? backoffUntil(site.id) : null },
		bing: { linked: !!linksFor(site.id).bing, daily: q?.daily ?? null, monthly: q?.monthly ?? null, checkedAt: q?.at ?? null },
		googleIndexingApi: { enabled: indexingApiEnabled(), usedToday: indexingApiUsed(site.id, now), cap: indexingApiDailyCap() },
		// Each live inspection stores a row, so rows stored today are this app's use of the quota. Google's limit is about 2,000 a day per property (as the app assumes elsewhere; verify).
		urlInspection: { storedToday: (db().prepare('SELECT COUNT(*) n FROM url_inspections WHERE site_id = ? AND fetched_at >= ?').get(site.id, dayStart) as { n: number }).n, approxDailyLimit: 2000, monitorPerRun: config.indexMonitorUrls, rechecksPerRun: recheckPerRun() },
		queue: queueStatus(site.id, now)
	};
}

// ── CSV of the status table ──────────────────────────────────────────────────
const csvCell = (v: string | number) => {
	const s = String(v);
	const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; // spreadsheet formula injection
	return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
export function submissionsCsv(siteId: number, now = Date.now()): string {
	const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : '');
	const lines = [['url', 'submitted_at', 'days_since', 'verdict', 'channels', 'google_state', 'google_coverage', 'last_checked', 'checked_after_submit', 'next_check'].join(',')];
	for (const r of submissionStatus(siteId, 500, now)) {
		lines.push([r.url, iso(r.submittedAt), r.daysSince, r.verdict, r.channels.map((c) => `${c.channel}:${c.ok ? 'accepted' : 'not sent'}`).join('; '), r.google?.state ?? '', r.google?.coverage ?? '', iso(r.google?.checkedAt), r.google ? (r.google.checkedAfterSubmit ? 'yes' : 'no') : '', iso(r.nextCheckAt)].map(csvCell).join(','));
	}
	return lines.join('\r\n');
}

export { indexingApiEnabled };
