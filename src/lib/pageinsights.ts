/**
 * Pages seen by every source side by side (Google, Bing, GA4, AI assistants via GA4, Clarity), joined on the URL path. Pure functions, unit-tested.
 *
 * The join key is the path with no query string, fragment or trailing slash, because that is all GA4 reports and the other
 * sources differ in host (www or not) and scheme. Several URLs with the same path (http / https / www variants) are rolled up
 * into one row so no source counts a page twice.
 */
import { pctChange } from './analytics';

export interface Vol { url: string; clicks: number; impressions: number; position: number }
export interface Ga4Page { page: string; sessions: number; engagedSessions: number; keyEvents: number }
/** GA4 sessions that came from one AI assistant and landed on one page. */
export interface AiPage { page: string; assistant: string; sessions: number; engagedSessions: number; keyEvents: number }
export interface ClarityPage { url: string; sessions: number | null; rageClicks: number | null; deadClicks: number | null }

/** Path of a URL (or of something that already is a path): no query, no fragment, no trailing slash, "/" stays "/". */
export function pathKey(u: string): string {
	let p = u.trim();
	try {
		p = new URL(p).pathname;
	} catch {
		/* not absolute: treat it as a path */
	}
	p = p.split(/[?#]/)[0];
	if (!p.startsWith('/')) p = '/' + p;
	return p.length > 1 ? p.replace(/\/+$/, '') || '/' : p;
}

/** Sum rows that share a path. Position is weighted by impressions; the URL kept is the one with the most clicks. */
export function rollUp(rows: Vol[]): Map<string, Vol> {
	const out = new Map<string, Vol & { w: number; best: number }>();
	for (const r of rows) {
		const k = pathKey(r.url);
		const cur = out.get(k) ?? { url: r.url, clicks: 0, impressions: 0, position: 0, w: 0, best: -1 };
		cur.clicks += r.clicks;
		cur.impressions += r.impressions;
		cur.w += r.position * r.impressions;
		if (r.clicks > cur.best) (cur.best = r.clicks, (cur.url = r.url));
		out.set(k, cur);
	}
	const final = new Map<string, Vol>();
	for (const [k, v] of out) final.set(k, { url: v.url, clicks: v.clicks, impressions: v.impressions, position: v.impressions ? v.w / v.impressions : 0 });
	return final;
}

export interface PageSources {
	google: Vol[];
	/** null when the previous period is not fully stored: no change is claimed */
	googlePrev: Vol[] | null;
	bing: Vol[] | null;
	bingPrev: Vol[] | null;
	ga4: Ga4Page[] | null;
	ga4Prev: Ga4Page[] | null;
	/** GA4 sessions from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot) by landing page */
	ai: AiPage[] | null;
	/** null when the previous window is not stored (or had no AI sessions to compare with): no change is claimed */
	aiPrev: AiPage[] | null;
	clarity: ClarityPage[] | null;
}

/** One row for the table. A value is null when that source has nothing for the page (shown as a dash), never 0 by assumption. */
export interface InsightRow {
	path: string;
	/** a full address to link to */
	url: string;
	gClicks: number | null; gClicksD: number | null; gImpr: number | null; gImprD: number | null; gPos: number | null;
	bClicks: number | null; bClicksD: number | null; bImpr: number | null; bImprD: number | null; bPos: number | null;
	aSessions: number | null; aSessionsD: number | null; aEngaged: number | null; aKeyEvents: number | null; aKeyEventsD: number | null;
	/** GA4 sessions that arrived from AI assistants, across all of them; aiBy is the split, busiest first */
	aiSessions: number | null; aiSessionsD: number | null; aiEngaged: number | null; aiKeyEvents: number | null; aiTop: string | null; aiBy: { assistant: string; sessions: number }[] | null;
	cSessions: number | null; cRage: number | null; cDead: number | null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** The union of the paths every source knows, each with that source's numbers and its change against the previous period. */
export function mergePages(s: PageSources, originFor: (path: string) => string): InsightRow[] {
	const g = rollUp(s.google);
	const gp = s.googlePrev ? rollUp(s.googlePrev) : null;
	const b = s.bing ? rollUp(s.bing) : null;
	const bp = s.bingPrev ? rollUp(s.bingPrev) : null;
	const ga = new Map<string, Ga4Page>();
	for (const r of s.ga4 ?? []) {
		const k = pathKey(r.page);
		const c = ga.get(k) ?? { page: k, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		c.sessions += r.sessions;
		c.engagedSessions += r.engagedSessions;
		c.keyEvents += r.keyEvents;
		ga.set(k, c);
	}
	const gap = new Map<string, Ga4Page>();
	for (const r of s.ga4Prev ?? []) {
		const k = pathKey(r.page);
		const c = gap.get(k) ?? { page: k, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		c.sessions += r.sessions;
		c.keyEvents += r.keyEvents;
		gap.set(k, c);
	}
	// AI assistants: one row per page, summed over assistants, with the split kept for "which assistant".
	const rollAi = (rows: AiPage[] | null) => {
		const m = new Map<string, { sessions: number; engaged: number; keyEvents: number; by: Map<string, number> }>();
		for (const r of rows ?? []) {
			const k = pathKey(r.page);
			const c = m.get(k) ?? { sessions: 0, engaged: 0, keyEvents: 0, by: new Map<string, number>() };
			c.sessions += r.sessions;
			c.engaged += r.engagedSessions;
			c.keyEvents += r.keyEvents;
			c.by.set(r.assistant, (c.by.get(r.assistant) ?? 0) + r.sessions);
			m.set(k, c);
		}
		return m;
	};
	const ai = rollAi(s.ai);
	const aip = s.aiPrev ? rollAi(s.aiPrev) : null;
	const cl = new Map<string, ClarityPage>();
	for (const r of s.clarity ?? []) {
		const k = pathKey(r.url);
		const c = cl.get(k) ?? { url: k, sessions: null, rageClicks: null, deadClicks: null };
		const add = (a: number | null, v: number | null) => (v == null ? a : (a ?? 0) + v);
		c.sessions = add(c.sessions, r.sessions);
		c.rageClicks = add(c.rageClicks, r.rageClicks);
		c.deadClicks = add(c.deadClicks, r.deadClicks);
		cl.set(k, c);
	}
	const paths = new Set<string>([...g.keys(), ...(b?.keys() ?? []), ...ga.keys(), ...ai.keys(), ...cl.keys()]);
	const out: InsightRow[] = [];
	for (const path of paths) {
		const G = g.get(path), GP = gp?.get(path), B = b?.get(path), BP = bp?.get(path), A = ga.get(path), AP = gap.get(path), AI = ai.get(path), AIP = aip?.get(path), C = cl.get(path);
		// A change needs a real previous period on that source; "not stored" is different from "zero".
		const dG = (now: number, key: 'clicks' | 'impressions') => (G && gp ? pctChange(now, GP?.[key] ?? 0) : null);
		const dB = (now: number, key: 'clicks' | 'impressions') => (B && bp ? pctChange(now, BP?.[key] ?? 0) : null);
		const dA = (now: number, prev: number | undefined) => (A && s.ga4Prev ? pctChange(now, prev ?? 0) : null);
		const dAi = (now: number, prev: number | undefined) => (AI && aip ? pctChange(now, prev ?? 0) : null);
		const aiBy = AI ? [...AI.by].map(([assistant, sessions]) => ({ assistant, sessions })).sort((x, y) => y.sessions - x.sessions || (x.assistant < y.assistant ? -1 : 1)) : null;
		out.push({
			path,
			url: G?.url ?? B?.url ?? originFor(path),
			gClicks: G?.clicks ?? null, gClicksD: G ? dG(G.clicks, 'clicks') : null, gImpr: G?.impressions ?? null, gImprD: G ? dG(G.impressions, 'impressions') : null, gPos: G?.position || null,
			bClicks: B?.clicks ?? null, bClicksD: B ? dB(B.clicks, 'clicks') : null, bImpr: B?.impressions ?? null, bImprD: B ? dB(B.impressions, 'impressions') : null, bPos: B?.position || null,
			aSessions: A?.sessions ?? null, aSessionsD: A ? dA(A.sessions, AP?.sessions) : null, aEngaged: A && A.sessions ? A.engagedSessions / A.sessions : null,
			aKeyEvents: A ? r1(A.keyEvents) : null, aKeyEventsD: A ? dA(A.keyEvents, AP?.keyEvents) : null,
			aiSessions: AI?.sessions ?? null, aiSessionsD: AI ? dAi(AI.sessions, AIP?.sessions) : null, aiEngaged: AI && AI.sessions ? AI.engaged / AI.sessions : null,
			aiKeyEvents: AI ? r1(AI.keyEvents) : null, aiTop: aiBy?.[0]?.assistant ?? null, aiBy,
			cSessions: C?.sessions ?? null, cRage: C?.rageClicks ?? null, cDead: C?.deadClicks ?? null
		});
	}
	return out.sort((x, y) => (y.gClicks ?? -1) - (x.gClicks ?? -1) || (y.bClicks ?? -1) - (x.bClicks ?? -1) || (y.aSessions ?? -1) - (x.aSessions ?? -1) || (y.aiSessions ?? -1) - (x.aiSessions ?? -1) || (x.path < y.path ? -1 : 1));
}

/**
 * Per-page figures out of a Clarity "by URL" snapshot. Clarity answers one list per metric, each row naming the URL; the field
 * names below (a URL field, totalSessionCount for Traffic, sessionsCount for the click metrics) are from memory of its documentation
 * and the demo data, so a row that does not match simply contributes nothing.
 */
export function clarityPages(metrics: { metricName: string; information: Record<string, string | number>[] }[]): ClarityPage[] {
	const out = new Map<string, ClarityPage>();
	const num = (v: unknown) => {
		const n = Number(v);
		return v === undefined || v === '' || !Number.isFinite(n) ? null : n;
	};
	for (const m of metrics) {
		const field = m.metricName === 'Traffic' ? 'totalSessionCount' : m.metricName === 'RageClickCount' || m.metricName === 'DeadClickCount' ? 'sessionsCount' : null;
		if (!field) continue;
		for (const row of m.information ?? []) {
			const urlKey = Object.keys(row).find((k) => k.toLowerCase() === 'url');
			if (!urlKey || !row[urlKey]) continue;
			const v = num(row[field]);
			if (v === null) continue;
			const k = pathKey(String(row[urlKey]));
			const cur = out.get(k) ?? { url: k, sessions: null, rageClicks: null, deadClicks: null };
			if (m.metricName === 'Traffic') cur.sessions = (cur.sessions ?? 0) + v;
			else if (m.metricName === 'RageClickCount') cur.rageClicks = (cur.rageClicks ?? 0) + v;
			else cur.deadClicks = (cur.deadClicks ?? 0) + v;
			out.set(k, cur);
		}
	}
	return [...out.values()];
}
