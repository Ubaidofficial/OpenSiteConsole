/**
 * Working with OpenSEO (github.com/every-app/open-seo), beyond linking projects: search volume for the site's own Search Console queries,
 * striking-distance searches sent to an OpenSEO rank tracker, and OpenSEO's latest site audit joined with the pages that earn clicks.
 *
 * Everything goes through OpenSEO's MCP server with the API key saved on the Connect page. The tool names and shapes used here
 * (get_keyword_metrics, get_rank_tracker, create_rank_tracker, estimate_rank_tracker_cost, add_rank_tracking_keywords,
 * get_audit_issues) were read from OpenSEO's source code on 2026-11-08, tested against a fake built from it, and checked against a live
 * self-hosted instance the same day (tool schemas, and the answers of list_projects, get_rank_tracker, estimate_rank_tracker_cost,
 * get_audit_issues and get_keyword_metrics). Keyword metrics spend OpenSEO credits (paid to DataForSEO on a self-hosted OpenSEO);
 * adding keywords to a tracker spends none by itself (its checks do); reading an audit and estimating a tracker's cost are free.
 */
import { db, audit } from './db';
import { getSite, type SiteRow } from './clients';
import { getIntegration, integrationMeta, integrationSecret, linksFor } from './links';
import { mcpSession, OpenSeoError } from './openseo';
import { hostKey } from './hosts';
import { brandTerms, fittedCurve, periodFor, queryPageRows, topQueries } from './queries';
import { computeStriking, isBranded, normalizeUrl } from '../analytics';
import { demoOpenSeoApi } from './demo-channels';

export interface OseoApi { callTool(name: string, args: Record<string, unknown>): Promise<unknown> }
export interface OseoLink { projectId: string; projectName: string | null; baseUrl: string; demo: boolean; api: () => Promise<OseoApi> }

/** OpenSEO for a site, when it is linked to a project; null otherwise. */
export function openSeoFor(siteId: number, o: { api?: OseoApi } = {}): OseoLink | null {
	const link = linksFor(siteId).openseo;
	if (!link?.integration_id) return null;
	const i = getIntegration(link.integration_id);
	if (!i) return null;
	const baseUrl = integrationMeta(i).baseUrl ?? '';
	const demo = !!i.is_demo;
	const api = async (): Promise<OseoApi> => {
		if (o.api) return o.api;
		if (demo) return demoOpenSeoApi(siteId);
		return mcpSession(baseUrl, integrationSecret<{ apiKey: string }>(i).apiKey);
	};
	return { projectId: link.external_id, projectName: link.label, baseUrl, demo, api };
}

const message = (e: unknown) => (e instanceof OpenSeoError || e instanceof Error ? e.message : 'OpenSEO failed.');

// ── 1. Search volume for the site's own queries ──────────────────────────────
/** OpenSEO's limits for get_keyword_metrics: 700 keywords a call, 80 characters each. */
export const VOLUME_BATCH = 700;
const MAX_KEYWORD_CHARS = 80;
/** A query's volume is kept this long before it is asked for again. */
export const VOLUME_TTL_DAYS = 30;

export interface KeywordVolume { keyword: string; volume: number | null; kd: number | null; cpc: number | null; intent: string | null; fetchedAt: number }

/** The site's queries worth a volume: most impressions over 28 days, not asked for recently, short enough for OpenSEO. */
export function volumeCandidates(site: SiteRow, limit = VOLUME_BATCH, now = Date.now()): string[] {
	const p = periodFor(site, 28);
	const fresh = new Set((db().prepare('SELECT keyword FROM oseo_volumes WHERE site_id = ? AND fetched_at > ?').all(site.id, now - VOLUME_TTL_DAYS * 86_400_000) as { keyword: string }[]).map((r) => r.keyword));
	return topQueries(site.id, p.start, p.end, {}, 20_000)
		.sort((a, b) => b.impressions - a.impressions)
		.map((r) => r.query.trim().toLowerCase())
		.filter((q) => q && q.length <= MAX_KEYWORD_CHARS && !fresh.has(q))
		.filter((q, i, a) => a.indexOf(q) === i)
		.slice(0, limit);
}

