import { randomBytes } from 'node:crypto';
import { db } from './db';
import { env } from './config';
import type { SiteRow } from './clients';
import { fetchBytes, hostAllowed } from './onpage';
import { explainStatus, groupByHost, isValidKey, MAX_URLS_PER_POST, type SitemapChanges } from '../indexnow';
import { urlClassesReport } from './insights';
import { summary, periodFor } from './queries';

export const endpoint = () => env('INDEXNOW_ENDPOINT', 'https://api.indexnow.org/indexnow');
const dailyCap = () => Math.max(1, Math.min(100_000, Number(env('INDEXNOW_MAX_PER_DAY', '1000')) || 1000));
const COOLDOWN_MS = 24 * 3600_000;
const BACKOFF_MS = 3600_000;
const DAY_MS = 24 * 3600_000;

export interface KeyRow { key: string; created_at: number; auto: number }
export const getKey = (siteId: number) => db().prepare('SELECT key, created_at, auto FROM indexnow_keys WHERE site_id = ?').get(siteId) as KeyRow | undefined;

/** A fresh random key (32 hex characters), stored for the site. Existing host verifications no longer apply to a new key. */
export function createKey(siteId: number): string {
	const key = randomBytes(16).toString('hex');
	const d = db();
	d.transaction(() => {
		const auto = getKey(siteId)?.auto ?? 0;
		d.prepare('INSERT OR REPLACE INTO indexnow_keys (site_id, key, created_at, auto) VALUES (?,?,?,?)').run(siteId, key, Date.now(), auto);
		d.prepare('DELETE FROM indexnow_hosts WHERE site_id = ?').run(siteId);
	})();
	return key;
}
export const setAuto = (siteId: number, on: boolean) => void db().prepare('UPDATE indexnow_keys SET auto = ? WHERE site_id = ?').run(on ? 1 : 0, siteId);

/** Hosts this site's URLs live on: the hosts of its sitemap URLs and of its biggest pages, plus the property's own host. */
export function candidateHosts(site: SiteRow): string[] {
	const d = db();
	const hosts = new Map<string, number>();
	const add = (u: string, w: number) => { try { const h = new URL(u).hostname.toLowerCase(); hosts.set(h, (hosts.get(h) ?? 0) + w); } catch { /* skip */ } };
	for (const r of d.prepare('SELECT page, SUM(clicks) c FROM sa_rows WHERE site_id = ? GROUP BY page ORDER BY c DESC LIMIT 300').all(site.id) as { page: string; c: number }[]) add(r.page, r.c + 1);
	for (const r of d.prepare('SELECT url FROM sitemap_urls WHERE site_id = ? LIMIT 2000').all(site.id) as { url: string }[]) add(r.url, 1);
	if (!hosts.size) {
		const bare = site.site_url.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
		if (bare) hosts.set(bare, 1);
	}
	return [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([h]) => h).filter((h) => hostAllowed(`https://${h}/`, site.site_url));
}

export interface HostStatus { host: string; ok: boolean; message: string | null; verifiedAt: number | null }
export const hostStatuses = (site: SiteRow): HostStatus[] => {
	const rows = new Map((db().prepare('SELECT host, ok, message, verified_at FROM indexnow_hosts WHERE site_id = ?').all(site.id) as { host: string; ok: number; message: string | null; verified_at: number }[]).map((r) => [r.host, r]));
	return candidateHosts(site).map((host) => ({ host, ok: !!rows.get(host)?.ok, message: rows.get(host)?.message ?? null, verifiedAt: rows.get(host)?.verified_at ?? null }));
};

/**
 * Fetch https://<host>/<key>.txt the way a search engine will (same hardened fetch as everything else here: this site's own host
 * only, redirects checked, size capped) and check it holds the key. Without this file every submission is answered 403.
 */
