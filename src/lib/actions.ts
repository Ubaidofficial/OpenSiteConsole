/**
 * The action queue: every finding the app can make, as one list ordered by what to do first. Pure functions, unit-tested.
 *
 * How it is ordered, and why:
 *  1. BLOCKING first. Things that stop the site earning or stop you measuring it (tracking broken, key pages blocked or
 *     de-indexed, a collapse in traffic) come before any optimisation, however large the optimisation looks, because
 *     optimising on top of them is wasted or unmeasurable.
 *  2. Then by score = estimated clicks per 28 days x confidence. The estimates come from the site's own CTR curve and its own
 *     history, so they are model figures, not promises; confidence says how much to trust each kind.
 *  3. Items with no click estimate (hygiene, structure) follow the quantified ones, in a fixed order of type.
 * Estimates are NOT added together: findings overlap (the same page can be a CTR gap, a decay and a cannibalization), so a
 * total would double count. Each stands alone.
 */

export const ACTION_TYPES = [
	'tracking', 'blocked', 'deindexed', 'sitewide', 'anomaly', 'dead', 'not-indexed', 'update',
	'cannibalization', 'ctr-gap', 'decay', 'striking', 'onpage', 'sitemap', 'vitals', 'test',
	'lost-query', 'rising', 'page-edge', 'gem', 'questions', 'bing', 'device', 'engagement', 'friction'
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];
export type Confidence = 'high' | 'medium' | 'low';
export type Effort = 'low' | 'medium' | 'high';

export interface ActionItem {
	/** stable across runs, so "done" and "snooze" survive a recompute */
	key: string;
	type: ActionType;
	siteId: number;
	title: string;
	why: string;
	how: string;
	/** estimated clicks per 28 days at stake or to gain; null when there is no honest number */
	impact: number | null;
	confidence: Confidence;
	effort: Effort;
	/** stops the site earning or stops you measuring it: before everything else */
	blocking: boolean;
	/** where to act: a path inside the app */
	href: string;
	evidence: string[];
}

/** Item types whose title, text or evidence names a page or a query (so privacy mode must blur them). */
export const NAMES_TARGETS: ReadonlySet<ActionType> = new Set<ActionType>(['cannibalization', 'ctr-gap', 'decay', 'striking', 'dead', 'not-indexed', 'deindexed', 'blocked', 'onpage', 'sitemap', 'anomaly', 'lost-query', 'rising', 'page-edge', 'gem', 'questions', 'bing', 'device', 'engagement', 'friction']);

export const CONFIDENCE_WEIGHT: Record<Confidence, number> = { high: 1, medium: 0.6, low: 0.3 };

/** Ties among unquantified items, and within the blocking group, resolve in this order. */
const TYPE_ORDER: ActionType[] = ['tracking', 'blocked', 'deindexed', 'sitewide', 'anomaly', 'dead', 'not-indexed', 'update', 'test', 'cannibalization', 'ctr-gap', 'decay', 'lost-query', 'page-edge', 'striking', 'rising', 'gem', 'questions', 'bing', 'device', 'engagement', 'friction', 'onpage', 'sitemap', 'vitals'];

export const scoreOf = (a: Pick<ActionItem, 'impact' | 'confidence'>) => (a.impact == null ? 0 : a.impact * CONFIDENCE_WEIGHT[a.confidence]);

export function rankActions<T extends ActionItem>(items: T[]): T[] {
	const t = (a: T) => TYPE_ORDER.indexOf(a.type);
	return [...items].sort((a, b) => {
		if (a.blocking !== b.blocking) return a.blocking ? -1 : 1;
		const sa = scoreOf(a), sb = scoreOf(b);
		if (sa !== sb) return sb - sa;
		// no estimate vs an estimate of zero-ish: quantified items still come first
		if ((a.impact == null) !== (b.impact == null)) return a.impact == null ? 1 : -1;
		return t(a) - t(b) || a.key.localeCompare(b.key);
	});
}

/** Short stable hash (FNV-1a) of the things an item is about, for keys that survive recomputation. */
export function keyHash(parts: string[]): string {
	let h = 0x811c9dc5;
	for (const ch of parts.join('\n')) {
		h ^= ch.codePointAt(0)!;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}

export type ActionStatus = 'open' | 'done' | 'snoozed';

/** An item is hidden while it is snoozed or marked done; both expire, so a problem that is still there comes back. */
export function statusOf(state: { state: string; until: number } | undefined, now = Date.now()): ActionStatus {
	if (!state || state.until <= now) return 'open';
	return state.state === 'done' ? 'done' : 'snoozed';
}

export const SNOOZE_DAYS = 30;
/** "Done" hides an item for 90 days; if the problem is still detected after that, it returns. */
export const DONE_DAYS = 90;
