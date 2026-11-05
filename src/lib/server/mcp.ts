import { db } from './db';
import { allSites, brandTerms, fittedCurve, periodFor, queryPageRows, summary, topPages, topQueries, pageTotals, dailySeries, anonymisedShare, typeBreakdown, appearanceFor } from './queries';
import { ALL_TYPES } from '../searchTypes';
import { cruxIntegration, cruxLatest } from './crux';
import { rate, VITALS } from '../vitals';
import { displayName } from './clients';
import { addDays } from './dates';
import { computeCannibalization, computeCtrGaps, computeDecay, computeStriking, ctrOf, detectAnomalies, isBranded, pctChange } from '../analytics';
import { linksFor } from './links';
import { openSeoProjectUrl } from './connect';
import { authenticate } from './apikeys';
import { hostKey } from './hosts';
import { coverageMap } from '../property';
import { gtmSnapshot, trackingHealth } from './tracking';
import { tagTypeLabel } from './gtm';
import { allLinks } from './links';

/** Read-only MCP server (Streamable HTTP, JSON responses). Nothing here writes or spends money. */

type Site = ReturnType<typeof allSites>[number];
interface Tool {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	run: (args: Record<string, unknown>, sites: Site[]) => unknown;
}

const siteArg = { site: { type: 'string', description: 'Site id (from list_sites), domain such as example.com, or property URL' } };
const daysArg = { days: { type: 'integer', enum: [7, 28, 90, 180, 480], description: 'Window length in days (default 28). Compared with the equally long previous window.' } };

function resolveSite(sites: Site[], ref: unknown): Site {
	const s = String(ref ?? '').trim();
	if (!s) throw new Error('`site` is required (use list_sites)');
	const byId = sites.find((x) => String(x.id) === s);
	if (byId) return byId;
	const hits = sites.filter((x) => hostKey(x.site_url) === hostKey(s));
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) throw new Error(`"${s}" matches ${hits.length} properties; use the numeric id: ${hits.map((h) => h.id).join(', ')}`);
	throw new Error(`No accessible site matches "${s}"`);
}

const days = (a: Record<string, unknown>) => ([7, 28, 90, 180, 480].includes(Number(a.days)) ? Number(a.days) : 28);
const limit = (a: Record<string, unknown>, d = 25) => Math.min(200, Math.max(1, Number(a.limit) || d));
const r2 = (n: number) => Math.round(n * 100) / 100;

