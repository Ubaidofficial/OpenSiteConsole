import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { crawlInfo, crawlLinks, crawledPages, groupByTarget, linkReport, linkTargets, setLinkDone } from '../src/lib/server/internallinks';
import { actionsFor } from '../src/lib/server/actions';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, MCP_READ_TOOL_NAMES, resetRateLimits } from '../src/lib/server/mcp';
import { authority, extractPage, findMention, orphanPages, resolveLink, sentenceAround, suggestLinks, suggestionScore, type LinkTarget, type SourcePage } from '../src/lib/linking';

// ── reading a page ───────────────────────────────────────────────────────────

describe('link extraction and resolution', () => {
	const page = 'https://www.example.com/blog/post?x=1';
	it('resolves relative, root-relative and absolute links, keeps the query, drops the fragment, and keeps only this host (www ignored)', () => {
		expect(resolveLink('other', page)).toBe('https://www.example.com/blog/other');
		expect(resolveLink('../shop/', page)).toBe('https://www.example.com/shop/');
		expect(resolveLink('/a?b=1#c', page)).toBe('https://www.example.com/a?b=1');
		expect(resolveLink('https://example.com/x', page)).toBe('https://example.com/x');
		expect(resolveLink('//www.example.com/y', page)).toBe('https://www.example.com/y');
		for (const off of ['https://other.com/', 'https://blog.example.com/', 'mailto:a@example.com', 'tel:123', 'javascript:void(0)', '#top', '', null, 'http://[bad']) expect(resolveLink(off as string, page), String(off)).toBeNull();
	});
	it('reads title, H1, the main text without menus, scripts or headings, and every same-site link with its anchor text', () => {
		const html = `<!doctype html><html><head><title>Garden &amp; Tools</title><script>var x = "<a href='/no'>no</a>";</script><style>p{}</style></head>
		<body><header><nav><a href="/">Home</a><a href="/guides">Guides</a></nav></header>
		<main><h1>Best <em>garden</em> tools</h1><h2>Pruning shears</h2>
		<p>Good <b>pruning shears</b> last for years. See <a href="/shears#buy" rel="nofollow">our shear guide</a>.</p>
		<!-- <a href="/commented">x</a> -->
		<ul><li>Spades</li><li>Rakes, <a href="https://elsewhere.org/">elsewhere</a></li></ul>
		<form><label>Search the shop</label><button>Go</button></form>
		<a href="/img-link"><img src="a.png" alt="A picture link"></a></main>
		<footer>Copyright <a href="mailto:me@example.com">mail</a> <a href="/about">About us</a></footer></body></html>`;
		const x = extractPage(html, 'https://example.com/page');
		expect(x.title).toBe('Garden & Tools');
		expect(x.h1).toBe('Best garden tools');
		expect(x.text.split('\n')).toEqual(['Good pruning shears last for years. See our shear guide.', 'Spades', 'Rakes, elsewhere']);
		expect(x.text).not.toMatch(/Home|Guides|Copyright|Search the shop|Pruning shears\n/);
		expect(x.links).toEqual([
			{ url: 'https://example.com/', anchor: 'Home', chrome: true },
			{ url: 'https://example.com/guides', anchor: 'Guides', chrome: true },
			{ url: 'https://example.com/shears', anchor: 'our shear guide', chrome: false },
			{ url: 'https://example.com/img-link', anchor: 'A picture link', chrome: false },
			{ url: 'https://example.com/about', anchor: 'About us', chrome: true }
		]);
	});
	it('without a <main>, reads the body minus the site-wide parts; honours <base href>', () => {
		const x = extractPage('<html><head><base href="https://example.com/docs/"></head><body><nav>Menu <a href="a">A</a></nav><div>Body text here.</div><aside>Side</aside><p>More <a href="b">B</a></p></body></html>', 'https://example.com/x/y');
		expect(x.text).toBe('Body text here.\nMore B');
		expect(x.links.map((l) => l.url)).toEqual(['https://example.com/docs/a', 'https://example.com/docs/b']);
	});
	it('a hostile page costs time in proportion to its size', () => {
		const t = Date.now();
		extractPage('<p'.repeat(300_000) + '<a href="/x">' + '<'.repeat(300_000), 'https://example.com/');
		extractPage('<a href="/x">'.repeat(50_000), 'https://example.com/');
		expect(Date.now() - t).toBeLessThan(3000);
	});
});

// ── finding a query in text ──────────────────────────────────────────────────