/** Ask OpenSEO for the volume of up to 700 queries (spends credits) and keep them; queries it has no data for are kept as unknown. */
export async function fetchVolumes(siteId: number, o: { api?: OseoApi; limit?: number } = {}): Promise<{ asked: number; withVolume: number }> {
	const site = getSite(siteId)!;
	const os = openSeoFor(siteId, o);
	if (!os) throw new Error('This site is not linked to an OpenSEO project (Connect page).');
	const keywords = volumeCandidates(site, Math.min(VOLUME_BATCH, o.limit ?? VOLUME_BATCH));
	if (!keywords.length) return { asked: 0, withVolume: 0 };
	let out: unknown;
	try {
		out = await (await os.api()).callTool('get_keyword_metrics', { projectId: os.projectId, keywords, includeMonthlyTrends: false });
	} catch (e) {
		throw new Error(`OpenSEO: ${message(e)}`);
	}
	const rows = ((out as { keywords?: unknown[] } | null)?.keywords ?? []) as { keyword?: string; search_volume?: number | null; keyword_difficulty?: number | null; cpc?: number | null; main_intent?: string | null }[];
	const now = Date.now();
	const byKw = new Map(rows.filter((r) => typeof r.keyword === 'string').map((r) => [r.keyword!.trim().toLowerCase(), r]));
	const up = db().prepare('INSERT OR REPLACE INTO oseo_volumes (site_id, keyword, volume, kd, cpc, intent, fetched_at) VALUES (?,?,?,?,?,?,?)');
	const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
	db().transaction(() => {
		for (const k of keywords) {
			const r = byKw.get(k);
			up.run(siteId, k, num(r?.search_volume), num(r?.keyword_difficulty), num(r?.cpc), typeof r?.main_intent === 'string' ? r.main_intent : null, now);
		}
	})();
	const withVolume = keywords.filter((k) => num(byKw.get(k)?.search_volume) != null).length;
	audit('openseo.volumes', { siteId, detail: `${keywords.length} asked, ${withVolume} with a volume` });
	return { asked: keywords.length, withVolume };
}

/** Stored volumes by lower-cased query. */
export function volumesFor(siteId: number): Map<string, KeywordVolume> {
	const rows = db().prepare('SELECT keyword, volume, kd, cpc, intent, fetched_at FROM oseo_volumes WHERE site_id = ?').all(siteId) as { keyword: string; volume: number | null; kd: number | null; cpc: number | null; intent: string | null; fetched_at: number }[];
	return new Map(rows.map((r) => [r.keyword, { keyword: r.keyword, volume: r.volume, kd: r.kd, cpc: r.cpc, intent: r.intent, fetchedAt: r.fetched_at }]));
}
export const volumeOf = (m: Map<string, KeywordVolume>, query: string) => m.get(query.trim().toLowerCase()) ?? null;
export const volumesFetchedAt = (siteId: number) => (db().prepare('SELECT MAX(fetched_at) t FROM oseo_volumes WHERE site_id = ?').get(siteId) as { t: number | null }).t;

// ── 2. Striking-distance searches to OpenSEO rank tracking ───────────────────
/** OpenSEO limits a tracked keyword to 200 characters. */
const MAX_TRACKED_CHARS = 200;
export const TRACK_MAX = 100;

/** The non-brand searches at positions 4-20 worth tracking, most extra clicks first, without those already sent. */
export function trackCandidates(site: SiteRow, n = 25): { query: string; position: number; impressions: number; expectedGain: number }[] {
	const p = periodFor(site, 28);
	const terms = brandTerms(site);
	const curve = fittedCurve(queryPageRows(site.id, p.start, p.end), terms);
	const sent = new Set((db().prepare('SELECT keyword FROM oseo_tracked WHERE site_id = ?').all(site.id) as { keyword: string }[]).map((r) => r.keyword));
	return computeStriking(topQueries(site.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: 30 })
		.filter((r) => r.query.length <= MAX_TRACKED_CHARS && !sent.has(r.query.toLowerCase()))
		.slice(0, Math.min(TRACK_MAX, n))
		.map((r) => ({ query: r.query, position: r.position, impressions: r.impressions, expectedGain: r.expectedGain }));
}

type TrackerConfig = { id?: string; domain?: string; isActive?: boolean | number; scheduleInterval?: string; devices?: string; locationName?: string | null };
export interface TrackPlan {
	trackerId: string | null;
	/** what happens: an existing tracker gets the keywords, or a new manual one is created first */
	action: 'add' | 'create';
	schedule: string;
	keywords: string[];
	/** OpenSEO's own estimate for one check after adding, and for a scheduled tracker the recurring cost; null for a new manual tracker */
	estimate: { costUsd: number; costCredits: number; scheduled: { interval: string; costCredits: number; monthlyCostUsd: number; monthlyCostCredits: number } | null } | null;
}

