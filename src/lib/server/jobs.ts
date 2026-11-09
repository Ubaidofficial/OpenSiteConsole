import { runClarityScan } from './clarityscan';
import { CLARITY_REFRESH_MS } from './clarity';
import { db } from './db';
import { config } from './config';
import { pacificToday } from './dates';
import { syncSite } from './sync';
import { syncAccountSites } from './accounts';
import { syncBing, syncClarity, syncGa4, syncGtm } from './channels';
import type { LinkKind } from './links';
import { cruxIntegration, syncCrux } from './crux';
import { monitorSite } from './indexmon';
import { runSubmissionWork, submissionWorkDue } from './submission';
import { autoBuildDue, runAutoBuild } from './requestindex';
import { listTests, warmTests } from './seotests';
import { ensureGa4TestData } from './ga4tests';
import { runMonthlyReport, runUrgentAlerts, runWeeklyDigest } from './digest';
import { actionsFor } from './actions';
import { getSite } from './clients';
import { importGoogleUpdates, lastUpdatesCheck } from './gupdates';
import { syncSitemapUrls } from './sitemapcov';
import { autoSubmit } from './indexnow';
import { crawlLinks, RECRAWL_MS } from './internallinks';
import { robotsCheckDue, runRobotsCheck } from './robotswatch';
import { aiVisDue, runDue as runAiVis } from './aivis';
import { auditDue, syncAudit } from './openseolink';
import { linksFor as siteLinks } from './links';

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

/** Whether a job with this key is queued or running. */
export const jobPending = (key: string) => active.has(key) || waiting.some((j) => j.key === key);

/** AI visibility for one site now (the Run now button): everything not asked in the last hour, within today's cap. */
export const enqueueAiVis = (siteId: number) => enqueue(`aivis:${siteId}`, () => runAiVis({ siteId, force: true }));
export const aiVisRunning = (siteId: number) => jobPending(`aivis:${siteId}`) || jobPending('aivis');

export function queueDepth() {
	return { waiting: waiting.length, active: active.size };
}

export function enqueueSiteSync(siteId: number, mode: 'incremental' | 'auto' = 'auto'): boolean {
	const queued = enqueue(`site:${siteId}`, async () => {
		const r = await syncSite(siteId, { mode });
		// Keep walking back through history without waiting for the next scheduler tick.
		// Deferred: while this job runs its own key is still active, so re-queueing now would be dropped as a duplicate.
		if (mode === 'auto' && !r.backfillDone) setTimeout(() => enqueueSiteSync(siteId, 'auto'), 0);
		// Tests are only worth computing once the history they compare against is complete.
		else {
			warmTests(siteId);
			try {
				const s = getSite(siteId);
				if (s) actionsFor(s);
			} catch {
				/* computed on first view instead */
			}
		}
		return r;
	});
	if (queued) db().prepare("UPDATE sites SET sync_status = 'queued' WHERE id = ? AND sync_status != 'running'").run(siteId);
	return queued;
}

/** Load the daily GA4 landing-page data a site's SEO tests need, then recompute the tests. */
export function enqueueGa4Pages(siteId: number): boolean {
	return enqueue(`ga4pages:${siteId}`, async () => {
		await ensureGa4TestData(siteId, listTests(siteId));
		warmTests(siteId);
	});
}

export function enqueueLinkSync(siteId: number, kind: Exclude<LinkKind, 'openseo'>): boolean {
	// After GA4 itself has synced, refresh the per-page data the tests use (a no-op for a site with no tests).
	const syncGa4AndPages = async (id: number) => {
		const r = await syncGa4(id);
		await ensureGa4TestData(id, listTests(id));
		warmTests(id);
		return r;
	};
	// After a Tag Manager or Clarity sync, look at the pages again: a tag may have been added, or a token just connected.
	const thenScan = (f: (id: number) => Promise<unknown>) => async (id: number) => {
		const r = await f(id);
		if (!process.env.VITEST) await runClarityScan(id).catch(() => {});
		return r;
	};
	const run = kind === 'bing' ? syncBing : kind === 'ga4' ? syncGa4AndPages : kind === 'gtm' ? thenScan(syncGtm) : thenScan(syncClarity);
	const queued = enqueue(`${kind}:${siteId}`, () => (run as (id: number) => Promise<unknown>)(siteId));
	if (queued) db().prepare("UPDATE site_links SET sync_status = 'queued' WHERE site_id = ? AND kind = ? AND sync_status != 'running'").run(siteId, kind);
	return queued;
}

/** Is Clarity's script on the site's pages? Fetches three pages; run daily, and after Clarity or Tag Manager changes. */
export function enqueueClarityScan(siteId: number): boolean {
	return enqueue(`clarityscan:${siteId}`, () => runClarityScan(siteId));
}

/** Core Web Vitals snapshot for one site (CrUX data changes daily, so at most once a day). */
export function enqueueCruxSync(siteId: number): boolean {
	return enqueue(`crux:${siteId}`, () => syncCrux(siteId));
}

/** Indexing monitor for one site: inspects its top URLs and records changes. Opt-in per site, since it spends URL Inspection quota. */
export function enqueueIndexMonitor(siteId: number): boolean {
	return enqueue(`index:${siteId}`, () => monitorSite(siteId));
}

/** Send what the submission queue may release now and run the re-checks that are due (day 1, 3 and 5 after a URL was accepted). */
export function enqueueSubmissionWork(siteId: number): boolean {
	return enqueue(`submitwork:${siteId}`, async () => {
		const site = getSite(siteId);
		if (site) await runSubmissionWork(site);
	});
}

