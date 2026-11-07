/**
 * Hidden opportunities: findings that need more than one source or more than one period to see. Pure functions, unit-tested.
 *
 * Each one takes plain rows and the site's own CTR curve and returns rows with an honest estimate or none. Where a figure is a
 * model (what a better position would be worth) it is computed on the site's own curve and the caller labels it as an estimate;
 * where no honest figure exists (a conversion leak, a Bing gap on a query Google never shows) `gain` is null rather than invented.
 */
import { ctrAtPosition, isBranded, type CtrCurve, type PRow, type QPRow, type QRow } from './analytics';
import { pathKey, rollUp, type ClarityPage, type Ga4Page, type Vol } from './pageinsights';

const gainBetween = (curve: CtrCurve, impressions: number, from: number, to: number) => Math.max(0, impressions * (ctrAtPosition(curve, to) - ctrAtPosition(curve, from)));
/** Search queries compare case- and spacing-insensitively across sources. */
export const normQuery = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

// ── queries that stopped earning clicks ──────────────────────────────────────
export interface LostQuery { query: string; prevClicks: number; clicks: number; prevImpressions: number; impressions: number; positionPrev: number; positionNow: number | null; lostClicks: number }

/** Searches that earned clicks in the previous period and have nearly stopped. Brand searches are left out (they follow brand demand, not SEO). */
export function lostQueries(now: QRow[], prev: QRow[], terms: string[], o: { minPrevClicks?: number; keep?: number; limit?: number } = {}): LostQuery[] {
	const { minPrevClicks = 8, keep = 0.25, limit = 25 } = o;
	const cur = new Map(now.map((r) => [normQuery(r.query), r]));
	const out: LostQuery[] = [];
	for (const p of prev) {
		if (p.clicks < minPrevClicks || isBranded(p.query, terms)) continue;
		const c = cur.get(normQuery(p.query));
		const clicks = c?.clicks ?? 0;
		if (clicks > p.clicks * keep) continue;
		out.push({ query: p.query, prevClicks: p.clicks, clicks, prevImpressions: p.impressions, impressions: c?.impressions ?? 0, positionPrev: p.position, positionNow: c ? c.position : null, lostClicks: p.clicks - clicks });
	}
	return out.sort((a, b) => b.lostClicks - a.lostClicks || a.query.localeCompare(b.query)).slice(0, limit);
}

// ── searches that are growing and not yet won ────────────────────────────────
export interface RisingQuery { query: string; impressions: number; prevImpressions: number; position: number; isNew: boolean; gain: number }

/** Searches whose impressions at least doubled and where the site is still below position 5: demand is arriving and the site has not captured it. */
export function risingQueries(now: QRow[], prev: QRow[], curve: CtrCurve, terms: string[], o: { minImpressions?: number; minPos?: number; maxPos?: number; limit?: number } = {}): RisingQuery[] {
	const { minImpressions = 40, minPos = 6, maxPos = 40, limit = 25 } = o;
	const before = new Map(prev.map((r) => [normQuery(r.query), r]));
	const out: RisingQuery[] = [];
	for (const r of now) {
		if (r.impressions < minImpressions || r.position < minPos || r.position > maxPos || isBranded(r.query, terms)) continue;
		const pi = before.get(normQuery(r.query))?.impressions ?? 0;
		if (r.impressions < pi * 2 || r.impressions - pi < minImpressions * 0.75) continue;
		out.push({ query: r.query, impressions: r.impressions, prevImpressions: pi, position: r.position, isNew: pi === 0, gain: gainBetween(curve, r.impressions, r.position, 5) });
	}
	return out.sort((a, b) => b.gain - a.gain || b.impressions - a.impressions || a.query.localeCompare(b.query)).slice(0, limit);
}

// ── Bing and Google disagree ─────────────────────────────────────────────────
export interface BingGap { query: string; bingPosition: number; bingImpressions: number; googlePosition: number | null; googleImpressions: number; gain: number | null }

/**
 * Searches where Bing ranks the site near the top and Google ranks it far down or not at all. Bing has judged the page relevant,
 * so the content is probably fine for the topic; what Google lacks is authority, links or a clearer match. `gain` is null when
 * Google shows the site nowhere for the search, because there is then no impression count to price it with.
 */
