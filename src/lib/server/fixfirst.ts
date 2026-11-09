import type { SiteRow } from './clients';
import { brandTerms, fittedCurve, pageTotals, periodFor, queryPageRows } from './queries';
import { computeCtrGaps, computeDecay, isBranded, pctChange } from '../analytics';
import { fixFirst, type PageFix } from '../fixfirst';
import { hiddenReport, type HiddenReport } from './hidden';
import { pathKey } from '../pageinsights';

type Site = Pick<SiteRow, 'id' | 'site_url' | 'synced_through' | 'backfill_done' | 'backfilled_to' | 'brand_terms'>;

export interface FixFirstReport {
	period: HiddenReport['period'];
	/** which sources fed it, so an empty list can be told from "a source is missing" */
	sources: HiddenReport['sources'];
	rows: PageFix[];
}

/**
 * Pages with several findings at once, from the same detectors the Opportunities tab and the action queue use (same thresholds), so a
 * page here is never one those would not show on its own. See fixfirst.ts for how the pages are ordered.
 */
export function fixFirstReport(site: Site, days = 28): FixFirstReport {
	const h = hiddenReport(site, days);
	const p = periodFor(site, days);
	const scale = days / 28;
	const terms = brandTerms(site as never);

	const qp = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	const minImpr = Math.max(10, Math.round(scale * 30));
	const ctrGaps = computeCtrGaps(qp.filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: Math.max(50, minImpr * 3) });

	const now = pageTotals(site.id, p.start, p.end);
	const googleClicks = new Map<string, number>();
	for (const r of now) googleClicks.set(pathKey(r.page), (googleClicks.get(pathKey(r.page)) ?? 0) + r.clicks);

	// Decay needs a stored previous period; without one no page is said to have lost clicks.
	let decay: { page: string; lostClicks: number; deltaPct: number }[] = [];
	if (h.sources.previousPeriod === 'ok') {
		const prev = pageTotals(site.id, p.prevStart, p.prevEnd);
		const total = now.reduce((a, r) => a + r.clicks, 0);
		const prevTotal = prev.reduce((a, r) => a + r.clicks, 0);
		const siteDelta = pctChange(total, prevTotal) ?? 0;
		decay = computeDecay(now, prev, siteDelta, null, { limit: 50, minPrevClicks: Math.max(10, Math.round(scale * 20)) })
			.filter((r) => r.scope === 'page-specific')
			.map((r) => ({ page: r.page, lostClicks: r.lostClicks, deltaPct: r.deltaPct }));
	}

	const rows = fixFirst({
		ctrGaps: ctrGaps.map((g) => ({ page: g.page, query: g.query, missedClicks: g.missedClicks })),
		edge: h.pageEdge.map((e) => ({ page: e.page, gain: e.gain, queries: e.queries })),
		decay,
		gems: h.gems.map((g) => ({ page: g.page, gain: g.gain })),
		beyond: h.beyond.map((b) => ({ topPage: b.topPage, impressions: b.impressions })),
		engagement: h.engagement.map((e) => ({ page: e.page, lostEngagedSessions: e.lostEngagedSessions })),
		conversions: h.conversions.map((c) => ({ page: c.page, expectedKeyEvents: c.expectedKeyEvents })),
		friction: h.friction.map((f) => ({ page: f.page, rate: f.rate })),
		notInBing: h.notInBing.map((b) => ({ page: b.page, clicks: b.clicks })),
		botPages: h.bots.map((b) => ({ page: b.page })),
		googleClicks
	});
	return { period: h.period, sources: h.sources, rows };
}
