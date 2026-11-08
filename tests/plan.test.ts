import { describe, expect, it } from 'vitest';
import { firstStep, planFrom, PLAN_SIZES } from '../src/lib/plan';
import { SITE_PRIMARY_TABS, SITE_TAB_GROUPS, SITE_TABS } from '../src/lib/explain';
import type { ActionItem } from '../src/lib/actions';

let n = 0;
const item = (o: Partial<ActionItem>): ActionItem => ({ key: `k${n++}`, type: 'striking', siteId: 1, title: 't', why: 'w', how: 'Do this. Then that.', impact: 10, confidence: 'medium', effort: 'medium', blocking: false, href: '/x', evidence: [], ...o });

describe('the two-week plan a site report opens on', () => {
	it('puts blocking problems first, then quick wins, then bigger opportunities, keeping the queue order in each', () => {
		const open = [
			item({ key: 'big1', impact: 500 }),
			item({ key: 'quick1', effort: 'low', type: 'ctr-gap', impact: 40 }),
			item({ key: 'block', blocking: true, type: 'tracking', impact: null }),
			item({ key: 'big2', impact: 300, effort: 'high' }),
			item({ key: 'quick2', effort: 'low', type: 'questions', impact: 20 })
		];
		const p = planFrom({ open, hidden: [] });
		expect(p.blocking.map((a) => a.key)).toEqual(['block']);
		expect(p.quick.map((a) => a.key)).toEqual(['quick1', 'quick2']);
		expect(p.bigger.map((a) => a.key)).toEqual(['big1', 'big2']);
		expect(p.total).toBe(5);
	});
	it('stays short: at most 3 + 4 + 3 items, however many findings there are', () => {
		const open = [...Array.from({ length: 10 }, () => item({ blocking: true })), ...Array.from({ length: 10 }, () => item({ effort: 'low' })), ...Array.from({ length: 10 }, () => item({}))];
		const p = planFrom({ open, hidden: [] });
		expect([p.blocking.length, p.quick.length, p.bigger.length]).toEqual([PLAN_SIZES.blocking, PLAN_SIZES.quick, PLAN_SIZES.bigger]);
	});
	it('leaves bigger items without a click estimate out of the plan (they stay on the Actions tab) and counts what was done', () => {
		const p = planFrom({ open: [item({ impact: null })], hidden: [{ status: 'done' }, { status: 'snoozed' }] });
		expect(p.bigger).toEqual([]);
		expect(p.done).toBe(1);
	});
	it('a plan row shows only the first sentence of what to do', () => {
		expect(firstStep('Rewrite the title. Then check the snippet.')).toBe('Rewrite the title.');
		expect(firstStep('No full stop here')).toBe('No full stop here');
		expect(firstStep('Is it indexed? Check it.')).toBe('Is it indexed?');
	});
});

describe('the site tab bar', () => {
	it('shows a short row of real tabs, starting with the plan, and keeps every other tab reachable under More', () => {
		const all = SITE_TABS.map(([t]) => t as string);
		expect(SITE_PRIMARY_TABS[0]).toBe('');
		expect(SITE_PRIMARY_TABS.length).toBeLessThanOrEqual(8);
		for (const t of SITE_PRIMARY_TABS) expect(all, t).toContain(t);
		const grouped = SITE_TAB_GROUPS.flatMap(([, paths]) => [...paths] as string[]);
		for (const t of all) expect(grouped, t).toContain(t); // the More menu is built from the groups
		expect(SITE_PRIMARY_TABS).toContain('/quickwins');
		expect(SITE_PRIMARY_TABS).toContain('/actions');
		expect(SITE_PRIMARY_TABS).toContain('/opportunities');
	});
});