export function bingGaps(bing: QRow[], google: QRow[], curve: CtrCurve, terms: string[], o: { minBingImpressions?: number; bingMaxPos?: number; googleMinPos?: number; limit?: number } = {}): BingGap[] {
	const { minBingImpressions = 20, bingMaxPos = 5, googleMinPos = 11, limit = 25 } = o;
	const g = new Map(google.map((r) => [normQuery(r.query), r]));
	const out: BingGap[] = [];
	for (const b of bing) {
		if (b.impressions < minBingImpressions || b.position > bingMaxPos || b.position <= 0 || isBranded(b.query, terms)) continue;
		const gr = g.get(normQuery(b.query));
		if (gr && gr.position < googleMinPos) continue;
		out.push({ query: b.query, bingPosition: b.position, bingImpressions: b.impressions, googlePosition: gr ? gr.position : null, googleImpressions: gr?.impressions ?? 0, gain: gr ? gainBetween(curve, gr.impressions, gr.position, 5) : null });
	}
	return out.sort((a, b) => (b.gain ?? -1) - (a.gain ?? -1) || b.bingImpressions - a.bingImpressions || a.query.localeCompare(b.query)).slice(0, limit);
}

export interface NotInBing { page: string; clicks: number }

/** Pages that earn Google clicks and that Bing shows no impressions for at all: not indexed there, or not ranking. IndexNow is the quick way to ask. */
export function pagesNotInBing(google: PRow[], bingPaths: Set<string>, o: { minClicks?: number; limit?: number } = {}): NotInBing[] {
	const { minClicks = 10, limit = 25 } = o;
	const seen = new Map<string, NotInBing>();
	for (const r of google) {
		if (r.clicks < minClicks) continue;
		const k = pathKey(r.page);
		if (bingPaths.has(k)) continue;
		const cur = seen.get(k);
		seen.set(k, { page: cur && cur.clicks >= r.clicks ? cur.page : r.page, clicks: (cur?.clicks ?? 0) + r.clicks });
	}
	return [...seen.values()].sort((a, b) => b.clicks - a.clicks || a.page.localeCompare(b.page)).slice(0, limit);
}

// ── visitors arrive and do not stay or convert ───────────────────────────────
export interface SiteRates { sessions: number; engagementRate: number; keyEventRate: number }

export function siteRates(pages: Ga4Page[]): SiteRates {
	const s = pages.reduce((a, p) => a + p.sessions, 0);
	return { sessions: s, engagementRate: s ? pages.reduce((a, p) => a + p.engagedSessions, 0) / s : 0, keyEventRate: s ? pages.reduce((a, p) => a + p.keyEvents, 0) / s : 0 };
}

export interface EngagementLeak { page: string; sessions: number; engagementRate: number; siteRate: number; lostEngagedSessions: number }

/** Organic landing pages where far fewer visitors engage than on the rest of the site: the page does not match what the search promised. */
export function engagementLeaks(pages: Ga4Page[], o: { minSessions?: number; ratio?: number; minSiteSessions?: number; limit?: number } = {}): EngagementLeak[] {
	const { minSessions = 100, ratio = 0.6, minSiteSessions = 300, limit = 25 } = o;
	const site = siteRates(pages);
	if (site.sessions < minSiteSessions || site.engagementRate <= 0) return [];
	return pages
		.filter((p) => p.sessions >= minSessions && p.engagedSessions / p.sessions < site.engagementRate * ratio)
		.map((p) => ({ page: p.page, sessions: p.sessions, engagementRate: p.engagedSessions / p.sessions, siteRate: site.engagementRate, lostEngagedSessions: p.sessions * (site.engagementRate - p.engagedSessions / p.sessions) }))
		.sort((a, b) => b.lostEngagedSessions - a.lostEngagedSessions || a.page.localeCompare(b.page))
		.slice(0, limit);
}

export interface ConversionLeak { page: string; sessions: number; expectedKeyEvents: number }