async function findTracker(api: OseoApi, projectId: string, domain: string): Promise<TrackerConfig | null> {
	const out = (await api.callTool('get_rank_tracker', { projectId })) as { configs?: TrackerConfig[] } | null;
	const own = (out?.configs ?? []).filter((c) => typeof c.domain === 'string' && hostKey(c.domain) === domain && c.isActive !== false && c.isActive !== 0);
	// A national tracker over a city one: Search Console positions are national.
	return own.find((c) => !c.locationName) ?? own[0] ?? null;
}

/** What sending these searches would do and cost, without changing anything (estimating is free). */
export async function trackPreview(siteId: number, keywords: string[], o: { api?: OseoApi } = {}): Promise<TrackPlan> {
	const site = getSite(siteId)!;
	const os = openSeoFor(siteId, o);
	if (!os) throw new Error('This site is not linked to an OpenSEO project (Connect page).');
	const kws = [...new Set(keywords.map((k) => k.trim()).filter((k) => k && k.length <= MAX_TRACKED_CHARS))].slice(0, TRACK_MAX);
	if (!kws.length) throw new Error('No searches to send.');
	try {
		const api = await os.api();
		const t = await findTracker(api, os.projectId, hostKey(site.site_url));
		if (!t?.id) return { trackerId: null, action: 'create', schedule: 'manual', keywords: kws, estimate: null };
		const e = (await api.callTool('estimate_rank_tracker_cost', { projectId: os.projectId, trackerId: t.id, additionalKeywords: kws })) as { costUsd?: number; costCredits?: number; scheduledEstimate?: { scheduleInterval: string; costCredits: number; monthlyCostUsd: number; monthlyCostCredits: number } } | null;
		const s = e?.scheduledEstimate;
		return {
			trackerId: t.id, action: 'add', schedule: t.scheduleInterval ?? 'manual', keywords: kws,
			estimate: { costUsd: e?.costUsd ?? 0, costCredits: e?.costCredits ?? 0, scheduled: s ? { interval: s.scheduleInterval, costCredits: s.costCredits, monthlyCostUsd: s.monthlyCostUsd, monthlyCostCredits: s.monthlyCostCredits } : null }
		};
	} catch (e) {
		throw new Error(`OpenSEO: ${message(e)}`);
	}
}

/**
 * Send the searches. For a scheduled tracker, OpenSEO requires the per-check credit ceiling the user approved after seeing the
 * estimate; `approvedCredits` is exactly the figure the preview showed, and OpenSEO refuses if the real cost would be higher. A
 * missing tracker is created as a manual one (no recurring spend; positions appear when a check is run in OpenSEO).
 */
export async function trackSend(siteId: number, keywords: string[], approvedCredits: number | null, o: { api?: OseoApi } = {}): Promise<{ added: number; requested: number; trackerId: string; created: boolean }> {
	const site = getSite(siteId)!;
	const os = openSeoFor(siteId, o);
	if (!os) throw new Error('This site is not linked to an OpenSEO project (Connect page).');
	const kws = [...new Set(keywords.map((k) => k.trim()).filter((k) => k && k.length <= MAX_TRACKED_CHARS))].slice(0, TRACK_MAX);
	if (!kws.length) throw new Error('No searches to send.');
	try {
		const api = await os.api();
		let t = await findTracker(api, os.projectId, hostKey(site.site_url));
		let created = false;
		if (!t?.id) {
			const c = (await api.callTool('create_rank_tracker', { projectId: os.projectId, domain: hostKey(site.site_url), scheduleInterval: 'manual' })) as { trackerId?: string } | null;
			if (!c?.trackerId) throw new Error('OpenSEO did not return a tracker.');
			t = { id: c.trackerId, scheduleInterval: 'manual' };
			created = true;
		}
		const scheduled = t.scheduleInterval && t.scheduleInterval !== 'manual';
		if (scheduled && !(approvedCredits && approvedCredits > 0)) throw new Error('This tracker runs on a schedule: preview the cost first, then send.');
		const r = (await api.callTool('add_rank_tracking_keywords', { projectId: os.projectId, trackerId: t.id, keywords: kws, ...(scheduled ? { maxEstimatedScheduledCheckCredits: Math.round(approvedCredits!) } : {}) })) as { added?: number; addedIds?: string[] } | null;
		const ins = db().prepare('INSERT OR REPLACE INTO oseo_tracked (site_id, keyword, tracker_id, added_at) VALUES (?,?,?,?)');
		db().transaction(() => { for (const k of kws) ins.run(siteId, k.toLowerCase(), t!.id, Date.now()); })();
		audit('openseo.track', { siteId, detail: `${r?.added ?? 0} of ${kws.length} added to tracker ${t.id}${created ? ' (new, manual)' : ''}` });
		return { added: r?.added ?? 0, requested: kws.length, trackerId: t.id!, created };
	} catch (e) {
		throw new Error(`OpenSEO: ${message(e)}`);
	}
}

