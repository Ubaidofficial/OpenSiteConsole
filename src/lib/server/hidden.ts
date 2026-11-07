import { db } from './db';
import type { SiteRow } from './clients';
import { brandTerms, fittedCurve, historyCoversPrevious, pageTotals, periodFor, queryPageRows, topQueries } from './queries';
import { linksFor } from './links';
import { clarityPages, pathKey, type ClarityPage, type Ga4Page, type Vol } from '../pageinsights';
import type { ClarityMetric } from './clarity';
import { isQuestionQuery } from '../trends';
import {
	bingGaps, clarityFriction, conversionLeaks, deviceGaps, engagementLeaks, hiddenGems, lostQueries, pagesNotInBing, pagesOnTheEdge, questionGaps, risingQueries,
	type BingGap, type ConversionLeak, type DeviceGap, type EngagementLeak, type Friction, type HiddenGem, type LostQuery, type NotInBing, type PageEdge, type QuestionGap, type RisingQuery
} from '../hidden';
import type { QRow } from '../analytics';

type Site = Pick<SiteRow, 'id' | 'site_url' | 'synced_through' | 'backfill_done' | 'backfilled_to' | 'brand_terms'>;

/** Why a detector that needs another source produced nothing, in words a person can act on. */
export type SourceNote = 'ok' | 'not-connected' | 'no-data' | 'no-previous-period';

export interface HiddenReport {
	period: { start: string; end: string; prevStart: string; prevEnd: string; days: number };
	curveSource: string;
	sources: { previousPeriod: SourceNote; bing: SourceNote; ga4: SourceNote; clarity: SourceNote };
	lost: LostQuery[];
	rising: RisingQuery[];
	bingGaps: BingGap[];
	notInBing: NotInBing[];
	engagement: EngagementLeak[];
	conversions: ConversionLeak[];
	gems: HiddenGem[];
	friction: Friction[];
	device: DeviceGap[];
	pageEdge: PageEdge[];
	questions: QuestionGap[];
}

/** Every cross-source and cross-period finding for one site in one window. Cheap enough to run on demand; actions.ts caches its use of it. */
export function hiddenReport(site: Site, days: number): HiddenReport {
	const d = db();
	const p = periodFor(site, days);
	const scale = days / 28;
	const links = linksFor(site.id);
	const terms = brandTerms(site as never);
	const comparable = historyCoversPrevious(site, p.prevStart);

	const qp = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	const now = topQueries(site.id, p.start, p.end, {}, 50_000);
	const prev = topQueries(site.id, p.prevStart, p.prevEnd, {}, 50_000); // used only when the stored history really covers that period (below)
	const pages = pageTotals(site.id, p.start, p.end);

	// Bing: queries and pages for this window, impression position weighted by impressions.
	const bingTerms = (kind: 'query' | 'page'): QRow[] =>
		(d.prepare(`SELECT term query, SUM(clicks) clicks, SUM(impressions) impressions, COALESCE(SUM(COALESCE(impr_pos, 0) * impressions) * 1.0 / NULLIF(SUM(impressions), 0), 0) position FROM bing_terms WHERE site_id = ? AND kind = ? AND date BETWEEN ? AND ? GROUP BY term`).all(site.id, kind, p.start, p.end) as QRow[]);
	const bingQ = links.bing ? bingTerms('query') : [];
	const bingP = links.bing ? bingTerms('page') : [];

	// GA4: Google-organic landing pages, only when pulled for exactly this window length.
	const ga: Ga4Page[] = links.ga4
		? (d.prepare('SELECT page, sessions, engaged_sessions engagedSessions, key_events keyEvents FROM ga4_landing WHERE site_id = ? AND days = ?').all(site.id, days) as Ga4Page[])
		: [];

	// Clarity: the newest "by URL" snapshot (24 hours only).
	let clarity: ClarityPage[] = [];
	if (links.clarity) {
		const snap = d.prepare("SELECT payload FROM clarity_snapshots WHERE site_id = ? AND dimension = 'URL' ORDER BY day DESC LIMIT 1").get(site.id) as { payload: string } | undefined;
		if (snap) {
			try {
				clarity = clarityPages(JSON.parse(snap.payload) as ClarityMetric[]);
			} catch {
				clarity = [];
			}
		}
	}

	const googleVol: Vol[] = pages.map((r) => ({ url: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position }));
	const clicksByPath = new Map<string, number>();
	for (const r of pages) clicksByPath.set(pathKey(r.page), (clicksByPath.get(pathKey(r.page)) ?? 0) + r.clicks);

	const mobile = topQueries(site.id, p.start, p.end, { device: 'MOBILE' }, 50_000);
	const desktop = topQueries(site.id, p.start, p.end, { device: 'DESKTOP' }, 50_000);
	const bingPaths = new Set(bingP.filter((r) => r.impressions > 0).map((r) => pathKey(r.query)));

	const n = (x: number, floor: number) => Math.max(floor, Math.round(scale * x));
	return {
		period: { ...p, days },
		curveSource: curve.source,
		sources: {
			previousPeriod: comparable ? 'ok' : 'no-previous-period',
			bing: !links.bing ? 'not-connected' : bingQ.length || bingP.length ? 'ok' : 'no-data',
			ga4: !links.ga4 ? 'not-connected' : ga.length ? 'ok' : 'no-data',
			clarity: !links.clarity ? 'not-connected' : clarity.length ? 'ok' : 'no-data'
		},
		lost: comparable ? lostQueries(now, prev, terms, { minPrevClicks: n(8, 4) }) : [],
		rising: comparable ? risingQueries(now, prev, curve, terms, { minImpressions: n(40, 15) }) : [],
		bingGaps: bingQ.length ? bingGaps(bingQ, now, curve, terms, { minBingImpressions: n(20, 8) }) : [],
		notInBing: bingP.length >= 5 ? pagesNotInBing(pages, bingPaths, { minClicks: n(10, 5) }) : [],
		engagement: engagementLeaks(ga, { minSessions: n(100, 40), minSiteSessions: n(300, 120) }),
		conversions: conversionLeaks(ga, { minSessions: n(200, 80), minSiteSessions: n(300, 120) }),
		gems: hiddenGems(ga, googleVol, curve, { minSessions: n(30, 15), minImpressions: n(100, 40), minSiteSessions: n(300, 120) }),
		friction: clarity.length ? clarityFriction(clarity, clicksByPath) : [],
		device: deviceGaps(mobile, desktop, curve, terms, { minMobileImpressions: n(40, 15), minDesktopImpressions: n(20, 8) }),
		pageEdge: pagesOnTheEdge(qp, curve, terms, { minQueryImpressions: n(10, 5), minTotalImpressions: n(100, 40) }),
		questions: questionGaps(now, curve, terms, isQuestionQuery, { minImpressions: n(15, 6) })
	};
}
