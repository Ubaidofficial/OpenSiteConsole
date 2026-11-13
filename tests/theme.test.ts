import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The dim dark theme is plain CSS variables in src/app.css (class="dark" on <html>). These tests read that file, so a later edit cannot
 * quietly make text unreadable or leave a colour behind in the light palette.
 */
const css = readFileSync('src/app.css', 'utf8');
const block = (selector: string) => {
	const start = css.indexOf(`${selector} {`);
	expect(start, `${selector} block`).toBeGreaterThan(-1);
	const body = css.slice(css.indexOf('{', start) + 1, css.indexOf('\n}', start));
	return Object.fromEntries([...body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
};
const light = block(':root');
const dim = block('.dark');

// oklch / #rrggbb -> linear sRGB -> relative luminance (WCAG)
function linear(value: string): [number, number, number] {
	const hex = /^#([0-9a-f]{6})$/i.exec(value);
	if (hex) {
		const v = [0, 2, 4].map((i) => parseInt(hex[1].slice(i, i + 2), 16) / 255);
		return v.map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4)) as [number, number, number];
	}
	const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value);
	if (!m) throw new Error(`cannot read colour: ${value}`);
	const [L, C, h] = [Number(m[1]), Number(m[2]), (Number(m[3]) * Math.PI) / 180];
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const clamp = (x: number) => Math.max(0, Math.min(1, x));
	return [clamp(4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s), clamp(-1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s), clamp(-0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s)];
}
const luminance = (c: [number, number, number]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const contrast = (a: string, b: string) => {
	const [x, y] = [luminance(linear(a)), luminance(linear(b))];
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

describe('the dim dark theme', () => {
	const surfaces = ['background', 'card', 'popover', 'muted', 'accent', 'secondary'];
	it('keeps every text colour at 4.5:1 (WCAG AA) or better on every surface', () => {
		for (const text of ['foreground', 'muted-foreground', 'link', 'good', 'warn', 'destructive']) {
			for (const surface of surfaces) expect(contrast(dim[text], dim[surface]), `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
		}
		expect(contrast(dim['primary-foreground'], dim.primary), 'button text').toBeGreaterThanOrEqual(4.5);
		expect(contrast(dim['card-foreground'], dim.card)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(dim['popover-foreground'], dim.popover)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(dim['secondary-foreground'], dim.secondary)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(dim['accent-foreground'], dim.accent)).toBeGreaterThanOrEqual(4.5);
	});
	it('keeps chart series and status colours at 3.5:1 (graphics need 3:1) against the card, and the ink printed on the ranked steps readable', () => {
		for (const c of ['chart-1', 'chart-2', 'chart-3', 'st-good', 'st-warn', 'st-serious', 'st-bad']) expect(contrast(dim[c], dim.card), c).toBeGreaterThanOrEqual(3.5);
		for (const [step, ink] of [['ord-1', 'ord-ink-1'], ['ord-2', 'ord-ink-2'], ['ord-3', 'ord-ink-3'], ['ord-4', 'ord-ink-4']]) expect(contrast(dim[step], dim[ink]), `${ink} on ${step}`).toBeGreaterThanOrEqual(4.4);
	});
	it('is dim, not black: the page is a slate between 0.2 and 0.3 lightness, and the text is not pure white', () => {
		const lightness = (v: string) => Number(/oklch\(\s*([\d.]+)/.exec(v)![1]);
		expect(lightness(dim.background)).toBeGreaterThan(0.2);
		expect(lightness(dim.background)).toBeLessThan(0.3);
		expect(lightness(dim.foreground)).toBeLessThan(0.97);
		expect(lightness(dim.card)).toBeGreaterThan(lightness(dim.background)); // cards sit above the page
	});
	it('defines every colour the light theme does, so nothing is left behind in the light palette', () => {
		const lightOnly = Object.keys(light).filter((k) => !(k in dim) && k !== 'radius');
		expect(lightOnly).toEqual([...lightOnly].filter((k) => ['bad', 'c-clicks', 'c-impr', 'c-pos'].includes(k))); // these are aliases (var(--…)) that follow their sources
		for (const k of lightOnly) expect(light[k], k).toMatch(/^var\(/);
	});
	it('tells the browser it is dark (form controls and scrollbars follow)', () => {
		expect(css).toMatch(/\.dark \{\s*color-scheme: dark;/);
		expect(css).toMatch(/:root \{\s*color-scheme: light;/);
	});
});

describe('switching themes', () => {
	const html = readFileSync('src/app.html', 'utf8');
	it('applies the saved theme before first paint, inside the script that already carries the CSP nonce', () => {
		expect(html).toMatch(/<script nonce="%sveltekit\.nonce%">[\s\S]*osc_theme[\s\S]*classList\.add\('dark'\)[\s\S]*<\/script>/);
		expect(html.match(/<script/g)).toHaveLength(1); // no second, un-nonced inline script
		expect(html).toContain("localStorage.getItem('osc_theme') === 'dim'");
	});
	it('light is the default: nothing but an explicit choice turns it on', () => {
		expect(html).not.toMatch(/prefers-color-scheme/);
		expect(readFileSync('src/lib/theme.svelte.ts', 'utf8')).toContain("localStorage.getItem('osc_theme') === 'dim'");
	});
	it('has a labelled toggle in the header, and the toaster follows the theme', () => {
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		expect(layout).toContain('<ThemeToggle />');
		expect(layout).toContain("theme={theme.dim ? 'dark' : 'light'}");
		const toggle = readFileSync('src/lib/components/theme-toggle.svelte', 'utf8');
		expect(toggle).toContain('aria-label={label}');
		expect(toggle).toContain('aria-pressed={theme.dim}');
	});
	it('swaps the logo marks that only suit a light page, and inverts the black-only product logos', () => {
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		expect(layout).toContain('/brand/mark-dark.svg');
		for (const f of ['src/routes/login/+page.svelte', 'src/routes/reset/[token]/+page.svelte', 'src/routes/invite/[token]/+page.svelte']) expect(readFileSync(f, 'utf8'), f).toContain('/brand/logo-dark.svg');
		for (const logo of ['mcp', 'openai', 'cursor', 'windsurf']) expect(css).toContain(`img[src$='/logos/${logo}.svg']`);
	});
});