export const trackedCount = (siteId: number) => (db().prepare('SELECT COUNT(*) n FROM oseo_tracked WHERE site_id = ?').get(siteId) as { n: number }).n;
export const trackerUrl = (os: OseoLink, trackerId: string | null) => `${os.baseUrl}/p/${os.projectId}/rank-tracking${trackerId ? `/${trackerId}` : ''}`;

// ── 3. OpenSEO's site audit, joined with Search Console ─────────────────────
export interface AuditIssue { severity: string; issueType: string; title: string; url: string; howToFix: string | null }
export interface AuditSnapshot { fetchedAt: number; error: string | null; total: number; summary: { issueType: string; title: string; severity: string; count: number }[]; issues: AuditIssue[] }
export const AUDIT_RECHECK_MS = 24 * 3600_000;

/** Read OpenSEO's latest audit for the linked project (free: it reads OpenSEO's stored results) and keep it. Never throws. */
export async function syncAudit(siteId: number, o: { api?: OseoApi } = {}): Promise<AuditSnapshot | null> {
	const os = openSeoFor(siteId, o);
	if (!os) return null;
	let snap: AuditSnapshot;
	try {
		const out = (await (await os.api()).callTool('get_audit_issues', { projectId: os.projectId, limit: 1000 })) as { summary?: AuditSnapshot['summary']; issues?: (AuditIssue & { details?: unknown })[]; total?: number } | null;
		snap = {
			fetchedAt: Date.now(), error: null, total: out?.total ?? 0, summary: out?.summary ?? [],
			issues: (out?.issues ?? []).filter((x) => typeof x.url === 'string').map((x) => ({ severity: x.severity, issueType: x.issueType, title: x.title, url: x.url, howToFix: x.howToFix ?? null }))
		};
	} catch (e) {
		// No audit yet is normal: say so instead of an error.
		const m = message(e);
		snap = { fetchedAt: Date.now(), error: /no (site )?audit|not found/i.test(m) ? null : m, total: 0, summary: [], issues: [] };
	}
	db().prepare('INSERT OR REPLACE INTO oseo_audits (site_id, fetched_at, payload) VALUES (?,?,?)').run(siteId, snap.fetchedAt, JSON.stringify(snap));
	return snap;
}

export function storedAudit(siteId: number): AuditSnapshot | null {
	const r = db().prepare('SELECT payload FROM oseo_audits WHERE site_id = ?').get(siteId) as { payload: string } | undefined;
	return r ? (JSON.parse(r.payload) as AuditSnapshot) : null;
}
export const auditDue = (siteId: number, now = Date.now()) => {
	const r = db().prepare('SELECT fetched_at f FROM oseo_audits WHERE site_id = ?').get(siteId) as { f: number } | undefined;
	return !r || now - r.f > AUDIT_RECHECK_MS;
};

export interface AuditFinding { issueType: string; title: string; severity: string; howToFix: string | null; pages: { url: string; clicks: number }[]; clicks: number; total: number }

/** Each critical or warning issue type, with its pages that earned clicks (most first): what to fix first, in Search Console terms. */
export function auditFindings(snap: AuditSnapshot, clicksByPage: Map<string, number>): AuditFinding[] {
	const groups = new Map<string, AuditFinding>();
	for (const i of snap.issues) {
		if (i.severity !== 'critical' && i.severity !== 'warning') continue;
		const g = groups.get(i.issueType) ?? { issueType: i.issueType, title: i.title, severity: i.severity, howToFix: i.howToFix, pages: [], clicks: 0, total: snap.summary.find((s) => s.issueType === i.issueType)?.count ?? 0 };
		const c = clicksByPage.get(normalizeUrl(i.url)) ?? 0;
		if (c > 0 && !g.pages.some((p) => p.url === i.url)) g.pages.push({ url: i.url, clicks: c });
		groups.set(i.issueType, g);
	}
	for (const g of groups.values()) {
		g.pages.sort((a, b) => b.clicks - a.clicks);
		g.clicks = g.pages.reduce((a, p) => a + p.clicks, 0);
		g.total ||= g.pages.length;
	}
	return [...groups.values()].filter((g) => g.pages.length).sort((a, b) => (a.severity === b.severity ? b.clicks - a.clicks : a.severity === 'critical' ? -1 : 1));
}