/** Busy organic landing pages with no key events at all, on a site where visitors do convert elsewhere. */
export function conversionLeaks(pages: Ga4Page[], o: { minSessions?: number; minExpected?: number; minSiteSessions?: number; limit?: number } = {}): ConversionLeak[] {
	const { minSessions = 200, minExpected = 3, minSiteSessions = 300, limit = 25 } = o;
	const site = siteRates(pages);
	if (site.sessions < minSiteSessions || site.keyEventRate <= 0) return [];
	return pages
		.filter((p) => p.sessions >= minSessions && p.keyEvents === 0 && p.sessions * site.keyEventRate >= minExpected)
		.map((p) => ({ page: p.page, sessions: p.sessions, expectedKeyEvents: p.sessions * site.keyEventRate }))
		.sort((a, b) => b.expectedKeyEvents - a.expectedKeyEvents || a.page.localeCompare(b.page))
		.slice(0, limit);
}

// ── pages that convert and sit just below the top ────────────────────────────
export interface HiddenGem { page: string; sessions: number; engagementRate: number; keyEventRate: number; position: number; impressions: number; gain: number }

/**
 * Pages whose visitors engage and convert better than the site average and that Google ranks at positions 4 to 20: the audience
 * that arrives is the right one, there is just not enough of it. Pushing these up is worth more than the same push elsewhere.
 */
export function hiddenGems(ga: Ga4Page[], google: Vol[], curve: CtrCurve, o: { minSessions?: number; minImpressions?: number; minPos?: number; maxPos?: number; minSiteSessions?: number; limit?: number } = {}): HiddenGem[] {
	const { minSessions = 30, minImpressions = 100, minPos = 4, maxPos = 20, minSiteSessions = 300, limit = 25 } = o;
	const site = siteRates(ga);
	if (site.sessions < minSiteSessions) return [];
	const g = rollUp(google);
	const out: HiddenGem[] = [];
	for (const p of ga) {
		if (p.sessions < minSessions) continue;
		const v = g.get(pathKey(p.page));
		if (!v || v.position < minPos || v.position > maxPos || v.impressions < minImpressions) continue;
		const eng = p.engagedSessions / p.sessions;
		const key = p.keyEvents / p.sessions;
		const engagesBetter = eng >= site.engagementRate * 1.1;
		// Where the site measures conversions, the page must convert clearly better too; where it measures none, engagement alone has to do.
		const convertsBetter = site.keyEventRate > 0 ? key >= site.keyEventRate * 1.5 && p.keyEvents > 0 : true;
		if (!engagesBetter || !convertsBetter) continue;
		out.push({ page: pathKey(p.page), sessions: p.sessions, engagementRate: eng, keyEventRate: key, position: v.position, impressions: v.impressions, gain: gainBetween(curve, v.impressions, v.position, 3) });
	}
	return out.sort((a, b) => b.gain - a.gain || a.page.localeCompare(b.page)).slice(0, limit);
}

// ── friction seen by real visitors ───────────────────────────────────────────
export interface Friction { page: string; sessions: number; frictionSessions: number; rate: number; googleClicks: number }

/** Search-landing pages where many sessions had rage or dead clicks (Clarity). The larger of the two counts is used so one session is not counted twice. */
export function clarityFriction(pages: ClarityPage[], googleClicks: Map<string, number>, o: { minSessions?: number; minRate?: number; limit?: number } = {}): Friction[] {
	const { minSessions = 30, minRate = 0.05, limit = 25 } = o;
	return pages
		.filter((p) => (p.sessions ?? 0) >= minSessions && (googleClicks.get(pathKey(p.url)) ?? 0) > 0)
		.map((p) => {
			const f = Math.max(p.rageClicks ?? 0, p.deadClicks ?? 0);
			return { page: pathKey(p.url), sessions: p.sessions!, frictionSessions: f, rate: f / p.sessions!, googleClicks: googleClicks.get(pathKey(p.url)) ?? 0 };
		})
		.filter((p) => p.rate >= minRate)
		.sort((a, b) => b.googleClicks * b.rate - a.googleClicks * a.rate || a.page.localeCompare(b.page))
		.slice(0, limit);
}

// ── ranks worse on phones than on desktop ────────────────────────────────────
export interface DeviceGap { query: string; mobilePosition: number; desktopPosition: number; mobileImpressions: number; gain: number }

