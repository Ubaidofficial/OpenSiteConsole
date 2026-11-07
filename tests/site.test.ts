import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_READ_TOOL_NAMES, MCP_TOOL_NAMES, MCP_WRITE_TOOL_NAMES } from '../src/lib/server/mcp';

/** Static guards for the marketing site in site/: it must stay honest, self-contained, accessible and in step with the app. */
const html = readFileSync('site/index.html', 'utf8');
const css = readFileSync('site/assets/styles.css', 'utf8');
const js = readFileSync('site/assets/main.js', 'utf8');
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const REPO = 'https://github.com/Ubaidofficial/OpenSiteConsole';

describe('site: files and links', () => {
	it('every local file the page loads or links to exists', () => {
		const refs = new Set<string>();
		for (const m of html.matchAll(/\b(?:src|href)="(\/[^"#?]*)"/g)) refs.add(m[1]);
		for (const m of html.matchAll(/srcset="([^"]+)"/g)) for (const part of m[1].split(',')) refs.add(part.trim().split(/\s+/)[0]);
		for (const m of css.matchAll(/url\('?([^')]+)'?\)/g)) if (!m[1].startsWith('data:')) refs.add('/assets/' + m[1].replace(/^\//, ''));
		expect(refs.size).toBeGreaterThan(20);
		for (const r of refs) expect(existsSync('site' + r), r).toBe(true);
	});
	it('every in-page anchor points at an element that exists', () => {
		const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
		for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1]), m[1]).toBe(true);
		for (const m of html.matchAll(/aria-(?:controls|labelledby)="([^"]+)"/g)) expect(ids.has(m[1]), m[1]).toBe(true);
	});
	it('every image has an alt attribute and a size, so nothing jumps while loading', () => {
		for (const m of html.matchAll(/<img\b[^>]*>/g)) {
			expect(m[0], m[0].slice(0, 80)).toMatch(/\balt="/);
			expect(m[0], m[0].slice(0, 80)).toMatch(/\bwidth="\d+"/);
			expect(m[0], m[0].slice(0, 80)).toMatch(/\bheight="\d+"/);
		}
	});
	it('screenshots exist in both sizes and stay within a weight budget', () => {
		const shots = readdirSync('site/assets/shots').filter((f) => !f.includes('-1080'));
		expect(shots.length).toBeGreaterThanOrEqual(10);
		for (const f of shots) {
			expect(existsSync(`site/assets/shots/${f.replace('.webp', '-1080.webp')}`), f).toBe(true);
			expect(statSync(`site/assets/shots/${f}`).size, f).toBeLessThan(400_000);
		}
		const total = walk('site').reduce((n, f) => n + statSync(f).size, 0);
		expect(total).toBeLessThan(6_000_000);
	});
});

