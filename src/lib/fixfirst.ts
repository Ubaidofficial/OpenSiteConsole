/**
 * "Fix this first", by page: every finding that names a page, gathered under that page, so the pages with several problems at once
 * stand out. Pure functions, unit-tested.
 *
 * How it is ordered, and why (the same rules as the action queue, see actions.ts):
 *  - A page is listed only when findings from at least two different sources (Search Console, GA4, Clarity, Bing) count as evidence.
 *    Several findings from one source are often one problem seen twice (a weak snippet and a position just below the top), and each is
 *    already in the action queue. What is new here is seeing that the same page is losing clicks AND losing visitors AND frustrating them.
 *  - Estimates are NOT added together. The findings overlap (a page below its click curve is often also on the edge of page one), so a
 *    sum would count the same clicks twice. A page is scored by its single largest estimate times that finding's confidence.
 *  - Findings with no click estimate (leaving visitors, rage clicks, Bing gaps) are listed and counted as evidence but add no score;
 *    a page whose findings are all unquantified follows the quantified ones.
 *  - Bots: when Clarity says a quarter or more of a page's sessions were bots, its GA4 and Clarity findings are shown but do not count
 *    as evidence, because automated visits can look like leaving visitors or rage clicks.
 */
import { CONFIDENCE_WEIGHT, type Confidence } from './actions';
import { pathKey } from './pageinsights';

export type Family = 'google' | 'ga4' | 'clarity' | 'bing';
export type SignalKind = 'ctr-gap' | 'page-edge' | 'decay' | 'gem' | 'beyond' | 'engagement' | 'conversion' | 'friction' | 'not-in-bing';

export interface Signal {
	kind: SignalKind;
	family: Family;
	/** one plain sentence about this page */
	label: string;
	/** estimated clicks per window at stake or to gain; null when there is no honest number */
	clicks: number | null;
	confidence: Confidence;
	/** shown but not counted as evidence (a bot-heavy page's GA4 or Clarity findings) */
	suspect: boolean;
}

export interface PageFix {
	page: string;
	googleClicks: number;
	signals: Signal[];
	/** distinct sources behind the findings that count */
	sources: Family[];
	/** largest estimate times its confidence; null when no finding has an estimate */
	score: number | null;
	botHeavy: boolean;
}

export interface FixFirstInput {
	ctrGaps: { page: string; query: string; missedClicks: number }[];
	edge: { page: string; gain: number; queries: number }[];
	decay: { page: string; lostClicks: number; deltaPct: number }[];
	gems: { page: string; gain: number }[];
	beyond: { topPage: string | null; impressions: number }[];
	engagement: { page: string; lostEngagedSessions: number }[];
	conversions: { page: string; expectedKeyEvents: number }[];
	friction: { page: string; rate: number }[];
	notInBing: { page: string; clicks: number }[];
	botPages: { page: string }[];
	/** Search Console clicks per page, keyed by path (as pathKey returns it) */
	googleClicks: Map<string, number>;
}

