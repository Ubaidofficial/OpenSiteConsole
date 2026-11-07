import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app should not read like a manual. A paragraph of explanation on a page is either short or folded away (the Explainer component, or a
 * <details>), so the first thing anyone sees is the data and one sentence about it. Pages that are meant to be read (privacy, terms, the comparison
 * pages) are left out. This looks at the page source: text that comes from data or from a constant is not counted.
 */
const MAX_WORDS = 45;
const READING_PAGES = [/routes\/privacy\//, /routes\/terms\//, /routes\/compare\//];

function files(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return statSync(p).isDirectory() ? files(p) : p.endsWith('+page.svelte') ? [p] : [];
	});
}
const words = (html: string) => (html.replace(/\{[^}]*\}/g, ' ').replace(/<[^>]*>/g, ' ').replace(/&[a-z]+;/g, ' ').match(/[\p{L}\p{N}'’-]+/gu) ?? []).length;
const folded = (src: string, at: number) => {
	const before = src.slice(0, at);
	const opens = (before.match(/<(Explainer|details)\b/g) ?? []).length;
	const closes = (before.match(/<\/(Explainer|details)>/g) ?? []).length;
	return opens > closes;
};

describe('text density', () => {
	it('no page opens with a paragraph longer than a short sentence or two: the rest is folded away', () => {
		const long: string[] = [];
		for (const f of files('src/routes')) {
			if (READING_PAGES.some((re) => re.test(f))) continue;
			const src = readFileSync(f, 'utf8');
			for (const m of src.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/g)) {
				const n = words(m[1]);
				if (n > MAX_WORDS && !folded(src, m.index!)) long.push(`${f}: ${n} words: “${m[1].replace(/\s+/g, ' ').trim().slice(0, 70)}…”`);
			}
		}
		expect(long, `Fold these (use the Explainer component or a <details>) or shorten them to ${MAX_WORDS} words:\n${long.join('\n')}`).toEqual([]);
	});
	it('the Explainer shows one short sentence and folds the rest', () => {
		const e = readFileSync('src/lib/components/Explainer.svelte', 'utf8');
		expect(e).toMatch(/<details/);
		expect(e).toMatch(/<p>\{lead\}<\/p>/);
	});
	it('every Explainer lead is short', () => {
		for (const f of files('src/routes')) {
			const src = readFileSync(f, 'utf8');
			for (const m of src.matchAll(/<Explainer lead="([^"]*)"/g)) expect(words(m[1]), `${f}: ${m[1]}`).toBeLessThanOrEqual(32);
		}
	});
});