describe('site: self-contained and safe under a strict policy', () => {
	it('loads nothing from another origin: the only absolute links are the repository and its licence', () => {
		for (const m of html.matchAll(/<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="(https?:[^"]+)"/g)) {
			if (/rel="canonical"/.test(m[0])) continue;
			expect(m[1], m[0].slice(0, 80)).toBe('NOTHING EXTERNAL');
		}
		for (const m of html.matchAll(/<a\b[^>]*href="(https?:[^"]+)"/g)) expect(m[1].startsWith(REPO), m[1]).toBe(true);
		expect(css).not.toMatch(/url\(\s*['"]?https?:/);
		expect(css).not.toMatch(/@import/);
		expect(js).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|WebSocket|import\(/);
	});
	it('works under script-src and style-src \'self\': no inline handlers, inline styles or inline scripts', () => {
		expect(html).not.toMatch(/\son[a-z]+="/i);
		expect(html).not.toMatch(/\sstyle="/i);
		expect(html).not.toMatch(/javascript:/i);
		for (const m of html.matchAll(/<script\b([^>]*)>/g)) expect(m[1], m[0]).toMatch(/\bsrc="\/assets\/|type="application\/ld\+json"/);
		const conf = readFileSync('site/security-headers.conf', 'utf8');
		expect(conf).toMatch(/default-src 'self'/);
		expect(conf).toMatch(/script-src 'self'/);
		expect(conf).toMatch(/style-src 'self'/);
		expect(conf).not.toMatch(/unsafe-inline|unsafe-eval/);
		expect(conf).toMatch(/frame-ancestors 'none'/);
	});
	it('the nginx config includes the headers in every location (nginx drops inherited headers otherwise) and the Dockerfile ships every file the page needs', () => {
		const nginx = readFileSync('site/nginx.conf', 'utf8');
		expect((nginx.match(/include \/etc\/nginx\/security-headers\.conf;/g) ?? []).length).toBe(3); // the server and its two locations
		expect(nginx).toMatch(/listen 8080;/);
		expect(nginx).toMatch(/server_tokens off;/);
		const docker = readFileSync('site/Dockerfile', 'utf8');
		for (const f of ['index.html', 'robots.txt', 'sitemap.xml', 'favicon.svg', 'favicon.ico', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'assets', 'nginx.conf', 'security-headers.conf']) expect(docker, f).toContain(f);
		expect(docker).toMatch(/nginx-unprivileged/);
	});
});

describe('site: honest and in step with the app', () => {
	it('the tool counts on the page are the real ones, and the page never calls the server read-only without saying changes are opt-in', () => {
		const reads = MCP_READ_TOOL_NAMES.length, writes = MCP_WRITE_TOOL_NAMES.length;
		expect([reads, writes, MCP_TOOL_NAMES.length]).toEqual([33, 10, 43]);
		expect(html).toContain(`<b>${MCP_TOOL_NAMES.length}</b> MCP tools, read-only until you allow changes`);
		expect(html).toContain(`<b data-count="${reads}">${reads}</b><span>tools that read</span>`);
		expect(html).toContain(`<b>${writes}</b><span>that act, only if you allow it; none can delete</span>`);
		expect(html).toContain(`Your agent calls ${reads} tools that read your own stored data`);
		expect(html).toContain(`If you allow it, ${writes} more let it act on what it finds.`);
		expect(html).toContain(`The MCP server has ${reads} tools that read your stored search data, and ${writes} that can change things`);
		// the ten that change things are named in the FAQ so a reader knows what "change" means, and none of them deletes
		for (const phrase of ['mark a finding done', 'log a change', 'start a test', 'send URLs to Bing through IndexNow', 'submit a sitemap']) expect(html).toContain(phrase);
		expect(html).toContain('None can delete data, connect accounts, or touch keys and passwords');
		// stale claims from when the server could only read
		for (const stale of [/\b29\b/, /read-only MCP (server|tools)/i, /No writes/, /agents cannot change/i, /An agent cannot change/i]) expect(html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, (m) => m), String(stale)).not.toMatch(stale);
		const named = [...html.matchAll(/<b>(get_[a-z_]+)<\/b>/g)].map((m) => m[1]);
		expect(named.length).toBeGreaterThanOrEqual(2);
		for (const n of named) expect(MCP_TOOL_NAMES, n).toContain(n);
	});
	it('claims no customers, testimonials or ratings, because there are none', () => {
		const text = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
		for (const bad of [/testimonial/i, /trusted by/i, /customers? (love|say)/i, /\bused by \d/i, /\d[\d,]*\+? (teams|brands|marketers|customers|users)\b/i, /★|⭐/, /rated \d/i, /case stud/i, /as seen/i]) expect(text, String(bad)).not.toMatch(bad);
	});
	it('the hosted plan is labelled as planned, never as available', () => {
		const plans = html.slice(html.indexOf('id="self-host"'), html.indexOf('id="faq"'));
		expect(plans).toMatch(/Hosted <em>planned<\/em>/);
		expect(plans).toMatch(/<b>not open yet<\/b>/);
		expect(plans).not.toMatch(/It is built|is live|available now|launch(ed)? (today|now)/i);
		expect(html).not.toMatch(/(start|sign up|subscribe|buy|get) (the |your )?(hosted|cloud)/i);
	});
	it('the conversation demo says what is real and what is an example', () => {
		expect(html).toMatch(/Tool names and results come from the demo dataset\. The assistant’s wording is an example\./);
		expect(html).toMatch(/Screenshots in this page are the real app running on its built-in demo data\./);
		expect(html).toMatch(/Illustration, not real data\./);
	});
	it('every FAQ question is in the structured data too, and the structured data is valid JSON', () => {
		const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
		expect(blocks.map((b) => b['@type'])).toEqual(['SoftwareApplication', 'FAQPage']);
		const questions = blocks[1].mainEntity.map((q: { name: string }) => q.name);
		const visible = [...html.matchAll(/<summary>([^<]+)<\/summary>/g)].map((m) => m[1]);
		expect(questions.length).toBe(visible.length);
		for (const q of questions) expect(visible, q).toContain(q);
		expect(blocks[0].offers.price).toBe('0');
		expect(blocks[0].codeRepository).toBe(REPO);
	});
	it('the canonical address is the same everywhere it is stated', () => {
		const sm = readFileSync('site/sitemap.xml', 'utf8'), rb = readFileSync('site/robots.txt', 'utf8');
		expect(html).toMatch(/<link rel="canonical" href="https:\/\/seoconsole\.app\/">/);
		expect(html).toMatch(/og:url" content="https:\/\/seoconsole\.app\/"/);
		expect(sm).toContain('<loc>https://seoconsole.app/</loc>');
		expect(rb).toContain('Sitemap: https://seoconsole.app/sitemap.xml');
		expect(existsSync('site/assets/og.png')).toBe(true);
	});
});

describe('site: light mode only, and gentle on people who ask for less motion', () => {
	it('declares itself light and has no dark scheme', () => {
		expect(html).toMatch(/<meta name="color-scheme" content="light">/);
		expect(css).toMatch(/color-scheme: light;/);
		expect(css).not.toMatch(/prefers-color-scheme:\s*dark/);
		expect(css).toMatch(/--bg: #fafaf9/);
	});
	it('the text colours keep at least 4.5:1 contrast on the page background and on cards', () => {
		const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
		const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
		const v = (name: string) => new RegExp(`--${name}: (#[0-9a-f]{6})`).exec(css)![1];
		for (const fg of ['fg', 'mut', 'dim', 'acc-ink', 'bad']) for (const bg of ['bg', 'card', 'bg2']) expect(ratio(v(fg), v(bg)), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
		expect(ratio(v('acc-deep'), v('acc'))).toBeGreaterThanOrEqual(4.5); // the dark text on the lime panel
	});
	it('the headline reveal mask leaves room for descenders, so the g in "agents" is not cut off', () => {
		const pad = /\.ln \{[^}]*padding-bottom: ([\d.]+)em/.exec(css);
		expect(pad).toBeTruthy();
		expect(Number(pad![1])).toBeGreaterThanOrEqual(0.2);
	});
	it('every animation and scroll effect has a reduced-motion fallback that shows the final state', () => {
		const block = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
		expect(block).toBeTruthy();
		for (const sel of ['.w {', '.hl::before', 'html.js .rv', '.track', '.stack', '.frame', '.term.live .t-line', '.tl-svg .line', '.hud-row']) expect(block, sel).toContain(sel);
		expect(js).toMatch(/prefers-reduced-motion: reduce/);
		expect(js).toMatch(/still/);
	});
	it('without JavaScript the page is complete: content is hidden only once the script has marked the page', () => {
		const hidden = css.split('\n').filter((l) => /\.rv\b[^{]*\{[^}]*opacity: 0/.test(l));
		expect(hidden.length).toBeGreaterThan(0);
		for (const l of hidden) expect(l.trim().startsWith('html.js'), l.slice(0, 60)).toBe(true);
		expect(readFileSync('site/assets/boot.js', 'utf8')).toMatch(/classList\.add\('js'\)/);
		expect(css).not.toMatch(/\.term\s*\{[^}]*opacity: 0/); // the transcript is only hidden under .live, which the script adds
		expect(html).toMatch(/<details>/); // the FAQ opens without scripts
	});
});
