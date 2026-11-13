import { beforeEach, describe, expect, it } from 'vitest';
import { _clearIconCache, iconCandidates, siteIcon, sniffIcon } from '../src/lib/server/siteicon';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>');
const ICO = Buffer.from([0, 0, 1, 0, 1, 0, 16, 16, 0, 0]);

/** A fake site: path -> [status, content-type, body]. Records every URL asked for. */
function fakeSite(files: Record<string, [number, string, Buffer | string]>) {
	const asked: string[] = [];
	const impl = (async (input: RequestInfo | URL) => {
		const u = new URL(String(input));
		asked.push(u.href);
		const f = files[u.href];
		if (!f) return new Response('nope', { status: 404, headers: { 'content-type': 'text/plain' } });
		return new Response(typeof f[2] === 'string' ? f[2] : new Uint8Array(f[2]), { status: f[0], headers: { 'content-type': f[1] } });
	}) as typeof fetch;
	return { impl, asked };
}
const page = (links: string) => [200, 'text/html', `<html><head>${links}</head><body>hi</body></html>`] as [number, string, string];

beforeEach(() => _clearIconCache());

describe('icon candidates', () => {
	it('ranks SVG first, then the largest PNG, then the rest, resolving relative links', () => {
		const html = `<link rel="icon" href="/small.png" sizes="16x16" type="image/png"><link rel="shortcut icon" href="legacy.ico">
			<link rel="icon" href="/big.png" sizes="192x192"><link rel="icon" type="image/svg+xml" href="/logo.svg"><link rel="apple-touch-icon" href="/apple.png"><link rel="mask-icon" href="/mask.svg"><link rel="stylesheet" href="/x.css">`;
		expect(iconCandidates(html, 'https://example.com/blog/').map((c) => c.href)).toEqual([
			'https://example.com/logo.svg', 'https://example.com/big.png', 'https://example.com/small.png', 'https://example.com/blog/legacy.ico'
		]);
	});
	it('handles single quotes, unquoted values and attribute order, and ignores data: URLs', () => {
		const html = `<link href='/a.png' rel='icon'><link href=/b.png rel=icon><link rel="icon" href="data:image/png;base64,AAAA">`;
		expect(iconCandidates(html, 'https://example.com/').map((c) => c.href).sort()).toEqual(['https://example.com/a.png', 'https://example.com/b.png']);
	});
});