const TOOLS: Tool[] = [
	{
		name: 'list_sites',
		description: 'Every Search Console property this key can see, with which data sources are connected (bing, ga4, gtm, clarity, openseo) and the newest synced date. Start here.',
		schema: {},
		run: (_a, sites) => {
			const cover = coverageMap(sites);
			return sites.map((s) => {
				const l = linksFor(s.id);
				return { duplicateOfSiteId: cover.get(s.id) ?? null, id: s.id, name: displayName(s.site_url), property: s.site_url, account: s.account_label ?? s.account_email, syncedThrough: s.synced_through, connected: { google: true, bing: !!l.bing, ga4: !!l.ga4, gtm: l.gtm ? { container: l.gtm.label } : false, clarity: !!l.clarity, openseo: l.openseo ? { projectId: l.openseo.external_id, name: l.openseo.label } : false } };
			});
		}
	},
	{
		name: 'get_overview',
		description: 'Clicks/impressions/CTR/position for a window vs the previous window, across Google Search Console, Bing and GA4 organic sessions where connected, plus the share of anonymised queries.',
		schema: { ...siteArg, ...daysArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const p = periodFor(site, days(a));
			const g = summary(site.id, p.start, p.end);
			const gp = summary(site.id, p.prevStart, p.prevEnd);
			const d = db();
			const bing = (s: string, e: string) => d.prepare('SELECT SUM(clicks) c, SUM(impressions) i FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, s, e) as { c: number | null; i: number | null };
			const ga = (s: string, e: string) => d.prepare("SELECT SUM(sessions) s, SUM(key_events) k FROM ga4_daily WHERE site_id = ? AND channel = 'Organic Search' AND date BETWEEN ? AND ?").get(site.id, s, e) as { s: number | null; k: number | null };
			const l = linksFor(site.id);
			const bn = bing(p.start, p.end);
			const bp = bing(p.prevStart, p.prevEnd);
			const gn = ga(p.start, p.end);
			const gpv = ga(p.prevStart, p.prevEnd);
			return {
				site: displayName(site.site_url),
				period: { start: p.start, end: p.end, previous: { start: p.prevStart, end: p.prevEnd } },
				google: { clicks: g.clicks, impressions: g.impressions, ctr: r2(ctrOf(g) * 100) + '%', position: r2(g.position), clicksChange: pctChange(g.clicks, gp.clicks), impressionsChange: pctChange(g.impressions, gp.impressions), anonymisedClickShare: anonymisedShare(site.id, p.start, p.end) },
				bing: l.bing ? { clicks: bn.c ?? 0, impressions: bn.i ?? 0, clicksChange: pctChange(bn.c ?? 0, bp.c ?? 0) } : null,
				ga4OrganicSearch: l.ga4 ? { sessions: gn.s ?? 0, keyEvents: gn.k ?? 0, sessionsChange: pctChange(gn.s ?? 0, gpv.s ?? 0) } : null
			};
		}
	},
	{
		name: 'get_search_types',
		description: 'Google traffic split by search type (web, image, video, news, discover, googleNews) for a window vs the previous window, plus the search-appearance report (rich results and similar). The overview numbers are web only; this shows the rest.',
		schema: { ...siteArg, ...daysArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const p = periodFor(site, days(a));
			const now = typeBreakdown(site.id, p.start, p.end);
			const prev = typeBreakdown(site.id, p.prevStart, p.prevEnd);
			const app = appearanceFor(site.id, days(a));
			return {
				site: displayName(site.site_url),
				period: { start: p.start, end: p.end },
				note: 'Types fetched from Search Console; a type with no traffic is omitted. Web is the default report.',
				types: ALL_TYPES.filter((t) => now[t] && (now[t]!.clicks > 0 || now[t]!.impressions > 0)).map((t) => ({ type: t, clicks: now[t]!.clicks, impressions: now[t]!.impressions, ctr: r2(ctrOf(now[t]!) * 100) + '%', position: r2(now[t]!.position), clicksChange: prev[t] ? pctChange(now[t]!.clicks, prev[t]!.clicks) : null })),
				searchAppearance: { endingOn: app.pulledOn, rows: app.rows.map((r) => ({ appearance: r.appearance, clicks: r.clicks, impressions: r.impressions, position: r2(r.position) })) }
			};
		}
	},
	{
		name: 'get_web_vitals',
		description: 'Core Web Vitals (LCP, INP, CLS, plus FCP and TTFB) for a site from the Chrome UX Report: real-user 75th-percentile values for phone and desktop over the last 28 days, rated good / needs-improvement / poor. Site-wide field data, not per page. Sites with too little Chrome traffic have none.',
		schema: { ...siteArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!cruxIntegration()) return { connected: false, hint: 'Connect the Chrome UX Report (Core Web Vitals) on the Connect page.' };
			const { latest } = cruxLatest(site.id);
			if (!latest.size) return { connected: true, data: false, hint: 'No data yet: Chrome only reports sites with enough real visits.' };
			return {
				connected: true,
				devices: [...latest.values()].map((r) => ({
					device: r.form_factor === 'PHONE' ? 'phone' : 'desktop',
					origin: r.origin,
					snapshot: r.date,
					metrics: VITALS.filter((v) => r[v.key] != null).map((v) => ({ metric: v.name, value: r[v.key], unit: v.unit || 'score', rating: rate(v.key, r[v.key]), goodShare: v.core ? ({ lcp: r.lcp_good, inp: r.inp_good, cls: r.cls_good } as Record<string, number | null>)[v.key] : null }))
				}))
			};
		}
	},
	{
		name: 'get_top_queries',
		description: 'Top Google queries in a window with change vs the previous window. `branded` filters on brand terms (default: all).',
		schema: { ...siteArg, ...daysArg, limit: { type: 'integer' }, branded: { type: 'string', enum: ['all', 'only', 'exclude'] } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const p = periodFor(site, days(a));
			const terms = brandTerms(site);
			const prev = new Map(topQueries(site.id, p.prevStart, p.prevEnd, {}, 20000).map((r) => [r.query, r]));
			return topQueries(site.id, p.start, p.end, {}, 5000)
				.filter((r) => (a.branded === 'only' ? isBranded(r.query, terms) : a.branded === 'exclude' ? !isBranded(r.query, terms) : true))
				.slice(0, limit(a))
				.map((r) => ({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: r2(ctrOf(r) * 100) + '%', position: r2(r.position), clicksChange: pctChange(r.clicks, prev.get(r.query)?.clicks ?? 0) }));
		}
	},
	{
		name: 'get_top_pages',
		description: 'Top Google pages in a window with change vs the previous window.',
		schema: { ...siteArg, ...daysArg, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const p = periodFor(site, days(a));
			const prev = new Map(topPages(site.id, p.prevStart, p.prevEnd, {}, 50000).map((r) => [r.page, r]));
			return topPages(site.id, p.start, p.end, {}, 2000).slice(0, limit(a)).map((r) => ({ page: r.page, clicks: r.clicks, impressions: r.impressions, ctr: r2(ctrOf(r) * 100) + '%', position: r2(r.position), clicksChange: pctChange(r.clicks, prev.get(r.page)?.clicks ?? 0) }));
		}
	},
	{
		name: 'get_opportunities',
		description: 'SEO findings computed from stored history. type: striking (positions 4-20 ranked by estimated extra clicks, on the site\'s own fitted CTR curve), ctr_gaps (pages under-performing their position), cannibalization (queries split across competing pages), decay (statistically significant page declines, labelled page-specific vs site-wide), anomalies (unusual days).',
		schema: { ...siteArg, ...daysArg, type: { type: 'string', enum: ['striking', 'ctr_gaps', 'cannibalization', 'decay', 'anomalies'] }, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const n = days(a);
			const p = periodFor(site, n);
			const terms = brandTerms(site);
			const qp = queryPageRows(site.id, p.start, p.end);
			const curve = fittedCurve(qp, terms);
			const lim = limit(a);
			switch (a.type) {
				case 'striking':
					return { ctrCurve: curve.source, rows: computeStriking(topQueries(site.id, p.start, p.end, {}, 50000).filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: Math.max(10, Math.round((n / 28) * 30)), limit: lim }).map((r) => ({ query: r.query, position: r2(r.position), impressions: r.impressions, clicks: r.clicks, estimatedExtraClicksAtPos3: Math.round(r.expectedGain) })) };
				case 'ctr_gaps':
					return computeCtrGaps(qp.filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: Math.max(50, Math.round((n / 28) * 90)), limit: lim }).map((r) => ({ query: r.query, page: r.page, position: r2(r.position), ctr: r2(r.ctr * 100) + '%', expectedCtr: r2(r.expectedCtr * 100) + '%', missedClicks: Math.round(r.missedClicks) }));
				case 'cannibalization':
					return computeCannibalization(qp, curve, { limit: lim, minQueryImpressions: Math.max(20, Math.round((n / 28) * 40)) }).map((g) => ({ query: g.query, severity: g.severity, clicksAtStake: Math.round(g.potentialClicks), winner: g.winner, pages: g.pages.map((x) => ({ page: x.page, clicks: x.clicks, impressions: x.impressions, position: r2(x.position) })) }));
				case 'decay': {
					const delta = pctChange(summary(site.id, p.start, p.end).clicks, summary(site.id, p.prevStart, p.prevEnd).clicks) ?? 0;
					return { siteClicksChange: delta, rows: computeDecay(pageTotals(site.id, p.start, p.end), pageTotals(site.id, p.prevStart, p.prevEnd), delta, null, { limit: lim, minPrevClicks: Math.max(10, Math.round((n / 28) * 20)) }).map((r) => ({ page: r.page, lostClicks: r.lostClicks, change: r2(r.deltaPct * 100) + '%', scope: r.scope, positionBefore: r2(r.positionPrev), positionNow: r2(r.positionNow) })) };
				}
				case 'anomalies':
					return detectAnomalies(dailySeries(site.id, addDays(p.end, -(n + 90)), p.end).map((d) => ({ date: d.date, value: d.clicks }))).filter((x) => x.date >= p.start).map((x) => ({ date: x.date, clicks: x.value, expected: Math.round(x.expected), change: r2(x.deltaPct * 100) + '%', direction: x.direction }));
				default:
					throw new Error('`type` must be one of striking, ctr_gaps, cannibalization, decay, anomalies');
			}
		}
	},
	{
		name: 'get_bing_performance',
		description: 'Bing Webmaster data for a site: daily clicks/impressions plus top queries and pages. Note Bing updates query/page stats weekly, so rows are weekly buckets.',
		schema: { ...siteArg, ...daysArg, limit: { type: 'integer' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!linksFor(site.id).bing) return { connected: false, hint: 'Connect Bing Webmaster for this site on the Connect page.' };
			const p = periodFor(site, days(a));
			const d = db();
			const top = (kind: string) => d.prepare('SELECT term, SUM(clicks) clicks, SUM(impressions) impressions, AVG(click_pos) avgClickPosition FROM bing_terms WHERE site_id = ? AND kind = ? AND date BETWEEN ? AND ? GROUP BY term ORDER BY clicks DESC, impressions DESC LIMIT ?').all(site.id, kind, p.start, p.end, limit(a, 15));
			return { totals: d.prepare('SELECT SUM(clicks) clicks, SUM(impressions) impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, p.start, p.end), topQueries: top('query'), topPages: top('page') };
		}
	},
	{
		name: 'get_ga4_summary',
		description: 'GA4 sessions, engaged sessions, unique users and key events by channel group for a window (compare Organic Search with Google clicks), plus the top landing pages for Google organic sessions.',
		schema: { ...siteArg, ...daysArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!linksFor(site.id).ga4) return { connected: false, hint: 'Link a GA4 property on the Connect page.' };
			const p = periodFor(site, days(a));
			const d = db();
			const n = days(a);
			const unique = new Map((d.prepare('SELECT channel, users FROM ga4_period_users WHERE site_id = ? AND days = ?').all(site.id, n) as { channel: string; users: number }[]).map((r) => [r.channel, r.users]));
			const channels = (d.prepare('SELECT channel, SUM(sessions) sessions, SUM(engaged_sessions) engagedSessions, ROUND(SUM(key_events),1) keyEvents, SUM(pageviews) pageviews FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY channel ORDER BY sessions DESC').all(site.id, p.start, p.end) as { channel: string }[]).map((r) => ({ ...r, uniqueUsers: unique.get(r.channel) ?? null }));
			const landing = d.prepare('SELECT page, sessions, engaged_sessions engagedSessions, ROUND(key_events,1) keyEvents FROM ga4_landing WHERE site_id = ? AND days = ? ORDER BY sessions DESC LIMIT ?').all(site.id, n, limit(a, 25));
			return { period: { start: p.start, end: p.end }, note: 'uniqueUsers is over the whole window (GA4 Total users) and is null until the next GA4 sync; landing pages are Google organic only, by URL path.', channels, topGoogleOrganicLandingPages: landing };
		}
	},
	{
		name: 'get_gtm_container',
		description: 'The Google Tag Manager container linked to a site, as of its live (published) version: container id, version, and every tag (type, paused, firing triggers, GA4 measurement ID and event name where it has one), plus trigger and variable names. Read-only; nothing is edited or published.',
		schema: { ...siteArg, limit: { type: 'integer', description: 'Max items per list (default 100)' } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!linksFor(site.id).gtm) return { connected: false, hint: 'Link a Tag Manager container on the Connect page (reconnect the Google account if Tag Manager access was never granted).' };
			const s = gtmSnapshot(site.id);
			if (!s) return { connected: true, note: 'Linked, but not synced yet.' };
			const n = limit(a, 100);
			return {
				container: { id: s.publicId, name: s.name, path: s.containerPath, domains: s.domains },
				liveVersion: s.published ? { id: s.versionId, name: s.versionName } : null,
				note: s.published ? undefined : 'This container has never been published, so none of its tags run on the site.',
				syncedAt: new Date(s.fetchedAt).toISOString(),
				counts: { tags: s.tags.length, paused: s.tags.filter((t) => t.paused).length, triggers: s.triggers.length, variables: s.variables.length },
				ga4MeasurementIdsInContainer: [...new Set(s.tags.map((t) => t.measurementId).filter(Boolean))],
				ga4MeasurementIdsOnLinkedProperty: s.ga4MeasurementIds,
				tags: s.tags.slice(0, n).map((t) => ({ name: t.name, type: tagTypeLabel(t.type), paused: t.paused, firesOn: t.firing, blockedBy: t.blocking, measurementId: t.measurementId, eventName: t.eventName })),
				triggers: s.triggers.slice(0, n).map((t) => ({ name: t.name, type: t.type })),
				variables: s.variables.slice(0, n).map((v) => ({ name: v.name, type: v.type }))
			};
		}
	},
	{
		name: 'get_tracking_health',
		description: 'Cross-checks Search Console, GA4 and Tag Manager for one site and returns findings ranked critical / warning / info: unpublished container, no GA4 tag, the container sending to a different GA4 property than the one linked, paused or trigger-less tags, leftover Universal Analytics tags, and GA4 organic sessions far below Search Console clicks. Findings are prompts to investigate, not proof.',
		schema: { ...siteArg, ...daysArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const h = trackingHealth(site, days(a));
			return {
				site: displayName(site.site_url),
				sources: h.sources,
				...(h.sources.gtm ? {} : { hint: 'No Tag Manager container is synced for this site, so only the GA4 versus Search Console comparison can run.' }),
				window: { days: days(a), searchConsoleClicks: h.input.traffic.gscClicks, ga4OrganicSessions: h.input.traffic.ga4OrganicSessions },
				findings: h.findings,
				status: h.findings.some((f) => f.severity === 'critical') ? 'critical' : h.findings.some((f) => f.severity === 'warning') ? 'warning' : 'ok'
			};
		}
	},
	{
		name: 'get_connections',
		description: 'Which tools are connected for the sites this key can see: how many sites have GA4, Tag Manager, Bing, Clarity and OpenSEO linked, whether Core Web Vitals is on, and what to do to connect the rest. Use it to learn which other tools to call.',
		schema: {},
		run: (_a, sites) => {
			const ids = new Set(sites.map((s) => s.id));
			const links = allLinks().filter((l) => ids.has(l.site_id));
			const n = (k: string) => links.filter((l) => l.kind === k).length;
			const total = sites.length;
			return {
				sites: total,
				searchConsole: { connected: total, tools: ['get_overview', 'get_top_queries', 'get_top_pages', 'get_opportunities', 'get_search_types'] },
				ga4: { linkedSites: n('ga4'), tools: ['get_ga4_summary', 'get_tracking_health'] },
				tagManager: { linkedSites: n('gtm'), tools: ['get_gtm_container', 'get_tracking_health'] },
				bing: { linkedSites: n('bing'), tools: ['get_bing_performance'] },
				clarity: { linkedSites: n('clarity'), tools: ['get_clarity_snapshot'] },
				openseo: { linkedSites: n('openseo'), tools: ['get_openseo_project'] },
				coreWebVitals: { connected: cruxIntegration() != null, tools: ['get_web_vitals'] },
				hint: 'A source with linkedSites below `sites` can be completed on the Connect page. Every tool here is read-only.'
			};
		}
	},
	{
		name: 'get_clarity_snapshot',
		description: 'Latest stored Microsoft Clarity snapshot (last ~24h when it was taken; Clarity only exposes 1-3 days and 10 API calls/day/project, so OpenSiteConsole stores one snapshot per day). dimension: "" (totals), URL or Device.',
		schema: { ...siteArg, dimension: { type: 'string', enum: ['', 'URL', 'Device'] } },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!linksFor(site.id).clarity) return { connected: false, hint: 'Add a Clarity API token for this site on the Connect page.' };
			const row = db().prepare('SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = ? ORDER BY day DESC LIMIT 1').get(site.id, String(a.dimension ?? '')) as { day: string; payload: string } | undefined;
			return row ? { day: row.day, metrics: JSON.parse(row.payload) } : { connected: true, note: 'No snapshot stored yet.' };
		}
	},
	{
		name: 'get_openseo_project',
		description: 'The OpenSEO project linked to a site. Use its projectId with OpenSEO MCP tools (keyword research, rank tracking, audits, AI visibility) to combine third-party data with this first-party Search Console data.',
		schema: siteArg,
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			const l = linksFor(site.id).openseo;
			return l ? { projectId: l.external_id, name: l.label, url: openSeoProjectUrl(l.integration_id, l.external_id), domain: displayName(site.site_url) } : { linked: false, hint: 'No OpenSEO project is linked to this site. Connect OpenSEO on the Connect page.' };
		}
	}
];