/** Searches where the site ranks at least `posGap` places worse on phones than on desktop, with enough phone impressions to matter. */
export function deviceGaps(mobile: QRow[], desktop: QRow[], curve: CtrCurve, terms: string[], o: { minMobileImpressions?: number; minDesktopImpressions?: number; posGap?: number; limit?: number } = {}): DeviceGap[] {
	const { minMobileImpressions = 40, minDesktopImpressions = 20, posGap = 3, limit = 25 } = o;
	const d = new Map(desktop.map((r) => [normQuery(r.query), r]));
	const out: DeviceGap[] = [];
	for (const m of mobile) {
		if (m.impressions < minMobileImpressions || isBranded(m.query, terms)) continue;
		const dr = d.get(normQuery(m.query));
		if (!dr || dr.impressions < minDesktopImpressions || m.position - dr.position < posGap) continue;
		out.push({ query: m.query, mobilePosition: m.position, desktopPosition: dr.position, mobileImpressions: m.impressions, gain: gainBetween(curve, m.impressions, m.position, dr.position) });
	}
	return out.sort((a, b) => b.gain - a.gain || a.query.localeCompare(b.query)).slice(0, limit);
}

// ── one page, many searches just below the top ───────────────────────────────
export interface PageEdge { page: string; queries: number; impressions: number; gain: number; top: { query: string; position: number; impressions: number }[] }

/**
 * Pages that sit at positions 4 to 20 for several searches at once: one good update to the page can lift all of them. The prize is
 * priced at position 5 for every search (not 3), because lifting many searches at once to the very top is not a fair expectation.
 */
export function pagesOnTheEdge(rows: QPRow[], curve: CtrCurve, terms: string[], o: { minQueries?: number; minQueryImpressions?: number; minTotalImpressions?: number; minPos?: number; maxPos?: number; targetPos?: number; limit?: number } = {}): PageEdge[] {
	const { minQueries = 4, minQueryImpressions = 10, minTotalImpressions = 100, minPos = 4, maxPos = 20, targetPos = 5, limit = 25 } = o;
	const by = new Map<string, QPRow[]>();
	for (const r of rows) {
		if (r.position < minPos || r.position > maxPos || r.impressions < minQueryImpressions || isBranded(r.query, terms)) continue;
		(by.get(r.page) ?? by.set(r.page, []).get(r.page)!).push(r);
	}
	const out: PageEdge[] = [];
	for (const [page, rs] of by) {
		const impressions = rs.reduce((a, r) => a + r.impressions, 0);
		if (rs.length < minQueries || impressions < minTotalImpressions) continue;
		const top = [...rs].sort((a, b) => b.impressions - a.impressions).slice(0, 5).map((r) => ({ query: r.query, position: r.position, impressions: r.impressions }));
		out.push({ page, queries: rs.length, impressions, gain: rs.reduce((a, r) => a + gainBetween(curve, r.impressions, r.position, targetPos), 0), top });
	}
	return out.sort((a, b) => b.gain - a.gain || a.page.localeCompare(b.page)).slice(0, limit);
}

// ── questions people ask that the site answers poorly ────────────────────────
export interface QuestionGap { query: string; position: number; impressions: number; clicks: number; gain: number }

/** Question-shaped searches where the site shows but ranks below position 7. A short, direct answer section is the usual way in. */
export function questionGaps(rows: QRow[], curve: CtrCurve, terms: string[], isQuestion: (q: string) => boolean, o: { minImpressions?: number; minPos?: number; maxPos?: number; limit?: number } = {}): QuestionGap[] {
	const { minImpressions = 15, minPos = 8, maxPos = 50, limit = 25 } = o;
	return rows
		.filter((r) => r.impressions >= minImpressions && r.position >= minPos && r.position <= maxPos && isQuestion(r.query) && !isBranded(r.query, terms))
		.map((r) => ({ query: r.query, position: r.position, impressions: r.impressions, clicks: r.clicks, gain: gainBetween(curve, r.impressions, r.position, 5) }))
		.sort((a, b) => b.gain - a.gain || b.impressions - a.impressions || a.query.localeCompare(b.query))
		.slice(0, limit);
}

