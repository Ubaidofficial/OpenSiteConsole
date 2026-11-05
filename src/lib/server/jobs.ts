import { db } from './db';
import { config } from './config';
import { pacificToday } from './dates';
import { syncSite } from './sync';
import { syncAccountSites } from './accounts';
import { syncBing, syncClarity, syncGa4, syncGtm } from './channels';
import type { LinkKind } from './links';
import { cruxIntegration, syncCrux } from './crux';
import { monitorSite } from './indexmon';

type Job = { key: string; fn: () => Promise<unknown> };
const waiting: Job[] = [];
const active = new Set<string>();

function pump() {
	while (active.size < config.syncConcurrency && waiting.length) {
		const job = waiting.shift()!;
		active.add(job.key);
		job
			.fn()
			.catch(() => {})
			.finally(() => {
				active.delete(job.key);
				pump();
			});
	}
}

/** Run `fn` in the background, at most `syncConcurrency` at once. Duplicate keys are ignored. */
export function enqueue(key: string, fn: () => Promise<unknown>): boolean {
	if (active.has(key) || waiting.some((j) => j.key === key)) return false;
	waiting.push({ key, fn });
	pump();
	return true;
}

export function queueDepth() {
	return { waiting: waiting.length, active: active.size };
}

export function enqueueSiteSync(siteId: number, mode: 'incremental' | 'auto' = 'auto'): boolean {
	const queued = enqueue(`site:${siteId}`, async () => {
		const r = await syncSite(siteId, { mode });
		// Keep walking back through history without waiting for the next scheduler tick.
		// Deferred: while this job runs its own key is still active, so re-queueing now would be dropped as a duplicate.
		if (mode === 'auto' && !r.backfillDone) setTimeout(() => enqueueSiteSync(siteId, 'auto'), 0);
		return r;
	});
	if (queued) db().prepare("UPDATE sites SET sync_status = 'queued' WHERE id = ? AND sync_status != 'running'").run(siteId);
	return queued;
}

export function enqueueLinkSync(siteId: number, kind: Exclude<LinkKind, 'openseo'>): boolean {
	const run = kind === 'bing' ? syncBing : kind === 'ga4' ? syncGa4 : kind === 'gtm' ? syncGtm : syncClarity;
	const queued = enqueue(`${kind}:${siteId}`, () => (run as (id: number) => Promise<unknown>)(siteId));
	if (queued) db().prepare("UPDATE site_links SET sync_status = 'queued' WHERE site_id = ? AND kind = ? AND sync_status != 'running'").run(siteId, kind);
	return queued;
}

/** Core Web Vitals snapshot for one site (CrUX data changes daily, so at most once a day). */
export function enqueueCruxSync(siteId: number): boolean {
	return enqueue(`crux:${siteId}`, () => syncCrux(siteId));
}

/** Indexing monitor for one site: inspects its top URLs and records changes. Opt-in per site, since it spends URL Inspection quota. */
export function enqueueIndexMonitor(siteId: number): boolean {
	return enqueue(`index:${siteId}`, () => monitorSite(siteId));
}

const SIX_HOURS = 6 * 3600_000;
const REFRESH_MS: Record<string, number> = { bing: 12 * 3600_000, ga4: SIX_HOURS, gtm: 12 * 3600_000, clarity: 22 * 3600_000 };

export function schedulerTick() {
	const d = db();
	const sites = d
		.prepare(
			`SELECT s.id, s.backfill_done, s.last_sync_at FROM sites s JOIN accounts a ON a.id = s.account_id
			 WHERE s.hidden = 0 AND a.status = 'active' AND s.permission NOT IN ('siteUnverifiedUser','none')`
		)
		.all() as { id: number; backfill_done: number; last_sync_at: number | null }[];
	for (const s of sites) {
		if (!s.backfill_done) enqueueSiteSync(s.id, 'auto');
		else if (!s.last_sync_at || Date.now() - s.last_sync_at > SIX_HOURS) enqueueSiteSync(s.id, 'incremental');
	}
	if (cruxIntegration()) {
		const today = pacificToday();
		for (const s of sites) if ((d.prepare('SELECT crux_pulled_on p FROM sites WHERE id = ?').get(s.id) as { p: string | null }).p !== today) enqueueCruxSync(s.id);
	}
	const today = pacificToday();
	for (const s of sites) {
		const row = d.prepare('SELECT index_monitor m, index_checked_on c FROM sites WHERE id = ?').get(s.id) as { m: number; c: string | null };
		if (row.m && row.c !== today) enqueueIndexMonitor(s.id);
	}
	const links = d
		.prepare("SELECT l.site_id, l.kind, l.last_sync_at FROM site_links l JOIN sites s ON s.id = l.site_id WHERE s.hidden = 0 AND l.kind IN ('bing','ga4','gtm','clarity')")
		.all() as { site_id: number; kind: 'bing' | 'ga4' | 'gtm' | 'clarity'; last_sync_at: number | null }[];
	for (const l of links) if (!l.last_sync_at || Date.now() - l.last_sync_at > REFRESH_MS[l.kind]) enqueueLinkSync(l.site_id, l.kind);
}

export async function refreshAllAccountSites() {
	const accs = db().prepare("SELECT id FROM accounts WHERE status = 'active'").all() as { id: number }[];
	for (const a of accs) await syncAccountSites(a.id).catch(() => {});
}

declare global {
	// eslint-disable-next-line no-var
	var __openSiteConsoleScheduler: NodeJS.Timeout | undefined;
}

export function startScheduler() {
	if (!config.schedulerEnabled || globalThis.__openSiteConsoleScheduler) return;
	// Anything left "running"/"queued" belongs to a process that no longer exists.
	db().prepare("UPDATE sites SET sync_status = 'idle' WHERE sync_status IN ('running','queued')").run();
	db().prepare("UPDATE site_links SET sync_status = 'idle' WHERE sync_status IN ('running','queued')").run();
	setTimeout(schedulerTick, 3000);
	globalThis.__openSiteConsoleScheduler = setInterval(() => {
		schedulerTick();
		if (new Date().getUTCHours() === 3) void refreshAllAccountSites();
	}, 15 * 60_000);
	globalThis.__openSiteConsoleScheduler.unref?.();
}
