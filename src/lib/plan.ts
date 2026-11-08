import type { ActionItem } from './actions';

/**
 * The plan a site report opens on: what to do in the next two weeks, picked from the ranked action queue (nothing new is computed).
 * Blocking problems first, then the best low-effort items (quick wins), then the best bigger opportunities that carry a click estimate.
 * The queue is already ranked by estimated clicks times confidence, so each list keeps that order.
 */
export interface Plan {
	blocking: ActionItem[];
	quick: ActionItem[];
	bigger: ActionItem[];
	/** open findings in all, so the plan can say how much it left out */
	total: number;
	/** marked done and not yet back */
	done: number;
}

export const PLAN_SIZES = { blocking: 3, quick: 4, bigger: 3 } as const;

export function planFrom(q: { open: ActionItem[]; hidden: { status: string }[] }): Plan {
	const rest = q.open.filter((a) => !a.blocking);
	return {
		blocking: q.open.filter((a) => a.blocking).slice(0, PLAN_SIZES.blocking),
		quick: rest.filter((a) => a.effort === 'low').slice(0, PLAN_SIZES.quick),
		bigger: rest.filter((a) => a.effort !== 'low' && a.impact != null).slice(0, PLAN_SIZES.bigger),
		total: q.open.length,
		done: q.hidden.filter((h) => h.status === 'done').length
	};
}

/** The first sentence of an item's "what to do", for a one-line plan row (the full text is on the Actions tab). */
export function firstStep(how: string): string {
	const m = /^(.+?[.!?])(\s|$)/.exec(how.trim());
	return m ? m[1] : how.trim();
}

/** Position buckets for the "where your searches rank" bar: the top 3, the rest of page 1, the edge of page 2, everything below. */
export const POSITION_BUCKETS = [
	{ key: 'top3', label: 'Top 3', max: 3.5 },
	{ key: 'p1', label: 'Positions 4–10', max: 10.5 },
	{ key: 'p2', label: 'Positions 11–20', max: 20.5 },
	{ key: 'deep', label: 'Below 20', max: Infinity }
] as const;

/**
 * How many searches sit in each bucket. Only searches with at least `minImpressions` count, so one-off long-tail searches with a
 * single impression at position 60 do not swamp the picture.
 */
export function positionBuckets(rows: { position: number; impressions: number }[], minImpressions = 10): number[] {
	const out = POSITION_BUCKETS.map(() => 0);
	for (const r of rows) {
		if (r.impressions < minImpressions || !(r.position > 0)) continue;
		out[POSITION_BUCKETS.findIndex((b) => r.position <= b.max)]++;
	}
	return out;
}