const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const pct0 = (x: number) => `${Math.round(x * 100)}%`;
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function fixFirst(input: FixFirstInput, o: { minSources?: number; limit?: number } = {}): PageFix[] {
	const { minSources = 2, limit = 25 } = o;
	const bots = new Set(input.botPages.map((b) => pathKey(b.page)));
	const by = new Map<string, Signal[]>();
	const add = (page: string | null, s: Omit<Signal, 'suspect'>) => {
		if (!page) return;
		const k = pathKey(page);
		const suspect = bots.has(k) && (s.family === 'ga4' || s.family === 'clarity');
		const list = by.get(k) ?? [];
		list.push({ ...s, suspect });
		by.set(k, list);
	};

	// Click-rate gaps: one signal per page, over its searches (different searches have different impressions, so their gaps do add up).
	const gapBy = new Map<string, { clicks: number; queries: number }>();
	for (const g of input.ctrGaps) {
		const k = pathKey(g.page);
		const c = gapBy.get(k) ?? { clicks: 0, queries: 0 };
		c.clicks += g.missedClicks;
		c.queries += 1;
		gapBy.set(k, c);
	}
	for (const [page, c] of gapBy) add(page, { kind: 'ctr-gap', family: 'google', label: `Earns about ${n0(c.clicks)} fewer clicks than its position normally would, across ${c.queries} ${plural(c.queries, 'search', 'searches')}: the title or snippet is the weak part.`, clicks: c.clicks, confidence: 'medium' });
	for (const e of input.edge) add(e.page, { kind: 'page-edge', family: 'google', label: `Sits just below the top for ${e.queries} searches at once; one good update could lift them all (up to about ${n0(e.gain)} clicks).`, clicks: e.gain, confidence: 'low' });
	for (const d of input.decay) add(d.page, { kind: 'decay', family: 'google', label: `Lost ${n0(d.lostClicks)} clicks (${Math.round(d.deltaPct * 100)}%) against the previous period, more than the site as a whole.`, clicks: d.lostClicks, confidence: 'medium' });
	for (const g of input.gems) add(g.page, { kind: 'gem', family: 'ga4', label: `Visitors engage and convert better here than on average, yet it ranks 4 to 20 (about ${n0(g.gain)} clicks at position 3).`, clicks: g.gain, confidence: 'medium' });

	const deep = new Map<string, { searches: number; impressions: number }>();
	for (const b of input.beyond) {
		if (!b.topPage) continue;
		const k = pathKey(b.topPage);
		const c = deep.get(k) ?? { searches: 0, impressions: 0 };
		c.searches += 1;
		c.impressions += b.impressions;
		deep.set(k, c);
	}
	for (const [page, c] of deep) add(page, { kind: 'beyond', family: 'google', label: `Shown for ${c.searches} ${plural(c.searches, 'search', 'searches')} only beyond position 20 (${n0(c.impressions)} impressions): a topic Google links to it but ranks weakly.`, clicks: null, confidence: 'low' });

	for (const e of input.engagement) add(e.page, { kind: 'engagement', family: 'ga4', label: `Loses visitors faster than the rest of the site: about ${n0(e.lostEngagedSessions)} visits that would have engaged at the site rate.`, clicks: null, confidence: 'medium' });
	for (const c of input.conversions) add(c.page, { kind: 'conversion', family: 'ga4', label: `Busy page with no key events at all, where the site converts elsewhere (about ${n0(c.expectedKeyEvents)} expected).`, clicks: null, confidence: 'low' });
	for (const f of input.friction) add(f.page, { kind: 'friction', family: 'clarity', label: `${pct0(f.rate)} of sessions had rage or dead clicks (Clarity, last day).`, clicks: null, confidence: 'low' });
	for (const b of input.notInBing) add(b.page, { kind: 'not-in-bing', family: 'bing', label: `Earns Google clicks but Bing shows no impressions: probably not indexed there.`, clicks: null, confidence: 'low' });

	const rows: PageFix[] = [];
	for (const [page, signals] of by) {
		const counted = signals.filter((s) => !s.suspect);
		const sources = [...new Set(counted.map((s) => s.family))];
		if (sources.length < minSources) continue;
		const scored = counted.filter((s) => s.clicks != null).map((s) => s.clicks! * CONFIDENCE_WEIGHT[s.confidence]);
		rows.push({
			page,
			googleClicks: input.googleClicks.get(page) ?? 0,
			// quantified findings first, then by size
			signals: [...signals].sort((a, b) => Number(a.suspect) - Number(b.suspect) || (b.clicks ?? -1) * CONFIDENCE_WEIGHT[b.confidence] - (a.clicks ?? -1) * CONFIDENCE_WEIGHT[a.confidence]),
			sources,
			score: scored.length ? Math.max(...scored) : null,
			botHeavy: bots.has(page)
		});
	}
	return rows
		.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.sources.length - a.sources.length || b.googleClicks - a.googleClicks || a.page.localeCompare(b.page))
		.slice(0, limit);
}
