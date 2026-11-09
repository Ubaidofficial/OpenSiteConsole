import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

const png = (p: string) => {
	const b = readFileSync(p);
	expect(b.subarray(0, 8).toString('hex'), p).toBe('89504e470d0a1a0a'); // a real PNG
	return { w: b.readUInt32BE(16), h: b.readUInt32BE(20), bytes: b.length };
};

describe('brand files', () => {
	const svgs = ['static/brand/logo-light.svg', 'static/brand/logo-dark.svg', 'static/brand/mark-light.svg', 'static/brand/mark-dark.svg', 'static/brand/mark-glyph.svg', 'static/favicon.svg'];
	it('every SVG is a self-contained drawing: right size, no script, no outside links, no fonts to go missing', () => {
		for (const f of svgs) {
			const s = readFileSync(f, 'utf8');
			expect(s.startsWith('<svg'), f).toBe(true);
			expect(s, f).toMatch(/viewBox="[\d. ]+"/);
			expect(s, f).not.toMatch(/<script|onload=|onclick=|<foreignObject|<image\b|<text\b|font-family/i);
			expect(s, f).not.toMatch(/(?:href|src)\s*=\s*"(?!#)/i); // a gradient may refer to #id, nothing else
			expect(s.length, f).toBeLessThan(4000);
		}
		for (const f of svgs.filter((x) => x !== 'static/brand/mark-glyph.svg')) expect(readFileSync(f, 'utf8'), f).toMatch(/viewBox="0 0 512 512"/);
	});
	it('the favicon is the simplified mark, so it stays crisp at 16 px', () => {
		expect(readFileSync('static/favicon.svg', 'utf8')).toBe(readFileSync('static/brand/mark-light.svg', 'utf8'));
	});
	it('the PNG icons are real images at their stated sizes, and actually drawn (not blank)', () => {
		const sizes: Record<string, number> = { 'static/favicon-32.png': 32, 'static/apple-touch-icon.png': 180, 'static/icon-192.png': 192, 'static/icon-512.png': 512, 'static/icon-512-maskable.png': 512 };
		for (const [f, n] of Object.entries(sizes)) {
			const p = png(f);
			expect([p.w, p.h], f).toEqual([n, n]);
			expect(p.bytes, `${f} looks blank`).toBeGreaterThan(n < 100 ? 400 : 1000);
		}
		expect(png('static/brand/banner.png')).toMatchObject({ w: 1920, h: 480 });
		// The two full-bleed icons must differ from the rounded one at the same size (they are drawn without the rounded tile).
		expect(readFileSync('static/icon-512.png').equals(readFileSync('static/icon-512-maskable.png'))).toBe(false);
	});
	it('favicon.ico holds 16, 32 and 48 px images, each a PNG', () => {
		const b = readFileSync('static/favicon.ico');
		expect([b.readUInt16LE(0), b.readUInt16LE(2), b.readUInt16LE(4)]).toEqual([0, 1, 3]); // reserved, type icon, three images
		const found: number[] = [];
		for (let i = 0; i < 3; i++) {
			const e = 6 + i * 16, size = b.readUInt32LE(e + 8), off = b.readUInt32LE(e + 12);
			expect(b.subarray(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a');
			expect(off + size).toBeLessThanOrEqual(b.length);
			found.push(b[e]);
		}
		expect(found).toEqual([16, 32, 48]);
	});
	it('the manifest is valid and every icon it names exists', () => {
		const m = JSON.parse(readFileSync('static/manifest.webmanifest', 'utf8')) as { name: string; icons: { src: string; sizes: string; type: string; purpose?: string }[] };
		expect(m.name).toBe('SEOConsole');
		expect(m.icons.length).toBeGreaterThanOrEqual(3);
		expect(m.icons.some((i) => i.purpose === 'maskable')).toBe(true);
		for (const i of m.icons) {
			expect(existsSync('static' + i.src), i.src).toBe(true);
			const n = Number(i.sizes.split('x')[0]);
			expect(png('static' + i.src).w, i.src).toBe(n);
		}
	});
	it('every page links the icons, and each link points at a file that exists', () => {
		const html = readFileSync('src/app.html', 'utf8');
		const hrefs = [...html.matchAll(/<link[^>]+rel="(?:icon|alternate icon|apple-touch-icon|manifest)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
		expect(hrefs.sort()).toEqual(['/apple-touch-icon.png', '/favicon-32.png', '/favicon.ico', '/favicon.svg', '/manifest.webmanifest']);
		for (const h of hrefs) expect(existsSync('static' + h), h).toBe(true);
		expect(html).toMatch(/<meta name="theme-color"/);
	});
	it('the app uses the brand: the header shows the glyph, the login page the full logo, and the old placeholder icon is gone', () => {
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		expect(layout).toMatch(/src="\/brand\/mark-glyph\.svg"/);
		expect(layout).not.toMatch(/<LayoutDashboard class="size-3\.5" \/>/);
		expect(readFileSync('src/routes/login/+page.svelte', 'utf8')).toMatch(/src="\/brand\/logo-light\.svg"/);
		for (const f of ['static/brand/mark-glyph.svg', 'static/brand/logo-light.svg']) expect(existsSync(f), f).toBe(true);
	});
	it('the README shows the banner and docs/brand.md documents every brand file', () => {
		expect(readFileSync('README.md', 'utf8')).toMatch(/<img src="static\/brand\/banner\.png" alt="SEOConsole"/);
		const md = readFileSync('docs/brand.md', 'utf8');
		for (const f of ['logo-light.svg', 'logo-dark.svg', 'mark-light.svg', 'mark-dark.svg', 'mark-glyph.svg', 'banner.png']) expect(md, f).toContain('`' + f);
	});
});
