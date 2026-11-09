import { describe, expect, it } from 'vitest';
import { fixFirst, type FixFirstInput } from '../src/lib/fixfirst';
import { CONFIDENCE_WEIGHT } from '../src/lib/actions';

const empty = (): FixFirstInput => ({ ctrGaps: [], edge: [], decay: [], gems: [], beyond: [], engagement: [], conversions: [], friction: [], notInBing: [], botPages: [], googleClicks: new Map() });

describe('fixFirst', () => {
	it('lists only pages with counted findings from at least two different sources', () => {
		const i = empty();
		i.ctrGaps = [{ page: 'https://x.example/solo', query: 'q', missedClicks: 99 }];
		i.decay = [{ page: '/same-source', lostClicks: 40, deltaPct: -0.4 }, { page: '/multi', lostClicks: 10, deltaPct: -0.3 }];
		i.edge = [{ page: '/same-source', gain: 90, queries: 5 }]; // two findings, both Search Console: one problem seen twice
		i.engagement = [{ page: '/multi', lostEngagedSessions: 20 }];
		expect(fixFirst(i).map((r) => r.page)).toEqual(['/multi']);
		expect(fixFirst(i, { minSources: 1 }).map((r) => r.page).sort()).toEqual(['/multi', '/same-source', '/solo']);
	});

	it('scores a page by its single biggest estimate times confidence and never adds them', () => {
		const i = empty();
		i.decay = [{ page: '/a', lostClicks: 100, deltaPct: -0.5 }]; // medium: 60
		i.edge = [{ page: '/a', gain: 300, queries: 5 }]; // low: 90
		i.ctrGaps = [{ page: '/a', query: 'q1', missedClicks: 10 }, { page: '/a', query: 'q2', missedClicks: 15 }]; // medium, summed per page: 25 -> 15
		i.friction = [{ page: '/a', rate: 0.1 }]; // a second source, no estimate
		const [r] = fixFirst(i);
		expect(r.score).toBeCloseTo(300 * CONFIDENCE_WEIGHT.low);
		expect(r.signals).toHaveLength(4);
		expect(r.signals.find((s) => s.kind === 'ctr-gap')?.clicks).toBe(25);
		expect(r.sources.sort()).toEqual(['clarity', 'google']);
	});

	it('puts quantified pages first, then unquantified ones by number of sources, then Google clicks', () => {
		const i = empty();
		i.decay = [{ page: '/small', lostClicks: 10, deltaPct: -0.3 }];
		i.engagement = [{ page: '/small', lostEngagedSessions: 4 }, { page: '/u1', lostEngagedSessions: 9 }, { page: '/u2', lostEngagedSessions: 9 }, { page: '/u3', lostEngagedSessions: 9 }];
		i.friction = [{ page: '/u1', rate: 0.1 }, { page: '/u2', rate: 0.1 }, { page: '/u3', rate: 0.1 }];
		i.notInBing = [{ page: '/u3', clicks: 5 }];
		i.googleClicks = new Map([['/u1', 5], ['/u2', 500], ['/u3', 1]]);
		expect(fixFirst(i).map((r) => r.page)).toEqual(['/small', '/u3', '/u2', '/u1']); // three sources beat two; then more Google clicks
	});

	it('shows a bot-heavy page\'s GA4 and Clarity findings as suspect and does not count them', () => {
		const i = empty();
		i.engagement = [{ page: '/bot', lostEngagedSessions: 50 }];
		i.friction = [{ page: '/bot', rate: 0.2 }];
		i.botPages = [{ page: 'https://x.example/bot/' }];
		expect(fixFirst(i)).toEqual([]); // both findings are suspect: nothing counts

		i.decay = [{ page: '/bot', lostClicks: 30, deltaPct: -0.4 }];
		expect(fixFirst(i)).toEqual([]); // one counted source is still not enough

		i.notInBing = [{ page: '/bot', clicks: 30 }];
		const [r] = fixFirst(i);
		expect(r.botHeavy).toBe(true);
		expect(r.sources.sort()).toEqual(['bing', 'google']);
		expect(r.signals.filter((s) => s.suspect).map((s) => s.kind).sort()).toEqual(['engagement', 'friction']);
		expect(r.signals.slice(0, 2).every((s) => !s.suspect)).toBe(true); // counted findings are listed first
	});

	it('joins the same page across URL spellings, and honours the limit', () => {
		const i = empty();
		i.decay = [{ page: 'https://x.example/Page/?utm=1', lostClicks: 30, deltaPct: -0.4 }];
		i.gems = [{ page: '/Page', gain: 12 }];
		expect(fixFirst(i).map((r) => r.page)).toEqual(['/Page']);
		i.decay.push({ page: '/other', lostClicks: 10, deltaPct: -0.3 });
		i.gems.push({ page: '/other', gain: 5 });
		expect(fixFirst(i, { limit: 1 })).toHaveLength(1);
	});

	it('counts deep searches per page and ignores ones with no page', () => {
		const i = empty();
		i.beyond = [{ topPage: '/p', impressions: 100 }, { topPage: '/p', impressions: 50 }, { topPage: null, impressions: 999 }];
		i.gems = [{ page: '/p', gain: 10 }];
		const [r] = fixFirst(i);
		expect(r.signals.find((s) => s.kind === 'beyond')?.label).toContain('2 searches');
		expect(r.signals.find((s) => s.kind === 'beyond')?.label).toContain('150 impressions');
	});
});