describe('byte sniffing', () => {
	it('knows the real format from the first bytes, not from what the site claims', () => {
		expect(sniffIcon(PNG)).toBe('image/png');
		expect(sniffIcon(ICO)).toBe('image/x-icon');
		expect(sniffIcon(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('image/jpeg');
		expect(sniffIcon(Buffer.from('GIF89a....'))).toBe('image/gif');
		expect(sniffIcon(SVG)).toBe('image/svg+xml');
		expect(sniffIcon(Buffer.from('<?xml version="1.0"?>\n<!-- c -->\n' + SVG))).toBe('image/svg+xml');
	});
	it('refuses HTML, text and empty files', () => {
		expect(sniffIcon(Buffer.from('<!doctype html><html></html>'))).toBeNull();
		expect(sniffIcon(Buffer.from('plain text'))).toBeNull();
		expect(sniffIcon(Buffer.alloc(0))).toBeNull();
	});
	it('refuses an SVG that could run script or load something', () => {
		for (const bad of [
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.example/x.png"/></svg>',
			'<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
			'<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg"/>'
		]) expect(sniffIcon(Buffer.from(bad)), bad).toBeNull();
		// a local reference such as a gradient is fine
		expect(sniffIcon(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/></svg>'))).toBe('image/svg+xml');
	});
});

describe('fetching a site icon', () => {
	it('uses the icon the home page links to', async () => {
		const s = fakeSite({ 'https://example.com/': page('<link rel="icon" href="/logo.svg">'), 'https://example.com/logo.svg': [200, 'image/svg+xml', SVG] });
		const icon = await siteIcon('https://example.com/', { fetchImpl: s.impl });
		expect(icon?.type).toBe('image/svg+xml');
		expect(s.asked).toEqual(['https://example.com/', 'https://example.com/logo.svg']);
	});
	it('works for a Search Console domain property', async () => {
		const s = fakeSite({ 'https://example.com/': page('<link rel="icon" href="/i.png">'), 'https://example.com/i.png': [200, 'image/png', PNG] });
		expect((await siteIcon('sc-domain:example.com', { fetchImpl: s.impl }))?.type).toBe('image/png');
	});
	it('falls back to /favicon.ico when the page links no usable icon', async () => {
		const s = fakeSite({ 'https://example.com/': page(''), 'https://example.com/favicon.ico': [200, 'image/x-icon', ICO] });
		expect((await siteIcon('https://example.com/', { fetchImpl: s.impl }))?.type).toBe('image/x-icon');
	});
	it('skips a linked icon that is really HTML (a soft 404) and tries the next', async () => {
		const s = fakeSite({
			'https://example.com/': page('<link rel="icon" href="/logo.svg"><link rel="icon" href="/b.png" type="image/png">'),
			'https://example.com/logo.svg': [200, 'image/svg+xml', '<!doctype html><title>Not found</title>'],
			'https://example.com/b.png': [200, 'image/png', PNG]
		});
		expect((await siteIcon('https://example.com/', { fetchImpl: s.impl }))?.type).toBe('image/png');
	});
	it('never fetches an icon from another host (a CDN): that is the privacy rule', async () => {
		const s = fakeSite({ 'https://example.com/': page('<link rel="icon" href="https://cdn.other.net/logo.png">'), 'https://cdn.other.net/logo.png': [200, 'image/png', PNG] });
		expect(await siteIcon('https://example.com/', { fetchImpl: s.impl })).toBeNull();
		expect(s.asked.some((u) => u.includes('cdn.other.net'))).toBe(false);
	});
	it('does not follow a redirect off the site', async () => {
		const impl = (async (input: RequestInfo | URL) => {
			const u = new URL(String(input));
			if (u.host === 'example.com' && u.pathname === '/') return new Response(page('')[2], { status: 200, headers: { 'content-type': 'text/html' } });
			if (u.host === 'example.com') return new Response(null, { status: 302, headers: { location: 'https://evil.example/f.ico' } });
			return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } });
		}) as typeof fetch;
		expect(await siteIcon('https://example.com/', { fetchImpl: impl })).toBeNull();
	});
	it('rejects an unsafe SVG and a site with nothing', async () => {
		const evil = fakeSite({ 'https://example.com/': page('<link rel="icon" href="/l.svg">'), 'https://example.com/l.svg': [200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'] });
		expect(await siteIcon('https://example.com/', { fetchImpl: evil.impl })).toBeNull();
		_clearIconCache();
		expect(await siteIcon('https://empty.example/', { fetchImpl: fakeSite({}).impl })).toBeNull();
	});
	it('caches a hit for a week and a miss for an hour, and shares one in-flight fetch', async () => {
		const s = fakeSite({ 'https://example.com/': page('<link rel="icon" href="/i.png">'), 'https://example.com/i.png': [200, 'image/png', PNG] });
		const t0 = 1_000_000_000_000;
		const [a, b] = await Promise.all([siteIcon('https://example.com/', { fetchImpl: s.impl, now: t0 }), siteIcon('https://example.com/', { fetchImpl: s.impl, now: t0 })]);
		expect(a).toBe(b);
		expect(s.asked.length).toBe(2); // the page and the icon, once
		await siteIcon('https://example.com/', { fetchImpl: s.impl, now: t0 + 6 * 24 * 3600_000 });
		expect(s.asked.length).toBe(2);
		await siteIcon('https://example.com/', { fetchImpl: s.impl, now: t0 + 8 * 24 * 3600_000 });
		expect(s.asked.length).toBe(4);

		const miss = fakeSite({});
		await siteIcon('https://none.example/', { fetchImpl: miss.impl, now: t0 });
		const n = miss.asked.length;
		await siteIcon('https://none.example/', { fetchImpl: miss.impl, now: t0 + 30 * 60_000 });
		expect(miss.asked.length).toBe(n);
		await siteIcon('https://none.example/', { fetchImpl: miss.impl, now: t0 + 61 * 60_000 });
		expect(miss.asked.length).toBeGreaterThan(n);
	});
});

describe('the icon endpoint', () => {
	it('is off when SITE_ICONS=0', async () => {
		process.env.SITE_ICONS = '0';
		try {
			const s = fakeSite({ 'https://example.com/': page('<link rel="icon" href="/i.png">'), 'https://example.com/i.png': [200, 'image/png', PNG] });
			expect(await siteIcon('https://example.com/', { fetchImpl: s.impl })).toBeNull();
			expect(s.asked).toEqual([]);
		} finally {
			delete process.env.SITE_ICONS;
		}
	});
});
