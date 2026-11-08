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
