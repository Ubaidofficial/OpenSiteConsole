import { db } from './db';
import { config } from './config';
import { RealBingClient, type BingClient } from './bing';
import { DemoBing, DEMO_GA4_PROPERTIES, demoClarityFetch, demoGa4Daily } from './demo-channels';
import { callsLeft, CLARITY_SYNC_DIMENSIONS, fetchInsights, utcDay } from './clarity';
import * as ga4 from './ga4';
import { addDays, pacificToday, retentionHorizon } from './dates';
import { getIntegration, integrationSecret, linksFor, markLink } from './links';
import { getSite } from './clients';

// ── factories (real vs demo) ─────────────────────────────────────────────────
export function bingClientFor(integrationId: number): BingClient {
	const i = getIntegration(integrationId);
	if (!i) throw new Error('Unknown Bing connection');
	return i.is_demo ? new DemoBing() : new RealBingClient(integrationId);
}

export interface Ga4Source {
	listProperties(): Promise<ga4.Ga4Property[]>;
	streamUrls(property: string): Promise<string[]>;
	daily(property: string, start: string, end: string): Promise<ga4.Ga4Day[]>;
}

export function ga4SourceFor(accountId: number): Ga4Source {
	const a = db().prepare('SELECT google_sub, is_demo FROM accounts WHERE id = ?').get(accountId) as { google_sub: string; is_demo: number } | undefined;
	if (!a) throw new Error('Unknown Google account');
	if (a.is_demo) {
		const props = DEMO_GA4_PROPERTIES(a.google_sub);
		return {
			listProperties: async () => props.map((p) => p.prop),
			streamUrls: async (property) => props.filter((p) => p.prop.property === property).map((p) => p.url),
			daily: async (property, s, e) => demoGa4Daily(property, s, e)
		};
	}
	return {
		listProperties: () => ga4.listProperties(accountId),
		streamUrls: (p) => ga4.webStreamUrls(accountId, p),
		daily: (p, s, e) => ga4.dailyByChannel(accountId, p, s, e)
	};
}

// ── sync: Bing ───────────────────────────────────────────────────────────────
export async function syncBing(siteId: number, client?: BingClient) {
	const link = linksFor(siteId).bing;
	if (!link?.integration_id) throw new Error('Site is not linked to Bing');
	markLink(siteId, 'bing', 'running');
	try {
		const c = client ?? bingClientFor(link.integration_id);
		const [daily, queries, pages] = await Promise.all([c.dailyStats(link.external_id), c.queryStats(link.external_id), c.pageStats(link.external_id)]);
		const d = db();
		d.transaction(() => {
			d.prepare('DELETE FROM bing_daily WHERE site_id = ?').run(siteId);
			d.prepare('DELETE FROM bing_terms WHERE site_id = ?').run(siteId);
			const insDay = d.prepare('INSERT OR REPLACE INTO bing_daily VALUES (?,?,?,?)');
			for (const r of daily) insDay.run(siteId, r.date, r.clicks, r.impressions);
			const insTerm = d.prepare('INSERT OR REPLACE INTO bing_terms VALUES (?,?,?,?,?,?,?,?)');
			for (const [kind, rows] of [['query', queries], ['page', pages]] as const) for (const r of rows) insTerm.run(siteId, kind, r.date, r.term, r.clicks, r.impressions, r.clickPos, r.imprPos);
		})();
		markLink(siteId, 'bing', 'idle', null, true);
		return { days: daily.length, queries: queries.length, pages: pages.length };
	} catch (e) {
		markLink(siteId, 'bing', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

// ── sync: GA4 ────────────────────────────────────────────────────────────────
export async function syncGa4(siteId: number, source?: Ga4Source, today = pacificToday()) {
	const link = linksFor(siteId).ga4;
	if (!link?.account_id) throw new Error('Site is not linked to a GA4 property');
	markLink(siteId, 'ga4', 'running');
	try {
		const src = source ?? ga4SourceFor(link.account_id);
		const have = (db().prepare('SELECT COUNT(*) n FROM ga4_daily WHERE site_id = ?').get(siteId) as { n: number }).n > 0;
		// GA4 reprocesses recent days, so re-pull the last 10 after the initial backfill.
		const start = have ? addDays(today, -10) : retentionHorizon(today);
		const rows = await src.daily(link.external_id, start, today);
		const d = db();
		d.transaction(() => {
			d.prepare('DELETE FROM ga4_daily WHERE site_id = ? AND date >= ?').run(siteId, start);
			const ins = d.prepare('INSERT OR REPLACE INTO ga4_daily VALUES (?,?,?,?,?,?,?,?)');
			for (const r of rows) ins.run(siteId, r.date, r.channel, r.sessions, r.engagedSessions, r.users, r.keyEvents, r.pageviews);
		})();
		markLink(siteId, 'ga4', 'idle', null, true);
		return { rows: rows.length };
	} catch (e) {
		markLink(siteId, 'ga4', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

// ── sync: Clarity (10 calls/day/project: store a snapshot per day) ───────────
export async function syncClarity(siteId: number, o: { force?: boolean; fetchImpl?: typeof fetch } = {}) {
	const link = linksFor(siteId).clarity;
	if (!link?.integration_id) throw new Error('Site is not linked to Clarity');
	const integ = getIntegration(link.integration_id)!;
	const token = integrationSecret<{ token: string }>(integ).token;
	const fetchImpl = o.fetchImpl ?? (integ.is_demo ? demoClarityFetch() : fetch);
	markLink(siteId, 'clarity', 'running');
	try {
		const day = utcDay();
		let calls = 0;
		for (const dim of CLARITY_SYNC_DIMENSIONS) {
			const have = db().prepare('SELECT 1 FROM clarity_snapshots WHERE site_id = ? AND day = ? AND dimension = ?').get(siteId, day, dim);
			if (have && !o.force) continue;
			if (callsLeft(integ.id) <= 1) break; // always leave one call for the user
			const payload = await fetchInsights(integ.id, token, { numOfDays: 1, dimension: dim }, fetchImpl);
			db().prepare('INSERT OR REPLACE INTO clarity_snapshots VALUES (?,?,?,?,?)').run(siteId, day, dim, JSON.stringify(payload), Date.now());
			calls++;
		}
		markLink(siteId, 'clarity', 'idle', null, true);
		return { calls };
	} catch (e) {
		markLink(siteId, 'clarity', 'error', e instanceof Error ? e.message : String(e));
		throw e;
	}
}

export const siteName = (id: number) => getSite(id)?.site_url ?? String(id);
export const demoMode = () => config.demo;
