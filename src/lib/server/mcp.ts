import { db } from './db';
import { allSites, brandTerms, fittedCurve, periodFor, queryPageRows, summary, topPages, topQueries, pageTotals, dailySeries, anonymisedShare } from './queries';
import { displayName } from './clients';
import { addDays } from './dates';
import { computeCannibalization, computeCtrGaps, computeDecay, computeStriking, ctrOf, detectAnomalies, isBranded, pctChange } from '../analytics';
import { linksFor } from './links';
import { openSeoProjectUrl } from './connect';
import { authenticate } from './apikeys';
import { hostKey } from './hosts';

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
		description: 'Every Search Console property this key can see, with which data sources are connected (bing, ga4, clarity, openseo) and the newest synced date. Start here.',
		schema: {},
		run: (_a, sites) =>
			sites.map((s) => {
				const l = linksFor(s.id);
				return { id: s.id, name: displayName(s.site_url), property: s.site_url, account: s.account_label ?? s.account_email, syncedThrough: s.synced_through, connected: { google: true, bing: !!l.bing, ga4: !!l.ga4, clarity: !!l.clarity, openseo: l.openseo ? { projectId: l.openseo.external_id, name: l.openseo.label } : false } };
			})
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
		description: 'GA4 sessions, engaged sessions, users and key events by channel group for a window (compare Organic Search with Google clicks).',
		schema: { ...siteArg, ...daysArg },
		run: (a, sites) => {
			const site = resolveSite(sites, a.site);
			if (!linksFor(site.id).ga4) return { connected: false, hint: 'Link a GA4 property on the Connect page.' };
			const p = periodFor(site, days(a));
			return db().prepare('SELECT channel, SUM(sessions) sessions, SUM(engaged_sessions) engagedSessions, SUM(users) users, ROUND(SUM(key_events),1) keyEvents, SUM(pageviews) pageviews FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY channel ORDER BY sessions DESC').all(site.id, p.start, p.end);
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
			return reply(rpc(msg.id, { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'opensiteconsole', version: '0.2.0' }, instructions: 'Read-only first-party search data (Google Search Console, Bing, GA4, Clarity). Call list_sites first. Use get_openseo_project to hand a site to OpenSEO tools.' }));
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
