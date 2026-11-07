import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Static guards for the accessibility and layout problems an automated scan (axe) and a narrow-screen crawl found.
 * They cannot replace those scans, but they stop the same mistakes from coming back unnoticed.
 */
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const svelte = walk('src').filter((f) => f.endsWith('.svelte')).map((f) => ({ f, lines: readFileSync(f, 'utf8').split('\n') }));
const hits = (re: RegExp, ok: (line: string, i: number, lines: string[]) => boolean) =>
	svelte.flatMap(({ f, lines }) => lines.flatMap((l, i) => (re.test(l) && !ok(l, i, lines) ? [`${f}:${i + 1}`] : [])));

describe('accessibility and layout guards', () => {
	it('hidden header text sits in a positioned cell, or it escapes the scroll box and widens the page on phones', () => {
		expect(hits(/<th\b[^>]*>(?:\s*\{#if[^}]*\})?[^<]*<span class="sr-only"/, (l) => /<th\b[^>]*class="[^"]*\brelative\b/.test(l) || /<th\b[^>]*class="[^"]*\brelative\b/.test(l.slice(0, l.indexOf('sr-only'))))).toEqual([]);
	});
	it('every select has a name: an aria-label, or a label around it', () => {
		// "around it" is checked by looking back a few lines for a <label> that has not been closed again before the <select>.
		const insideLabel = (l: string, i: number, lines: string[]) => {
			const before = [...lines.slice(Math.max(0, i - 3), i), l.slice(0, l.indexOf('<select'))].join('\n');
			return before.lastIndexOf('<label') > before.lastIndexOf('</label>');
		};
		expect(hits(/<select\b/, (l, i, lines) => /aria-label=/.test(l) || insideLabel(l, i, lines))).toEqual([]);
	});
	it('scrollable code blocks can be reached with the keyboard', () => {
		expect(hits(/<pre\b[^>]*overflow-x-auto/, (l) => /tabindex="0"/.test(l))).toEqual([]);
	});
	it('fixed-layout tables sit inside a horizontal scroll box', () => {
		expect(hits(/<table\b[^>]*table-fixed/, (_l, i, lines) => lines.slice(Math.max(0, i - 3), i).some((x) => /overflow-x-auto/.test(x)))).toEqual([]);
	});
	it('the warning colour is dark enough for small text (contrast of at least 4.5:1 on white and on the page background)', () => {
		const css = readFileSync('src/app.css', 'utf8');
		const root = css.slice(css.indexOf(':root {'), css.indexOf('\n}', css.indexOf(':root {'))); // the light theme, the only one the app uses
		const m = /--warn:\s*oklch\(([\d.]+)\s+([\d.]+)\s+([\d.]+)\)/.exec(root);
		expect(m).not.toBeNull();
		const [L, C, h] = [Number(m![1]), Number(m![2]), Number(m![3])];
		const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
		const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3, mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3, s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
		const rgb = [4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s].map((x) => Math.max(0, Math.min(1, x)));
		const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
		const pageBg = 0.985 ** 3; // the page background is neutral, so its relative luminance is just its lightness cubed
		expect(1.05 / (lum + 0.05)).toBeGreaterThanOrEqual(4.5);
		expect((pageBg + 0.05) / (lum + 0.05)).toBeGreaterThanOrEqual(4.5);
	});
});