/** Read a site's submitted sitemaps (a few HTTP requests): daily, or after 6 h if the last attempt had a problem. */
export function enqueueSitemapSync(siteId: number): boolean {
	return enqueue(`sitemap:${siteId}`, async () => {
		const r = await syncSitemapUrls(siteId);
		// New and changed URLs go to IndexNow if the site has switched that on (a no-op otherwise).
		const site = getSite(siteId);
		if (site) await autoSubmit(site, r.changes).catch(() => {});
		return r;
	});
}

/** Crawl the site's pages for the internal-link suggestions (up to LINK_CRAWL_PAGES, four at a time): weekly, or when asked. */
export function enqueueLinkCrawl(siteId: number): boolean {
	const queued = enqueue(`links:${siteId}`, () => crawlLinks(siteId));
	// Shown as running from the moment it is queued, so the Internal links tab polls until it has finished.
	if (queued) db().prepare("INSERT INTO link_crawls (site_id, status, started_at) VALUES (?, 'running', ?) ON CONFLICT(site_id) DO UPDATE SET status = 'running', started_at = excluded.started_at").run(siteId, Date.now());
	return queued;
}

const SIX_HOURS = 6 * 3600_000;
const REFRESH_MS: Record<string, number> = { bing: 12 * 3600_000, ga4: SIX_HOURS, gtm: 12 * 3600_000, clarity: CLARITY_REFRESH_MS };

/** Whether the indexing monitor should run for a site now: switched on, not yet done today, and not in a back-off after a failure. */
export const monitorDue = (row: { m: number; c: string | null; n: number | null }, today: string, now = Date.now()) => !!row.m && row.c !== today && (!row.n || row.n <= now);

export function schedulerTick() {
	const d = db();
	// The weekly digest (made once per week, catching up if the server was off on the day) and urgent alerts (every few hours).
	if (!process.env.VITEST) {
		enqueue('digest', async () => {
			await runWeeklyDigest();
			await runMonthlyReport();
			const last = Number((d.prepare("SELECT value FROM kv WHERE key = 'urgent_checked'").get() as { value: string } | undefined)?.value ?? 0);
			if (Date.now() - last > 3 * 3600_000) {
				await runUrgentAlerts();
				d.prepare("INSERT OR REPLACE INTO kv (key, value) VALUES ('urgent_checked', ?)").run(String(Date.now()));
			}
		});
	}
	// AI visibility: prompts due for another answer, one at a time, within the daily cap (they cost money on the owner's API accounts).
	if (!process.env.VITEST && aiVisDue()) enqueue('aivis', () => runAiVis());
	// Google's list of ranking updates changes a few times a year: a daily look is plenty, and a failure just waits for tomorrow.
	if (!process.env.VITEST && Date.now() - (lastUpdatesCheck() ?? 0) > 20 * 3600_000) void importGoogleUpdates();
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
		const sm = d.prepare('SELECT fetched_at f, error e FROM sitemap_sync WHERE site_id = ?').get(s.id) as { f: number; e: string | null } | undefined;
		if (!sm || Date.now() - sm.f > (sm.e ? SIX_HOURS : 24 * 3600_000)) enqueueSitemapSync(s.id);
		const row = d.prepare('SELECT index_monitor m, index_checked_on c, index_next_at n FROM sites WHERE id = ?').get(s.id) as { m: number; c: string | null; n: number | null };
		// `n` is a back-off set after a refusal or a total failure, so a broken connection is not hammered every tick.
		if (monitorDue(row, today)) enqueueIndexMonitor(s.id);
		if (submissionWorkDue(s.id)) enqueueSubmissionWork(s.id);
		// The Request tab's list, built each morning for sites that asked for it (inspection quota is spent, so it is opt-in). It only prepares the list; pressing Request indexing stays a click.
		if (!process.env.VITEST && autoBuildDue(s.id, today)) enqueue(`reqauto:${s.id}`, async () => { const site = getSite(s.id); if (site) await runAutoBuild(site); });
		// The Clarity check fetches the site's own pages, so it stays out of the test run.
		if (!process.env.VITEST) {
			const cs = d.prepare('SELECT checked_at FROM clarity_scans WHERE site_id = ?').get(s.id) as { checked_at: number } | undefined;
			if (!cs || Date.now() - cs.checked_at > 24 * 3600_000) enqueueClarityScan(s.id);
			// OpenSEO's latest site audit, read once a day for a linked site (free: it reads OpenSEO's stored results, it runs no audit).
			if (siteLinks(s.id).openseo && auditDue(s.id)) enqueue(`oseo-audit:${s.id}`, () => syncAudit(s.id));
			// robots.txt once a day per host: a rule that blocks pages with clicks is then caught the next day.
			if (robotsCheckDue(s.id)) enqueue(`robots:${s.id}`, () => runRobotsCheck(s.id));
			// The internal-link crawl fetches up to LINK_CRAWL_PAGES of the site's pages: once a week (a site with no data yet is retried).
			const lc = d.prepare('SELECT finished_at f, pages n FROM link_crawls WHERE site_id = ?').get(s.id) as { f: number | null; n: number } | undefined;
			if (!lc || !lc.n || Date.now() - (lc.f ?? 0) > RECRAWL_MS) enqueueLinkCrawl(s.id);
		}
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
	db().prepare("UPDATE link_crawls SET status = 'idle' WHERE status = 'running'").run();
	setTimeout(schedulerTick, 3000);
	globalThis.__openSiteConsoleScheduler = setInterval(() => {
		schedulerTick();
		if (new Date().getUTCHours() === 3) void refreshAllAccountSites();
	}, 15 * 60_000);
	globalThis.__openSiteConsoleScheduler.unref?.();
}