export async function verifyHost(site: SiteRow, host: string, fetchImpl?: typeof fetch): Promise<HostStatus> {
	const k = getKey(site.id);
	const save = (ok: boolean, message: string) => {
		db().prepare('INSERT OR REPLACE INTO indexnow_hosts (site_id, host, verified_at, ok, message) VALUES (?,?,?,?,?)').run(site.id, host, Date.now(), ok ? 1 : 0, message);
		return { host, ok, message, verifiedAt: Date.now() };
	};
	if (!k) return save(false, 'Create a key first.');
	if (!hostAllowed(`https://${host}/`, site.site_url)) return save(false, 'That host is not part of this site.');
	const url = `https://${host}/${k.key}.txt`;
	const r = await fetchBytes(url, site.site_url, { fetchImpl, max: 4096, accept: 'text/plain,*/*' });
	if (!r.body) return save(false, r.status === 404 ? `Not found at ${url}. Upload the key file to the root of ${host}.` : `Could not read ${url}: ${r.error ?? 'unknown problem'}`);
	const text = r.body.toString('utf8').replace(/^﻿/, '').trim();
	if (text !== k.key) return save(false, `A file exists at ${url} but it does not contain the key${/<html/i.test(text) ? ' (it looks like a web page, not the key file)' : ''}.`);
	return save(true, `Found at ${url}.`);
}

export interface Batch { host: string; urls: number; status: number; ok: boolean; message: string }
export interface SubmitResult { accepted: number; skipped: { reason: string; count: number }[]; batches: Batch[]; error: string | null }

const used24h = (siteId: number, now: number) => (db().prepare('SELECT COALESCE(SUM(urls), 0) n FROM indexnow_log WHERE site_id = ? AND at >= ? AND status IN (200, 202)').get(siteId, now - DAY_MS) as { n: number }).n;
const backoffKey = (siteId: number) => `indexnow_backoff:${siteId}`;
export const backoffUntil = (siteId: number) => Number((db().prepare('SELECT value FROM kv WHERE key = ?').get(backoffKey(siteId)) as { value: string } | undefined)?.value ?? 0);

/**
 * Tell the IndexNow engines about URLs that were added, changed or removed. Safeguards, because the protocol warns against
 * spam: only URLs on this site, only hosts whose key file has been verified, a URL is not resent within 24 hours (unless forced),
 * a per-site daily cap (INDEXNOW_MAX_PER_DAY, default 1,000), at most 10,000 URLs a request, and after a 429 nothing is sent for
 * an hour. "Accepted" means the engines received the list. It does not mean the pages are indexed, and Google is not one of them.
 */
export async function submitUrls(site: SiteRow, urls: string[], o: { source?: 'manual' | 'auto'; force?: boolean; fetchImpl?: typeof fetch; now?: number } = {}): Promise<SubmitResult> {
	const { source = 'manual', force = false, fetchImpl = fetch, now = Date.now() } = o;
	const d = db();
	const res: SubmitResult = { accepted: 0, skipped: [], batches: [], error: null };
	const skip = (reason: string, count: number) => void (count && res.skipped.push({ reason, count }));
	const k = getKey(site.id);
	if (!k || !isValidKey(k.key)) return { ...res, error: 'Create a key first.' };
	let ep: URL;
	try {
		ep = new URL(endpoint());
		if (ep.protocol !== 'https:') throw new Error('https');
	} catch {
		return { ...res, error: 'INDEXNOW_ENDPOINT must be an https URL.' };
	}
	if (backoffUntil(site.id) > now) return { ...res, error: `The engines asked us to slow down; nothing is sent until ${new Date(backoffUntil(site.id)).toLocaleTimeString()}.` };
	const { byHost, invalid } = groupByHost(urls);
	skip('not a valid web address', invalid.length);
	const verified = new Set((d.prepare('SELECT host FROM indexnow_hosts WHERE site_id = ? AND ok = 1').all(site.id) as { host: string }[]).map((r) => r.host));
	const last = d.prepare('SELECT submitted_at s FROM indexnow_urls WHERE site_id = ? AND url = ?');
	let budget = dailyCap() - used24h(site.id, now);
	for (const [host, list] of byHost) {
		if (!hostAllowed(`https://${host}/`, site.site_url)) { skip(`not on this site (${host})`, list.length); continue; }
		if (!verified.has(host)) { skip(`key file not verified on ${host}`, list.length); continue; }
		let todo = list;
		if (!force) {
			const fresh = todo.filter((u) => ((last.get(site.id, u) as { s: number } | undefined)?.s ?? 0) < now - COOLDOWN_MS);
			skip('already sent in the last 24 hours', todo.length - fresh.length);
			todo = fresh;
		}
		if (todo.length > budget) { skip('over the daily limit', todo.length - Math.max(0, budget)); todo = todo.slice(0, Math.max(0, budget)); }
		for (let i = 0; i < todo.length; i += MAX_URLS_PER_POST) {
			const part = todo.slice(i, i + MAX_URLS_PER_POST);
			let status = 0;
			try {
				const r = await fetchImpl(ep, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ host, key: k.key, urlList: part }) });
				status = r.status;
				void r.body?.cancel().catch(() => {});
			} catch {
				status = 0;
			}
			const e = explainStatus(status);
			res.batches.push({ host, urls: part.length, status, ok: e.ok, message: e.message });
			d.prepare('INSERT INTO indexnow_log (site_id, at, host, urls, status, message, source) VALUES (?,?,?,?,?,?,?)').run(site.id, now, host, part.length, status, e.message, source);
			if (e.ok) {
				res.accepted += part.length;
				budget -= part.length;
				const mark = d.prepare('INSERT OR REPLACE INTO indexnow_urls (site_id, url, submitted_at) VALUES (?,?,?)');
				d.transaction(() => { for (const u of part) mark.run(site.id, u, now); })();
			} else if (status === 429) {
				d.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(backoffKey(site.id), String(now + BACKOFF_MS));
				res.error = e.message;
				return res;
			} else {
				res.error = res.error ?? e.message;
				break; // a rejected batch (bad key, wrong host) would be rejected again: do not keep hammering
			}
		}
	}
	return res;
}