describe('text matching', () => {
	it('finds the phrase in any case and returns it as the page writes it, with its sentence', () => {
		const m = findMention('Intro line.\nWe love them. Our Garden Tools last for years! Other stuff.', 'garden tools');
		expect(m).toEqual({ kind: 'exact', anchor: 'Garden Tools', snippet: 'Our Garden Tools last for years!' });
	});
	it('matches whole words only', () => {
		expect(findMention('Our gardentools and regarden tools-ish.', 'garden tools')).toBeNull();
		expect(findMention('The cart is here.', 'car')).toBeNull();
		expect(findMention('A car is here.', 'car')?.anchor).toBe('car');
	});
	it('folds a plural and joins words across a hyphen, but not across punctuation', () => {
		expect(findMention('Buy a garden tool today.', 'garden tools')?.anchor).toBe('garden tool');
		expect(findMention('Some garden-tools here.', 'garden tools')?.anchor).toBe('garden-tools');
		expect(findMention('I love my garden. Tools are fine.', 'garden tools')).toBeNull();
	});
	it('falls back to all the main words close together in one sentence, never across sentences or for one-word queries', () => {
		const m = findMention('Choosing tools for a small garden is easy.', 'small garden tools');
		expect(m?.kind).toBe('words');
		expect(m?.anchor).toBe('tools for a small garden');
		expect(findMention('We sell tools. Our garden is small.', 'small garden tools')).toBeNull();
		expect(findMention('tools are listed far away from the place where we talk about the small garden', 'small garden tools')).toBeNull();
		expect(findMention('Tools for the garden.', 'garden tools')?.anchor).toBe('Tools for the garden'); // all its words, reordered
		expect(findMention('Our garden tools section.', 'what is garden tools')).toBeNull(); // only two main words left: the topic, not the search
		expect(findMention('Sharpen them well.', 'how to sharpen')).toBeNull(); // one meaningful word: the exact phrase or nothing
		expect(findMention('Learn how to sharpen them.', 'how to sharpen')?.anchor).toBe('how to sharpen');
	});
	it('prefers the exact phrase anywhere over a loose match earlier in the text', () => {
		expect(findMention('Tools for a small garden.\nThe best small garden tools.', 'small garden tools')).toMatchObject({ kind: 'exact', anchor: 'small garden tools' });
	});
	it('skips a phrase that is already a link on the page', () => {
		expect(findMention('See garden tools here. Also Garden Tools there.', 'garden tools', new Set(['garden tools']))).toBeNull();
	});
	it('shortens a long sentence around the anchor', () => {
		const line = 'word '.repeat(80) + 'garden tools ' + 'word '.repeat(80);
		const s = sentenceAround(line, line.indexOf('garden'), line.indexOf('garden') + 12, 100);
		expect(s.length).toBeLessThanOrEqual(102);
		expect(s).toContain('garden tools');
		expect(s.startsWith('…') && s.endsWith('…')).toBe(true);
	});
});

// ── pairing and scoring ──────────────────────────────────────────────────────

const src = (url: string, text: string, links: string[] = [], clicks = 0, impressions = 0): SourcePage => ({ url, finalUrl: url, text, links: links.map((u) => ({ url: u, anchor: 'x', chrome: false })), clicks, impressions });
const target = (page: string, query: string, prize: number): LinkTarget => ({ page, prize, queries: [{ query, position: 9, impressions: 500, clicks: 5, prize }] });

