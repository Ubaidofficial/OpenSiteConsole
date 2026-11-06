/**
 * Indexing: turning URL Inspection results into states and change events, and classifying URLs by how they perform.
 * Pure functions, unit-tested. Field values are from my recollection of the URL Inspection API and are read defensively.
 */
import { ctrAtPosition, ctrOf, normalizeUrl, type CtrCurve } from './analytics';

export interface Inspected {
	verdict?: string;
	coverageState?: string;
	indexingState?: string;
	robotsTxtState?: string;
	pageFetchState?: string;
	googleCanonical?: string;
	userCanonical?: string;
	lastCrawlTime?: string;
	error?: string;
}

export type IndexState = 'indexed' | 'not_indexed' | 'unknown';

/** PASS = on Google; NEUTRAL / FAIL = not on Google (excluded, crawled but not indexed, errors). Anything else, or a failed call, is unknown. */
export function indexState(r: Inspected | null | undefined): IndexState {
	if (!r || r.error) return 'unknown';
	if (r.verdict === 'PASS') return 'indexed';
	if (r.verdict === 'NEUTRAL' || r.verdict === 'FAIL') return 'not_indexed';
	return 'unknown';
}

export type IndexEventKind = 'deindexed' | 'indexed' | 'canonical_changed' | 'blocked' | 'unblocked' | 'fetch_error';
export interface IndexEvent { kind: IndexEventKind; detail: string }

/** What changed between two inspections of the same URL. An unknown state on either side produces no index event. */
export function diffInspection(prev: Inspected | null | undefined, next: Inspected): IndexEvent[] {
	if (!prev || prev.error || next.error) return [];
	const out: IndexEvent[] = [];
	const a = indexState(prev);
	const b = indexState(next);
	if (a === 'indexed' && b === 'not_indexed') out.push({ kind: 'deindexed', detail: next.coverageState ?? 'No longer indexed' });
	if (a === 'not_indexed' && b === 'indexed') out.push({ kind: 'indexed', detail: next.coverageState ?? 'Now indexed' });
	if (prev.googleCanonical && next.googleCanonical && normalizeUrl(prev.googleCanonical) !== normalizeUrl(next.googleCanonical)) {
		out.push({ kind: 'canonical_changed', detail: `${prev.googleCanonical} -> ${next.googleCanonical}` });
	}
	const wasBlocked = prev.robotsTxtState === 'DISALLOWED';
	const isBlocked = next.robotsTxtState === 'DISALLOWED';
	if (!wasBlocked && isBlocked) out.push({ kind: 'blocked', detail: 'robots.txt now disallows this URL' });
	if (wasBlocked && !isBlocked && next.robotsTxtState) out.push({ kind: 'unblocked', detail: 'robots.txt no longer disallows this URL' });
	if (prev.pageFetchState === 'SUCCESSFUL' && next.pageFetchState && next.pageFetchState !== 'SUCCESSFUL') out.push({ kind: 'fetch_error', detail: `Page fetch: ${next.pageFetchState}` });
	return out;
}

export const EVENT_SEVERITY: Record<IndexEventKind, 'bad' | 'warn' | 'good'> = {
	deindexed: 'bad',
	blocked: 'bad',
	fetch_error: 'bad',
	canonical_changed: 'warn',
	unblocked: 'good',
	indexed: 'good'
};

// ── Weak and dead URLs ───────────────────────────────────────────────────────
export type UrlClass = 'dead' | 'not-indexed' | 'fading' | 'underperforming' | 'weak' | 'healthy';

export interface UrlPerf {
	clicks: number;
	impressions: number;
	position: number;
	prevClicks: number;
	prevImpressions: number;
	/** from the indexing monitor, when this URL has been inspected */
	index?: IndexState;
	fetchState?: string;
}

/**
 * Heuristic classes, in this order of precedence. The cut-offs are my own, chosen to be conservative:
 *  dead            was visible (50+ impressions) and now has none, or Google fetched it and got a 404
 *                  (a soft 404 is not dead: Google just left it out of the index, which the next class covers)
 *  not-indexed     inspected and not on Google
 *  fading          lost at least half its clicks from a base of 20+
 *  underperforming 200+ impressions in the top 20 but CTR under half of what that position normally earns on this site
 *  weak            100+ impressions, no clicks, average position beyond 20
 * Search Console only knows pages that were shown at least once, so a page with no impressions in either window is
 * invisible here; compare against your sitemap to find those.
 */
export function classifyUrl(u: UrlPerf, curve: CtrCurve): UrlClass {
	if ((u.impressions === 0 && u.prevImpressions >= 50) || u.fetchState === 'NOT_FOUND') return 'dead';
	if (u.index === 'not_indexed') return 'not-indexed';
	if (u.prevClicks >= 20 && u.clicks <= u.prevClicks * 0.5) return 'fading';
	if (u.impressions >= 200 && u.position > 0 && u.position <= 20 && ctrOf(u) < 0.5 * ctrAtPosition(curve, u.position)) return 'underperforming';
	if (u.impressions >= 100 && u.clicks === 0 && u.position > 20) return 'weak';
	return 'healthy';
}