const rpc = (id: unknown, result: unknown) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: unknown, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });

export async function handleMcp(request: Request): Promise<Response> {
	const auth = authenticate(request);
	const headers = { 'content-type': 'application/json' };
	if (!auth) return new Response(JSON.stringify(rpcErr(null, -32001, 'Missing or invalid API key (create one on the Agents page)')), { status: 401, headers: { ...headers, 'www-authenticate': 'Bearer' } });
	let msg: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
	try {
		msg = await request.json();
	} catch {
		return new Response(JSON.stringify(rpcErr(null, -32700, 'Parse error')), { status: 400, headers });
	}
	if (msg.id === undefined) return new Response(null, { status: 202 }); // notification
	const sites = allSites().filter((s) => !auth.scope || auth.scope.includes(s.id));
	const reply = (body: object) => new Response(JSON.stringify(body), { headers });
	switch (msg.method) {
		case 'initialize':
			return reply(rpc(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'opensiteconsole', version: '0.3.0' }, instructions: 'Read-only first-party search and tracking data (Google Search Console, GA4, Google Tag Manager, Bing, Clarity, Core Web Vitals). Call list_sites first, or get_connections to see which tools are connected. get_tracking_health cross-checks Search Console, GA4 and Tag Manager. Use get_openseo_project to hand a site to OpenSEO tools.' }));
		case 'ping':
			return reply(rpc(msg.id, {}));
		case 'tools/list':
			return reply(rpc(msg.id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: { type: 'object', properties: t.schema }, annotations: { readOnlyHint: true } })) }));
		case 'tools/call': {
			const tool = TOOLS.find((t) => t.name === msg.params?.name);
			if (!tool) return reply(rpcErr(msg.id, -32602, `Unknown tool ${String(msg.params?.name)}`));
			try {
				const out = tool.run((msg.params?.arguments as Record<string, unknown>) ?? {}, sites);
				return reply(rpc(msg.id, { content: [{ type: 'text', text: JSON.stringify(out) }] }));
			} catch (e) {
				return reply(rpc(msg.id, { isError: true, content: [{ type: 'text', text: e instanceof Error ? e.message : 'Tool failed' }] }));
			}
		}
		default:
			return reply(rpcErr(msg.id, -32601, `Method not found: ${msg.method}`));
	}
}