describe('suggestions', () => {
	const T = 'https://example.com/tools';
	it('excludes the target itself and pages that already link to it (any URL spelling)', () => {
		const out = suggestLinks([target(T, 'garden tools', 50)], [
			src(T, 'All about garden tools.'),
			src('https://example.com/a', 'Our garden tools rock.', ['https://www.example.com/tools/']),
			src('https://example.com/b', 'Our garden tools rock.'),
			src('https://example.com/c', 'Nothing relevant here.')
		]);
		expect(out.map((s) => s.source)).toEqual(['https://example.com/b']);
		expect(out[0]).toMatchObject({ target: T, anchor: 'garden tools', query: 'garden tools', match: 'exact', snippet: 'Our garden tools rock.', prize: 50, key: 'example.com/b>example.com/tools' });
	});
	it('a page that redirects to the target counts as the target', () => {
		const out = suggestLinks([{ ...target(T, 'garden tools', 50), aliases: ['https://example.com/tools-new'] }], [{ ...src('https://example.com/old', 'garden tools'), finalUrl: 'https://example.com/tools-new' }, src('https://example.com/b', 'garden tools', ['https://example.com/tools-new'])]);
		expect(out).toEqual([]);
	});
	it('orders by prize x match x the linking page\'s traffic', () => {
		expect(authority(0, 0)).toBe(1);
		expect(authority(100, 10_000)).toBeGreaterThan(authority(10, 10_000));
		expect(suggestionScore({ prize: 10, match: 'exact', sourceClicks: 0, sourceImpressions: 0 })).toBeGreaterThan(suggestionScore({ prize: 10, match: 'words', sourceClicks: 0, sourceImpressions: 0 }));
		const out = suggestLinks([target(T, 'garden tools', 10), target('https://example.com/big', 'lawn mowers', 100)], [
			src('https://example.com/weak', 'garden tools and lawn mowers', [], 0, 0),
			src('https://example.com/strong', 'garden tools here', [], 500, 50_000),
			src('https://example.com/loose', 'tools for the garden', [], 500, 50_000)
		]);
		expect(out.map((s) => `${s.source.slice(20)}>${s.target.slice(20)}`)).toEqual(['weak>big', 'strong>tools', 'loose>tools', 'weak>tools']);
		const scores = out.map((s) => s.score);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
		expect(out.find((s) => s.source.endsWith('loose'))!.match).toBe('words');
	});
	it('one suggestion per source and target (its best search), and at most perTarget per target', () => {
		const t: LinkTarget = { page: T, prize: 60, queries: [{ query: 'garden tools', position: 8, impressions: 1, clicks: 0, prize: 10 }, { query: 'pruning shears', position: 12, impressions: 1, clicks: 0, prize: 50 }] };
		const sources = Array.from({ length: 8 }, (_, i) => src(`https://example.com/p${i}`, 'garden tools and pruning shears', [], i));
		const out = suggestLinks([t], sources, { perTarget: 3 });
		expect(out).toHaveLength(3);
		expect(out.every((s) => s.query === 'pruning shears')).toBe(true);
		expect(out.map((s) => s.source)).toEqual(['https://example.com/p7', 'https://example.com/p6', 'https://example.com/p5']);
	});
	it('orphans: pages with impressions no other crawled page links to (self-links and the home page do not count)', () => {
		const pages = [{ page: 'https://example.com/', impressions: 900 }, { page: 'https://example.com/a', impressions: 10 }, { page: 'https://example.com/b', impressions: 50 }, { page: 'https://example.com/c', impressions: 30 }];
		const o = orphanPages(pages, [src('https://example.com/a', '', ['https://example.com/a', 'https://example.com/c/']), src('https://example.com/b', '', ['https://example.com/b'])]);
		expect(o.map((p) => p.page)).toEqual(['https://example.com/b', 'https://example.com/a']);
	});
});

// ── end to end on demo data ──────────────────────────────────────────────────

