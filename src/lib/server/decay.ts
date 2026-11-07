import type { SiteRow } from './clients';
import { addDays } from './dates';
import { pageTotals, periodFor, summary } from './queries';
import { computeDecay, pctChange } from '../analytics';

/**
 * Content decay, two ways. `period`: pages that lost clicks against the equally long period just before (fast decay, and what a change
 * or an update did). `yoy`: against the same weekdays one year earlier (364 days), which catches the slow slide a month-on-month view
 * misses and is not fooled by seasons. The year view needs the stored history to reach back that far.
 */
export type DecayMode = 'period' | 'yoy';

export function decayReport(site: SiteRow, days: number, mode: DecayMode) {
	const p = periodFor(site, days);
	const now = pageTotals(site.id, p.start, p.end);
	const minPrevClicks = Math.max(10, Math.round((days / 28) * 20));
	const yStart = addDays(p.start, -364);
	const yEnd = addDays(p.end, -364);
	const hasYear = !!site.backfilled_to && site.backfilled_to <= yStart;
	const nowTotal = summary(site.id, p.start, p.end);
	if (mode === 'yoy') {
		if (!hasYear) return { mode, siteDelta: 0, hasYear, rows: [] as ReturnType<typeof computeDecay> };
		const siteDelta = pctChange(nowTotal.clicks, summary(site.id, yStart, yEnd).clicks) ?? 0;
		return { mode, siteDelta, hasYear, rows: computeDecay(now, pageTotals(site.id, yStart, yEnd), siteDelta, null, { minPrevClicks }) };
	}
	const siteDelta = pctChange(nowTotal.clicks, summary(site.id, p.prevStart, p.prevEnd).clicks) ?? 0;
	return { mode, siteDelta, hasYear, rows: computeDecay(now, pageTotals(site.id, p.prevStart, p.prevEnd), siteDelta, hasYear ? pageTotals(site.id, yStart, yEnd) : null, { minPrevClicks }) };
}
