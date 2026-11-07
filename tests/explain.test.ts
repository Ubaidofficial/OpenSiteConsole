import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ACTION_TYPES, DONE_DAYS, SNOOZE_DAYS } from '../src/lib/actions';
import { BLOCKING_EXPLAIN, BUTTON_EXPLAIN, CONFIDENCE_EXPLAIN, EFFORT_EXPLAIN, IMPACT_EXPLAIN, NO_IMPACT_EXPLAIN, TYPE_EXPLAIN, TYPE_LABEL } from '../src/lib/explain';

describe('action explainers', () => {
	it('every action type has a label and a real explanation, and nothing extra is defined', () => {
		expect(Object.keys(TYPE_LABEL).sort()).toEqual([...ACTION_TYPES].sort());
		expect(Object.keys(TYPE_EXPLAIN).sort()).toEqual([...ACTION_TYPES].sort());
		for (const t of ACTION_TYPES) {
			expect(TYPE_LABEL[t].length).toBeGreaterThan(2);
			expect(TYPE_EXPLAIN[t].length).toBeGreaterThan(40); // a sentence, not a placeholder
			expect(TYPE_EXPLAIN[t]).not.toBe(TYPE_LABEL[t]);
		}
	});

	it('every explanation is distinct, so two chips never show the same hover text', () => {
		const all = [...Object.values(TYPE_EXPLAIN), ...Object.values(CONFIDENCE_EXPLAIN), ...Object.values(EFFORT_EXPLAIN), BLOCKING_EXPLAIN, IMPACT_EXPLAIN, NO_IMPACT_EXPLAIN, ...Object.values(BUTTON_EXPLAIN)];
		expect(new Set(all).size).toBe(all.length);
	});

	it('the button explainers state the real durations from the code, not copies of them', () => {
		expect(BUTTON_EXPLAIN.done).toContain(`${DONE_DAYS} days`);
		expect(BUTTON_EXPLAIN.snooze).toContain(`${SNOOZE_DAYS} days`);
		expect(BUTTON_EXPLAIN.done).not.toBe(BUTTON_EXPLAIN.snooze);
	});

	it('the impact explainer says the window is 28 days, matching the "/ 28d" chip', () => {
		expect(IMPACT_EXPLAIN).toContain('28 days');
	});
});

describe('day units are written like the period picker ("28d", "30d"), never "28 d"', () => {
	const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
	it('finds no "<number> d" in the app source', () => {
		const offenders = walk('src').filter((f) => /\.(svelte|ts)$/.test(f)).flatMap((f) => readFileSync(f, 'utf8').split('\n').map((l, i) => [f, i + 1, l] as const).filter(([, , l]) => /\b\d+ d\b/.test(l)).map(([file, n]) => `${file}:${n}`));
		expect(offenders).toEqual([]);
	});
});

describe('portfolio explainers', () => {
	it('every tab on the page has an explanation, and the intro says what the page is', async () => {
		const { PORTFOLIO_INTRO, PORTFOLIO_TAB_EXPLAIN } = await import('../src/lib/explain');
		const src = readFileSync('src/routes/portfolio/+page.svelte', 'utf8');
		const tabs = [...src.matchAll(/\['(\w+)', '[^']+'\]/g)].map((m) => m[1]);
		expect(tabs.sort()).toEqual(['anomalies', 'cannibalization', 'decay', 'striking']);
		for (const t of tabs) expect(PORTFOLIO_TAB_EXPLAIN[t]?.length).toBeGreaterThan(60);
		expect(new Set(Object.values(PORTFOLIO_TAB_EXPLAIN)).size).toBe(4);
		expect(PORTFOLIO_INTRO).toMatch(/across all your visible, synced sites/);
	});
});