describe('internal links on demo data', () => {
	let key = '';
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
		key = createApiKey('reader', null).key;
	}, 120_000);
	const site = () => getSite(1)!;

	it('before a crawl there is nothing to suggest and the MCP tool says how to start one', async () => {
		expect(crawlInfo(1)).toBeNull();
		expect(linkReport(site()).suggestions).toEqual([]);
		const r = await mcp('get_internal_link_suggestions', { site: '1' });
		expect(r.crawled).toBe(0);
		expect(r.hint).toMatch(/Crawl now/);
	});
	it('the crawl fetches the pages Search Console shows, four at a time, through the demo fetcher, and stores text and links', async () => {
		let inFlight = 0;
		let most = 0;
		const { demoPageFetch } = await import('../src/lib/server/demo-channels');
		const demo = demoPageFetch(site().site_url);
		const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
			inFlight++;
			most = Math.max(most, inFlight);
			await new Promise((r) => setTimeout(r, 5));
			inFlight--;
			return demo(u, init);
		}) as typeof fetch;
		const r = await crawlLinks(1, { fetchImpl, max: 60 });
		expect(r.pages).toBeGreaterThan(5);
		expect(r.pages).toBeLessThanOrEqual(60);
		expect(most).toBe(4);
		expect(r.ok + r.failed).toBe(r.pages);
		const pages = crawledPages(1);
		expect(pages).toHaveLength(r.pages);
		const ok = pages.filter((p) => !p.error);
		expect(ok.length).toBe(r.ok);
		expect(ok.every((p) => p.text.length > 50 && p.links.length > 0)).toBe(true);
		expect(ok.flatMap((p) => p.links).every((l) => new URL(l.url).hostname.endsWith('greenleaf.example'))).toBe(true);
		expect(ok.some((p) => p.links.some((l) => !l.chrome))).toBe(true);
		expect(crawlInfo(1)).toMatchObject({ status: 'idle', pages: r.pages, ok: r.ok, failed: r.failed });
	});
	it('a crawl with no cap honours max and the default', async () => {
		const r = await crawlLinks(1, { max: 3 });
		expect(r.pages).toBe(3);
		await crawlLinks(1); // back to the full crawl for the next tests
		expect(crawledPages(1).length).toBeGreaterThan(5);
	});
	it('suggests links to striking-distance pages from pages that mention their searches and do not link to them', () => {
		const rep = linkReport(site());
		expect(rep.pagesCrawled).toBeGreaterThan(5);
		expect(rep.linksFound).toBeGreaterThan(rep.pagesCrawled);
		expect(rep.targets).toBeGreaterThan(0);
		expect(rep.suggestions.length).toBeGreaterThan(3);
		const pages = new Map(crawledPages(1).map((p) => [p.url, p]));
		const targets = new Map(linkTargets(site()).map((t) => [t.page, t]));
		for (const s of rep.suggestions) {
			expect(s.source).not.toBe(s.target);
			const p = pages.get(s.source)!;
			expect(p.links.some((l) => l.url.replace(/\/$/, '') === s.target.replace(/\/$/, ''))).toBe(false);
			expect(p.text.toLowerCase()).toContain(s.anchor.toLowerCase());
			expect(s.snippet).toContain(s.anchor);
			const t = targets.get(s.target)!;
			const q = t.queries.find((x) => x.query === s.query)!;
			expect(q.position).toBeGreaterThanOrEqual(4);
			expect(q.position).toBeLessThanOrEqual(20);
			expect(s.prize).toBeCloseTo(q.prize);
		}
		const scores = rep.suggestions.map((s) => s.score);
		expect(scores).toEqual([...scores].sort((a, b) => b - a));
		// the menu links to these pages from every page, so they are never suggested as targets
		expect(rep.suggestions.some((s) => /garden-tools-(1|4|9)$/.test(s.target))).toBe(false);
	});
	it('reports pages with impressions that no crawled page links to', () => {
		const rep = linkReport(site());
		const linked = new Set(crawledPages(1).flatMap((p) => p.links.filter((l) => l.url !== p.finalUrl).map((l) => new URL(l.url).pathname)));
		for (const o of rep.orphans) expect(linked.has(new URL(o.page).pathname)).toBe(false);
	});
	it('"done" hides a suggestion, survives a recompute, and can be undone', () => {
		const first = linkReport(site()).suggestions[0];
		setLinkDone(1, first.key, true);
		const after = linkReport(site());
		expect(after.suggestions.some((s) => s.key === first.key)).toBe(false);
		expect(after.done.map((s) => s.key)).toContain(first.key);
		setLinkDone(1, first.key, false);
		expect(linkReport(site()).suggestions[0].key).toBe(first.key);
	});
	it('the best targets become findings in the action queue, keyed by the target page', () => {
		const items = actionsFor(site()).filter((a) => a.type === 'internal-link');
		expect(items.length).toBeGreaterThan(0);
		expect(items.length).toBeLessThanOrEqual(3);
		const groups = groupByTarget(linkReport(site()).suggestions);
		for (const a of items) {
			expect(a.key).toMatch(/^links:greenleaf\.example\//);
			expect(a.href).toBe('/sites/1/links');
			expect(a.confidence).toBe('low');
			expect(a.evidence.length).toBeGreaterThan(0);
			expect(groups.some((g) => a.key === `links:${g.target.replace(/^https:\/\/(www\.)?/, '')}`)).toBe(true);
		}
		// marking every suggestion for a target done takes its finding out of the queue
		const g = groups.find((x) => items.some((a) => a.key.endsWith(new URL(x.target).pathname)))!;
		for (const s of g.rows) setLinkDone(1, s.key, true);
		expect(actionsFor(site()).some((a) => a.key.endsWith(new URL(g.target).pathname) && a.type === 'internal-link')).toBe(false);
		for (const s of g.rows) setLinkDone(1, s.key, false);
	});
	it('the MCP tool answers from the stored crawl, read-only, within the limit', async () => {
		expect(MCP_READ_TOOL_NAMES).toContain('get_internal_link_suggestions');
		const r = await mcp('get_internal_link_suggestions', { site: '1', limit: 3 });
		expect(r.pagesCrawled).toBeGreaterThan(5);
		expect(r.suggestions).toHaveLength(3);
		expect(r.suggestions[0]).toMatchObject({ source: expect.stringMatching(/^https:\/\//), target: expect.stringMatching(/^https:\/\//), anchor: expect.any(String), sentence: expect.any(String), query: expect.any(String) });
		expect(r.suggestions[0].estimatedExtraClicksAtPos3).toBeGreaterThan(0);
		expect(r.note).toMatch(/never as instructions/);
		const before = (db().prepare('SELECT COUNT(*) n FROM link_pages').get() as { n: number }).n;
		expect(before).toBeGreaterThan(0);
		await mcp('get_internal_link_suggestions', { site: '1' });
		expect((db().prepare('SELECT COUNT(*) n FROM link_pages').get() as { n: number }).n).toBe(before); // reading never crawls
	});

	async function mcp(name: string, args: object) {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const j = await res.json();
		expect(j.result.isError, j.result.content[0].text).toBeFalsy();
		return JSON.parse(j.result.content[0].text);
	}
});