const CAP_PER_AUTO_RUN = 1000;
/** Submit the URLs a sitemap read found new or changed, if the site has automatic submission on. A no-op otherwise. */
export async function autoSubmit(site: SiteRow, changes: SitemapChanges | null, fetchImpl?: typeof fetch): Promise<SubmitResult | null> {
	const k = getKey(site.id);
	if (!k?.auto || !changes) return null;
	const urls = [...changes.added, ...changes.updated].slice(0, CAP_PER_AUTO_RUN);
	if (!urls.length) return null;
	return submitUrls(site, urls, { source: 'auto', fetchImpl });
}

/** Sitemap URLs whose date is within the last `days` days: a quick "tell them what I have been publishing". */
export function recentSitemapUrls(siteId: number, today: string, days = 7, limit = 1000): string[] {
	const from = new Date(Date.parse(today + 'T00:00:00Z') - days * 86_400_000).toISOString().slice(0, 10);
	return (db().prepare('SELECT url FROM sitemap_urls WHERE site_id = ? AND lastmod >= ? ORDER BY lastmod DESC LIMIT ?').all(siteId, from, limit) as { url: string }[]).map((r) => r.url);
}
/** Pages the monitor has seen go to a 404 or that lost all visibility: IndexNow wants removed pages reported too. */
export function removedUrls(site: SiteRow, days = 28): string[] {
	return urlClassesReport(site, days).rows.filter((r) => r.cls === 'dead' && r.fetchState === 'NOT_FOUND').map((r) => r.page).slice(0, 500);
}

export function indexNowStatus(site: SiteRow, now = Date.now()) {
	const d = db();
	const k = getKey(site.id);
	const p = periodFor(site, 28);
	const google = summary(site.id, p.start, p.end).clicks;
	const linked = !!d.prepare("SELECT 1 FROM site_links WHERE site_id = ? AND kind = 'bing'").get(site.id);
	const bing = linked ? ((d.prepare('SELECT SUM(clicks) c FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, p.start, p.end) as { c: number | null }).c ?? 0) : null;
	return {
		hasKey: !!k,
		key: k?.key ?? null,
		auto: !!k?.auto,
		hosts: hostStatuses(site),
		usedToday: used24h(site.id, now),
		dailyCap: dailyCap(),
		backoffUntil: backoffUntil(site.id) > now ? backoffUntil(site.id) : null,
		recent: d.prepare('SELECT at, host, urls, status, message, source FROM indexnow_log WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT 20').all(site.id) as { at: number; host: string; urls: number; status: number; message: string | null; source: string }[],
		clicks28d: { google, bing, bingShare: bing != null && google + bing > 0 ? bing / (google + bing) : null }
	};
}
