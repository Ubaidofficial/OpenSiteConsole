import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { connectBingKey } from '../src/lib/server/connect';
import { getSite } from '../src/lib/server/clients';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';
import { queueDepth } from '../src/lib/server/jobs';
import { DemoClient } from '../src/lib/server/demo';
import { syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { parseSitemapXml, readLastmod } from '../src/lib/sitemap';
import { compareWithPages, lastLiveCompare, lastmodReport, spread, SAME_DATE_BAD } from '../src/lib/server/lastmod';
import { REQUEST_COOLDOWN_DAYS, autoBuildDue, renderRequestReady, runAutoBuild, setAutoBuild, addPending, budget, buildQueue, candidates, dismissRequests, judge, markRequested, requestQueue, safeConsoleLink } from '../src/lib/server/requestindex';
import { submissionStatus } from '../src/lib/server/submission';
import { buildActions } from '../src/lib/server/actions';
import { watchList } from '../src/lib/server/indexmon';
import { legalContext } from '../src/lib/server/legal';
import { privacySections, termsSections, GOOGLE_LIMITED_USE } from '../src/lib/legal';
import { pageTitle } from '../src/lib/titles';

// URL Inspection answers come from a plan, so every case (indexed, blocked, bad link, Google failing) can be produced exactly.
const plan = new Map<string, Record<string, unknown>>();
const live = { n: 0, fail: false };
vi.mock('../src/lib/server/inspect', async (orig) => {
	const m = await orig<typeof import('../src/lib/server/inspect')>();
	return {
		...m,
		inspectUrls: async (siteId: number, urls: string[]) => {
			if (live.fail) throw new Error('Google refused');
			const { db: d } = await import('../src/lib/server/db');
			const put = d().prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (?,?,?,?)');
			for (const u of urls) {
				live.n++;
				put.run(siteId, u, Date.now(), JSON.stringify(plan.get(u) ?? { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL' } }));
			}
			return { live: urls.length, cached: 0, outcomes: urls.map((url) => ({ url, fromCache: false })) };
		}
	};
});

const DAY = 86_400_000;
const site = () => getSite(1)!;
const U = (p: string) => `https://greenleaf.example${p}`;
const iso = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * DAY).toISOString().slice(0, 10);
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const INDEXED = { indexStatusResult: { verdict: 'PASS', coverageState: 'Submitted and indexed', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL', lastCrawlTime: new Date().toISOString() } };
const NOT = { indexStatusResult: { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed', robotsTxtState: 'ALLOWED', indexingState: 'INDEXING_ALLOWED', pageFetchState: 'SUCCESSFUL' } };
const LINK = 'https://search.google.com/search-console/inspect?resource_id=sc-domain%3Agreenleaf.example&id=abc';

const setSitemap = (rows: { url: string; lastmod: string | null; bad?: number }[]) => {
	const d = db();
	d.prepare('DELETE FROM sitemap_urls WHERE site_id = 1').run();
	const ins = d.prepare('INSERT INTO sitemap_urls (site_id, url, norm, lastmod, sitemap, lastmod_bad) VALUES (1,?,?,?,?,?)');
	d.transaction(() => rows.forEach((r) => ins.run(r.url, r.url.replace(/^https?:\/\//, ''), r.lastmod, U('/sitemap.xml'), r.bad ?? 0)))();
	d.prepare('INSERT OR REPLACE INTO sitemap_sync (site_id, fetched_at, sitemaps, urls, truncated, error) VALUES (1,?,1,?,0,NULL)').run(Date.now(), rows.length);
};
const many = (n: number, f: (i: number) => string | null) => Array.from({ length: n }, (_, i) => ({ url: U('/p' + i), lastmod: f(i) }));

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await connectBingKey('demo', 'b');
	await drain();
}, 120_000);

beforeEach(() => {
	plan.clear();
	live.n = 0;
	live.fail = false;
	for (const t of ['index_requests', 'index_submissions', 'index_watch', 'index_queue', 'index_rechecks', 'url_inspections', 'sitemap_urls', 'sitemap_sync', 'audit_log']) db().prepare(`DELETE FROM ${t}`).run();
	db().prepare("DELETE FROM kv WHERE key LIKE 'reqauto:%' OR key LIKE 'lastmod_live:%' OR key LIKE 'submit:%' OR key LIKE 'inspect:%'").run();
});
afterEach(() => {
	delete process.env.REQUEST_INDEXING_PER_DAY;
	delete process.env.READ_ONLY;
	delete process.env.DIGEST_WEBHOOK_URL;
	setAutoBuild(1, false);
});

// ───────────────────────────── sitemap lastmod ─────────────────────────────
describe('reading a <lastmod>', () => {
	it('keeps the day as before, and flags whatever is not a valid W3C date', () => {
		for (const ok of ['2026-01-02', '2026-01-02T10:00:00Z', '2026-01-02T10:00:00+05:30', '2026-01-02T10:00:00.123Z', '2026-01-02T10:00']) expect(readLastmod(ok), ok).toEqual({ lastmod: '2026-01-02', bad: false });
		expect(readLastmod('2026')).toEqual({ lastmod: null, bad: false }); // valid, but no day
		expect(readLastmod('2026-03')).toEqual({ lastmod: null, bad: false });
		expect(readLastmod(null)).toEqual({ lastmod: null, bad: false });
		expect(readLastmod('2026-01-02 10:00:00')).toEqual({ lastmod: '2026-01-02', bad: true }); // sloppy: the day is kept, the value is flagged
		for (const bad of ['soon', '', '2026-02-30', '2026-13-01', '01/02/2026', '2026-1-2']) expect(readLastmod(bad), bad).toMatchObject({ lastmod: null, bad: true });
	});
	it('the parser marks only bad dates, and a sync stores the flag', async () => {
		const xml = '<urlset><url><loc>https://greenleaf.example/a</loc><lastmod>2026-01-02</lastmod></url><url><loc>https://greenleaf.example/b</loc><lastmod>whenever</lastmod></url><url><loc>https://greenleaf.example/c</loc></url></urlset>';
		expect(parseSitemapXml(xml).entries).toEqual([{ loc: 'https://greenleaf.example/a', lastmod: '2026-01-02' }, { loc: 'https://greenleaf.example/b', lastmod: null, lastmodBad: true }, { loc: 'https://greenleaf.example/c', lastmod: null }]);
		const f = (async () => new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } })) as typeof fetch;
		await syncSitemapUrls(1, { client: new DemoClient('demo-a'), fetchImpl: f });
		const rows = db().prepare('SELECT url, lastmod, lastmod_bad b FROM sitemap_urls WHERE site_id = 1 ORDER BY url').all();
		expect(rows).toEqual([{ url: U('/a'), lastmod: '2026-01-02', b: 0 }, { url: U('/b'), lastmod: null, b: 1 }, { url: U('/c'), lastmod: null, b: 0 }]);
	});
});

describe('lastmodReport', () => {
	const f = (r: ReturnType<typeof lastmodReport>, level: string) => r.findings.filter((x) => x.level === level).map((x) => x.text).join(' | ');
	it('says unknown, not good, when no sitemap has been read', () => {
		const r = lastmodReport(site());
		expect(r).toMatchObject({ synced: false, verdict: 'unknown', total: 0 });
		expect(r.findings[0].text).toMatch(/No sitemap has been read/);
	});
	it('dates that look like real edits are good', () => {
		setSitemap(many(30, (i) => iso(-3 - i * 4)));
		const r = lastmodReport(site());
		expect(r).toMatchObject({ synced: true, verdict: 'good', total: 30, withDate: 30, missing: 0, invalid: 0, future: 0, distinctDays: 30 });
		expect(r.findings[0]).toMatchObject({ level: 'good' });
	});
	it('one date on most URLs is a build stamp: bad at 80%, warn at 50%, and not judged below 20 URLs', () => {
		setSitemap(many(25, (i) => (i < 22 ? iso(-9) : iso(-20 - i))));
		const bad = lastmodReport(site());
		expect(bad.verdict).toBe('bad');
		expect(bad.commonest).toMatchObject({ day: iso(-9), count: 22 });
		expect(f(bad, 'bad')).toMatch(/88% of the dated URLs \(22 of 25\) share the date .*build or deploy stamp/);
		expect(SAME_DATE_BAD).toBe(0.8);
		setSitemap(many(20, (i) => (i < 11 ? iso(-9) : iso(-20 - i))));
		expect(lastmodReport(site()).verdict).toBe('warn');
		setSitemap(many(10, () => iso(-9)));
		expect(lastmodReport(site()).verdict).toBe('good'); // ten URLs sharing a date prove little
	});
	it('invalid and future dates are bad, with the counts', () => {
		setSitemap([...many(22, (i) => iso(-3 - i * 3)), { url: U('/future'), lastmod: iso(40) }, { url: U('/junk'), lastmod: null, bad: 1 }, { url: U('/sloppy'), lastmod: iso(-5), bad: 1 }]);
		const r = lastmodReport(site());
		expect(r).toMatchObject({ verdict: 'bad', invalid: 2, future: 1 });
		expect(f(r, 'bad')).toMatch(/2 URLs have a <lastmod> that is not a valid date/);
		expect(f(r, 'bad')).toMatch(/1 URL has a <lastmod> in the future/);
	});
	it('everything changed this week is a warning; many URLs with no date is a warning, all of them is only information', () => {
		setSitemap(many(25, (i) => iso(-(i % 5))));
		const recent = lastmodReport(site());
		expect(recent.verdict).toBe('warn');
		expect(f(recent, 'warn')).toMatch(/100% of the dated URLs changed in the last 7 days/);
		setSitemap(many(100, (i) => (i < 30 ? null : iso(-3 - i))));
		const missing = lastmodReport(site());
		expect(missing).toMatchObject({ missing: 30, verdict: 'warn' });
		setSitemap(many(10, () => null));
		const none = lastmodReport(site());
		expect(none.verdict).toBe('good');
		expect(f(none, 'info')).toMatch(/No URL has a <lastmod>/);
	});
	it('compares with Google\'s last crawl from stored inspections, using only inspections taken after the date', () => {
		const now = Date.now();
		setSitemap(many(8, (i) => iso(-10 - i)));
		const put = db().prepare('INSERT INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)');
		for (let i = 0; i < 6; i++) put.run(U('/p' + i), now, JSON.stringify({ indexStatusResult: { lastCrawlTime: new Date(now - (40 + i) * DAY).toISOString() } })); // crawled long before the date moved
		put.run(U('/p6'), now - 30 * DAY, JSON.stringify({ indexStatusResult: { lastCrawlTime: new Date(now - 60 * DAY).toISOString() } })); // inspected before its date: says nothing
		put.run(U('/p7'), now, JSON.stringify({ error: 'quota' }));
		const r = lastmodReport(site(), now);
		expect(r.recrawl).toMatchObject({ compared: 6, notRecrawled: 6, notRecrawledWeek: 6 });
		expect(r.findings.some((x) => x.level === 'warn' && /had not re-crawled 6 of 6 inspected pages/.test(x.text))).toBe(true);
		expect(r.recrawl.examples).toHaveLength(6);
		db().prepare('UPDATE url_inspections SET result = ? WHERE url = ?').run(JSON.stringify({ indexStatusResult: { lastCrawlTime: new Date(now - 1 * DAY).toISOString() } }), U('/p0'));
		expect(lastmodReport(site(), now).recrawl).toMatchObject({ compared: 6, notRecrawledWeek: 5 });
	});
});

describe('comparing with the pages\' own Last-Modified', () => {
	const pageFetch = (headers: Record<string, string | null>) => (async (input: RequestInfo | URL) => {
		const h = headers[String(input)];
		if (h === undefined) return new Response('nf', { status: 404 });
		return new Response('<html>x</html>', { status: 200, headers: { 'content-type': 'text/html', ...(h ? { 'last-modified': h } : {}) } });
	}) as typeof fetch;
	const httpDate = (offsetDays: number, now: number) => new Date(now + offsetDays * DAY).toUTCString();
	it('an even spread, newest to oldest', () => {
		expect(spread([1, 2, 3, 4, 5], 3)).toEqual([1, 3, 5]);
		expect(spread([1, 2], 5)).toEqual([1, 2]);
	});
	it('counts agreement and disagreement, and reports "cannot tell" when pages send no usable header', async () => {
		const now = Date.now();
		const rows = many(10, (i) => iso(-10 - i, now));
		setSitemap(rows);
		const headers: Record<string, string | null> = {};
		rows.forEach((r, i) => (headers[r.url] = i < 4 ? httpDate(-10 - i, now) : httpDate(-60, now))); // 4 agree, 6 are far off
		const bad = await compareWithPages(site(), { fetchImpl: pageFetch(headers), now });
		expect(bad).toMatchObject({ checked: 10, compared: 10, mismatched: 6 });
		expect(bad.findings[0]).toMatchObject({ level: 'bad' });
		expect(bad.examples[0].daysApart).toBeGreaterThan(30); // the sitemap date is later than the page's header
		expect(lastLiveCompare(1)).toMatchObject({ compared: 10, mismatched: 6 });
		rows.forEach((r, i) => (headers[r.url] = i < 7 ? httpDate(-10 - i, now) : httpDate(-60, now)));
		expect((await compareWithPages(site(), { fetchImpl: pageFetch(headers), now })).findings[0]).toMatchObject({ level: 'warn' }); // 3 of 10
		rows.forEach((r, i) => (headers[r.url] = httpDate(-10 - i + (i % 2), now)));
		expect((await compareWithPages(site(), { fetchImpl: pageFetch(headers), now })).findings[0]).toMatchObject({ level: 'good' });
		rows.forEach((r, i) => (headers[r.url] = i === 0 ? httpDate(-1, now) /* the page says "now" */ : i === 1 ? null : i === 2 ? 'not a date' : i === 3 ? (undefined as never) : httpDate(-10 - i, now)));
		delete headers[rows[3].url];
		const few = await compareWithPages(site(), { fetchImpl: pageFetch(headers), now });
		expect(few).toMatchObject({ dynamic: 1, noHeader: 2, unreachable: 1, compared: 6 });
		for (const r of rows.slice(4)) headers[r.url] = null;
		const none = await compareWithPages(site(), { fetchImpl: pageFetch(headers), now });
		expect(none.compared).toBeLessThan(5);
		expect(none.findings[0]).toMatchObject({ level: 'info' });
		expect(none.findings[0].text).toMatch(/does not mean the dates are wrong/);
	});
	it('only fetches the site\'s own pages', async () => {
		setSitemap([{ url: 'https://elsewhere.example/x', lastmod: iso(-5) }]);
		let called = 0;
		const f = (async () => (called++, new Response('x'))) as typeof fetch;
		const r = await compareWithPages(site(), { fetchImpl: f });
		expect(called).toBe(0);
		expect(r.unreachable).toBe(1);
	});
});

// ───────────────────────────── request indexing ─────────────────────────────
describe('safeConsoleLink', () => {
	it('lets only Search Console\'s own https address into an href', () => {
		expect(safeConsoleLink(LINK)).toBe(LINK);
		for (const bad of ['http://search.google.com/x', 'https://search.google.com.evil.example/x', 'https://evil.example/search.google.com', 'javascript:alert(1)', 'https://u:p@search.google.com/x', 'https://www.google.com/x', '', null, undefined, 42]) expect(safeConsoleLink(bad), String(bad)).toBeNull();
	});
});

describe('judging a page for a request', () => {
	const stored = (r: Record<string, unknown> | null) => (r ? { url: 'x', at: Date.now(), r: r as never } : null);
	const c = (tier: 1 | 2 | 3 | 4, lastmod: string | null = null) => ({ url: U('/a'), tier, lastmod });
	const now = Date.now();
	it('leaves out what Google already has up to date, keeps what changed since the last crawl', () => {
		expect(judge(c(1, iso(-2)), stored({ indexStatusResult: { ...INDEXED.indexStatusResult, lastCrawlTime: new Date(now - DAY).toISOString() } }), now)).toMatchObject({ keep: false, reason: 'Already indexed and up to date.' });
		const changed = judge(c(1, iso(-2)), stored({ indexStatusResult: { ...INDEXED.indexStatusResult, lastCrawlTime: new Date(now - 30 * DAY).toISOString() } }), now);
		expect(changed.keep).toBe(true);
		expect(changed.reason).toMatch(/Indexed, but changed .* \(sitemap\) and Google last crawled it/);
	});
	it('keeps not-indexed pages with a reason per tier and Google\'s coverage text, and only a real Search Console link', () => {
		const s = stored({ ...NOT, inspectionResultLink: LINK });
		expect(judge(c(1, iso(-1)), s, now)).toMatchObject({ keep: true, state: 'not_indexed', coverage: 'Discovered - currently not indexed', link: LINK });
		expect(judge(c(1, iso(-1)), s, now).reason).toMatch(/^New or changed .* and not indexed yet: Discovered/);
		expect(judge(c(2), s, now).reason).toMatch(/You pinned it/);
		expect(judge(c(3), s, now).reason).toMatch(/never shown in search in 90 days/);
		expect(judge(c(4), s, now).reason).toMatch(/Improve the page first/);
		expect(judge(c(1), stored({ ...NOT, inspectionResultLink: 'https://evil.example/phish' }), now).link).toBeNull();
	});
	it('sets aside pages where asking cannot help, saying why', () => {
		const p = (extra: Record<string, unknown>) => judge(c(1), stored({ indexStatusResult: { ...NOT.indexStatusResult, ...extra } }), now);
		expect(p({ robotsTxtState: 'DISALLOWED' })).toMatchObject({ keep: false, problem: expect.stringMatching(/robots\.txt blocks/) });
		expect(p({ indexingState: 'BLOCKED_BY_META_TAG' }).problem).toMatch(/noindex/);
		expect(p({ pageFetchState: 'NOT_FOUND' }).problem).toMatch(/cannot fetch it \(not found\)/);
		expect(p({ pageFetchState: 'SOFT_404' }).problem).toMatch(/soft 404/);
		expect(p({ googleCanonical: U('/other'), userCanonical: U('/a') }).problem).toMatch(/another page as the canonical/);
		expect(p({ googleCanonical: U('/a/'), userCanonical: U('/a') }).problem).toBeUndefined(); // a trailing slash is not another page
	});
	it('a page Google could not be asked about is kept as unknown, not dropped', () => {
		expect(judge(c(1, iso(-1)), stored({ error: 'quota' }), now)).toMatchObject({ keep: true, state: 'unknown', link: null });
		expect(judge(c(1), null, now).keep).toBe(true);
	});
});

describe('building the list', () => {
	const sitemap = () => setSitemap([{ url: U('/new1'), lastmod: iso(-1) }, { url: U('/new2'), lastmod: iso(-2) }, { url: U('/new3'), lastmod: iso(-3) }, { url: U('/new4'), lastmod: iso(-4) }, { url: U('/old'), lastmod: iso(-200) }]);
	it('orders candidates by tier, leaves out what was asked in the last 14 days or skipped in the last 30, and does not repeat a URL', () => {
		sitemap();
		db().prepare("INSERT INTO index_watch (site_id, url, added_at, source) VALUES (1,?,?,NULL)").run(U('/pinned'), Date.now());
		db().prepare("INSERT INTO index_watch (site_id, url, added_at, source) VALUES (1,?,?,'submit')").run(U('/by-submit'), Date.now()); // not pinned by the owner
		const now = Date.now();
		expect(candidates(site(), now).map((x) => [x.url, x.tier])).toEqual([[U('/new1'), 1], [U('/new2'), 1], [U('/new3'), 1], [U('/new4'), 1], [U('/pinned'), 2], [U('/old'), 3]]); // /old: in the sitemap, never shown in search
		db().prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at, acted_at) VALUES (1,?,'requested',0,'x',?,?)").run(U('/new1'), now, now - 13 * DAY);
		db().prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at, acted_at) VALUES (1,?,'dismissed',0,'x',?,?)").run(U('/new2'), now, now - 29 * DAY);
		expect(candidates(site(), now).map((x) => x.url)).not.toContain(U('/new1'));
		expect(candidates(site(), now).map((x) => x.url)).not.toContain(U('/new2'));
		expect(candidates(site(), now + 2 * DAY).map((x) => x.url)).toContain(U('/new1')); // 15 days on, asking again is allowed
		expect(candidates(site(), now + 2 * DAY).map((x) => x.url)).toContain(U('/new2')); // 31 days on, skipped pages come back
	});
	it('asks Google, drops indexed pages, sets blocked ones aside, keeps the rest within the allowance, and never lets a foreign link through', async () => {
		sitemap();
		plan.set(U('/new1'), { ...NOT, inspectionResultLink: LINK });
		plan.set(U('/new2'), INDEXED); // dated 2 days ago but crawled just now
		plan.set(U('/new3'), { indexStatusResult: { ...NOT.indexStatusResult, robotsTxtState: 'DISALLOWED' } });
		plan.set(U('/new4'), { ...NOT, inspectionResultLink: 'https://evil.example/x' });
		plan.set(U('/old'), INDEXED);
		const r = await buildQueue(site());
		expect(r).toMatchObject({ limitReached: false, candidates: 5, asked: 5, liveInspections: 5, listed: 2, alreadyIndexed: 2, problems: 1 });
		const q = requestQueue(1);
		expect(q.pending.map((i) => i.url)).toEqual([U('/new1'), U('/new4')]);
		expect(q.pending[0]).toMatchObject({ link: LINK, state: 'not_indexed', status: 'pending' });
		expect(q.pending[1].link).toBeNull();
		expect(q.problems.map((i) => i.url)).toEqual([U('/new3')]);
		expect(q.problems[0].reason).toMatch(/robots\.txt blocks/);
	});
	it('reads each page it is about to list: gone, noindex and "temporarily unavailable" pages are set aside, and a failed read proves nothing', async () => {
		sitemap();
		for (const path of ['/new1', '/new2', '/new3', '/new4']) plan.set(U(path), NOT);
		plan.set(U('/old'), INDEXED);
		const page = (title: string, head = '') => new Response(`<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><h1>${title}</h1></body></html>`, { status: 200, headers: { 'content-type': 'text/html' } });
		const reads: string[] = [];
		const fetchImpl = (async (input: RequestInfo | URL) => {
			const path = new URL(String(input)).pathname;
			reads.push(path);
			if (path === '/new1') return page('Job page temporarily unavailable | Example', '<meta name="robots" content="noindex">'); // a 200 placeholder, as a site with a reconnecting database serves
			if (path === '/new2') return new Response('gone', { status: 404 });
			if (path === '/new4') throw new Error('socket hang up');
			return page('A real page about gardens');
		}) as typeof fetch;
		const r = await buildQueue(site(), { liveFetch: fetchImpl });
		const q = requestQueue(1);
		expect(q.pending.map((i) => i.url)).toEqual([U('/new3'), U('/new4')]); // /new4 could not be read: still listed, as before
		expect(q.problems.map((i) => i.url).sort()).toEqual([U('/new1'), U('/new2')]);
		expect(q.problems.find((i) => i.url === U('/new1'))!.reason).toMatch(/serves it as a problem right now: It carries a noindex tag/);
		expect(q.problems.find((i) => i.url === U('/new2'))!.reason).toMatch(/answers 404: it is gone/);
		expect(r).toMatchObject({ listed: 2, problems: 2 });
		expect(reads).not.toContain('/old'); // an already-indexed page is dropped before any read
		// the placeholder alone (no noindex tag) is caught by what it says
		sitemap();
		plan.set(U('/new1'), NOT);
		await buildQueue(site(), { liveFetch: (async () => page('Companies temporarily unavailable | Example')) as typeof fetch });
		expect(requestQueue(1).problems.map((i) => i.reason).join(' ')).toMatch(/temporarily unavailable/);
		// and the check can be switched off
		await buildQueue(site(), { liveFetch: false });
		expect(requestQueue(1).problems).toHaveLength(0);
	});
	it('stops at the allowance, and refuses to build once it is used up, saying when a slot frees', async () => {
		process.env.REQUEST_INDEXING_PER_DAY = '2';
		sitemap();
		const r = await buildQueue(site());
		expect(r.listed).toBe(2);
		expect(r.asked).toBe(2); // it did not ask Google about pages it had no room for
		const now = Date.now();
		markRequested(site(), [U('/new1'), U('/new2')], 'app', now - 3600_000);
		expect(budget(1, now)).toMatchObject({ perDay: 2, usedLast24h: 2, left: 0 });
		const blocked = await buildQueue(site(), { now });
		expect(blocked).toMatchObject({ limitReached: true, listed: 0 });
		expect(blocked.nextSlotAt).toBeGreaterThan(now);
		expect(blocked.nextSlotAt).toBeLessThanOrEqual(now + DAY);
		expect(live.n).toBe(2); // and it spent no quota finding that out
	});
	it('when Google cannot be asked it still lists candidates, as unknown, without a link', async () => {
		sitemap();
		live.fail = true;
		const r = await buildQueue(site());
		expect(r.listed).toBeGreaterThan(0);
		expect(requestQueue(1).pending.every((i) => i.state === 'unknown' && i.link === null)).toBe(true);
	});
	it('rebuilding replaces the unanswered list but keeps what was asked, skipped, or added by hand', async () => {
		sitemap();
		await buildQueue(site());
		markRequested(site(), [U('/new1')], 'app');
		addPending(site(), [U('/manual')]);
		await buildQueue(site());
		const rows = db().prepare('SELECT url, status, tier FROM index_requests WHERE site_id = 1 ORDER BY url').all() as { url: string; status: string; tier: number }[];
		expect(rows.find((x) => x.url === U('/new1'))).toMatchObject({ status: 'requested' });
		expect(rows.find((x) => x.url === U('/manual'))).toMatchObject({ status: 'pending', tier: 0 });
		expect(rows.filter((x) => x.status === 'pending' && x.url !== U('/manual')).length).toBeGreaterThan(0);
	});
});

describe('the daily automatic list', () => {
	const sitemap = () => setSitemap([{ url: U('/new1'), lastmod: iso(-1) }, { url: U('/new2'), lastmod: iso(-2) }]);
	const hook = () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/x';
		const calls: string[] = [];
		const fetchImpl = (async (_u: unknown, init: { body: string }) => { calls.push(JSON.parse(init.body).text); return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
		return { calls, fetchImpl };
	};
	it('is off until switched on, then due once a day', () => {
		expect(autoBuildDue(1, '2026-01-05')).toBe(false);
		setAutoBuild(1, true);
		expect(autoBuildDue(1, '2026-01-05')).toBe(true);
	});
	it('builds the list, tells the webhook once, and is not due again the same day', async () => {
		sitemap();
		setAutoBuild(1, true);
		const { calls, fetchImpl } = hook();
		const r = await runAutoBuild(site(), { fetchImpl });
		expect(r).toMatchObject({ built: true, listed: 2, notified: true });
		expect(requestQueue(1).pending).toHaveLength(2);
		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatch(/2 pages are ready/);
		expect(calls[0]).toMatch(/\/sites\/1\/request/);
		expect(autoBuildDue(1)).toBe(false);
		expect(autoBuildDue(1, '2999-01-01')).toBe(true); // tomorrow it is due again
	});
	it('builds without a webhook, sends nothing when nothing is worth requesting, and does not retry a failed day', async () => {
		sitemap();
		setAutoBuild(1, true);
		expect(await runAutoBuild(site())).toMatchObject({ built: true, listed: 2, notified: false }); // no webhook set
		plan.set(U('/new1'), INDEXED);
		plan.set(U('/new2'), INDEXED);
		db().prepare("DELETE FROM index_requests WHERE site_id = 1").run();
		const { calls, fetchImpl } = hook();
		expect(await runAutoBuild(site(), { fetchImpl })).toMatchObject({ built: true, listed: 0, notified: false });
		expect(calls).toHaveLength(0);
		db().prepare("DELETE FROM kv WHERE key LIKE 'reqauto:%'").run();
		live.fail = true; // Google refusing is caught: the stored answers are used
		await expect(runAutoBuild(site())).resolves.toBeDefined();
		expect(autoBuildDue(1)).toBe(false);
	});
	it('does nothing when today\'s allowance is used up', async () => {
		sitemap();
		process.env.REQUEST_INDEXING_PER_DAY = '1';
		markRequested(site(), [U('/other')], 'app');
		setAutoBuild(1, true);
		const { calls, fetchImpl } = hook();
		expect(await runAutoBuild(site(), { fetchImpl })).toMatchObject({ built: false, notified: false });
		expect(calls).toHaveLength(0);
	});
	it('words the message with the count and the link', () => {
		expect(renderRequestReady('example.com', 1, 0, 'https://app.example.com/', 7)).toBe('SEOConsole: 1 page is ready to request indexing for example.com.\nOpen the list, press Request indexing on each: https://app.example.com/sites/7/request');
		expect(renderRequestReady('example.com', 3, 2, 'https://app.example.com', 7)).toMatch(/\(2 more need fixing first\)/);
	});
});

describe('recording what you asked', () => {
	it('logs it with the other submissions, watches it, schedules the day 1, 3 and 5 re-checks and shows it in the table', () => {
		const now = Date.now();
		const r = markRequested(site(), [U('/a'), U('/b#frag'), 'https://other.example/x'], 'app', now);
		expect(r.marked).toBe(2);
		expect(r.rejected).toHaveLength(1);
		expect(db().prepare("SELECT channel, ok, source FROM index_submissions WHERE site_id = 1 ORDER BY url").all()).toEqual([{ channel: 'search_console', ok: 1, source: 'app' }, { channel: 'search_console', ok: 1, source: 'app' }]);
		expect(watchList(1).sort()).toEqual([U('/a'), U('/b')]);
		expect(db().prepare('SELECT COUNT(*) n, MIN(due_at - submitted_at) d FROM index_rechecks WHERE site_id = 1').get()).toEqual({ n: 2, d: DAY });
		const row = submissionStatus(1, 10, now)[0];
		expect(row.channels).toEqual([{ channel: 'search_console', ok: true, message: 'You asked for indexing in Search Console.' }]);
		expect(requestQueue(1, now).recent.map((x) => x.url).sort()).toEqual([U('/a'), U('/b')]);
		expect(requestQueue(1, now).recent[0]).toMatchObject({ verdict: 'waiting', daysSince: 0 });
		expect((db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'index.requested'").get() as { n: number }).n).toBe(1);
	});
	// A pinned URL stays a candidate however old, so these tests are about the waiting periods and nothing else.
	const pin = () => db().prepare("INSERT INTO index_watch (site_id, url, added_at, source) VALUES (1,?,?,NULL)").run(U('/pinned'), Date.now());
	it('a request is not asked for again for 14 days, then it is', () => {
		pin();
		const now = Date.now();
		markRequested(site(), [U('/pinned')], 'app', now);
		expect(candidates(site(), now + (REQUEST_COOLDOWN_DAYS - 1) * DAY).map((x) => x.url)).not.toContain(U('/pinned'));
		expect(candidates(site(), now + (REQUEST_COOLDOWN_DAYS + 1) * DAY).map((x) => x.url)).toContain(U('/pinned'));
	});
	it('skipping hides a URL for 30 days', () => {
		pin();
		const now = Date.now();
		expect(dismissRequests(site(), [U('/pinned'), 'https://other.example/x'], now)).toBe(1);
		expect(candidates(site(), now + 29 * DAY).map((x) => x.url)).not.toContain(U('/pinned'));
		expect(candidates(site(), now + 31 * DAY).map((x) => x.url)).toContain(U('/pinned'));
	});
	it('adding by hand judges each URL on Google\'s stored answer', () => {
		const put = db().prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)');
		put.run(U('/ok'), Date.now(), JSON.stringify({ ...NOT, inspectionResultLink: LINK }));
		put.run(U('/have'), Date.now(), JSON.stringify(INDEXED));
		put.run(U('/blocked'), Date.now(), JSON.stringify({ indexStatusResult: { ...NOT.indexStatusResult, indexingState: 'BLOCKED_BY_HTTP_HEADER' } }));
		markRequested(site(), [U('/recent')], 'app');
		const r = addPending(site(), [U('/ok'), U('/have'), U('/blocked'), U('/unasked'), U('/recent'), 'https://other.example/x']);
		expect(r).toEqual({ added: 2, problems: 1, alreadyIndexed: 1, recentlyAsked: 1, rejected: 1 });
		const q = requestQueue(1);
		expect(q.pending.map((i) => i.url).sort()).toEqual([U('/ok'), U('/unasked')]);
		expect(q.pending.find((i) => i.url === U('/ok'))).toMatchObject({ link: LINK, tier: 0 });
		expect(q.problems.map((i) => i.url)).toEqual([U('/blocked')]);
	});
});

describe('the action queue knows about indexing', () => {
	it('a list to request, pages that cannot be indexed, URLs still not indexed after 5 days, and bad sitemap dates each become an item that opens the right tab', () => {
		const now = Date.now();
		db().prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, state, built_at) VALUES (1,?,'pending',1,'New and not indexed','not_indexed',?)").run(U('/new1'), now);
		db().prepare("INSERT INTO index_requests (site_id, url, status, tier, reason, built_at) VALUES (1,?,'problem',1,'robots.txt blocks Google from it.',?)").run(U('/blocked'), now);
		db().prepare("INSERT INTO index_submissions (site_id, url, channel, at, ok, message, source) VALUES (1,?,'bing',?,1,'ok','app')").run(U('/stuck'), now - 6 * DAY);
		db().prepare("INSERT INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)").run(U('/stuck'), now - DAY, JSON.stringify(NOT));
		setSitemap(many(25, () => iso(-9)));
		const all = buildActions(site());
		const get = (prefix: string) => all.find((a) => a.key.startsWith(prefix))!;
		expect(get('request:list')).toMatchObject({ type: 'request', href: '/sites/1/request', blocking: false, effort: 'low' });
		expect(get('request:problems')).toMatchObject({ type: 'request', href: '/sites/1/request' });
		expect(get('submitted:')).toMatchObject({ type: 'submitted', href: '/sites/1/submit' });
		expect(get('submitted:').evidence[0]).toMatch(/Discovered - currently not indexed/);
		expect(get('lastmod:')).toMatchObject({ type: 'lastmod', href: '/sites/1/sitemaps', blocking: false });
		expect(get('lastmod:').why).toMatch(/share the date/);
	});
	it('nothing is raised when there is nothing to say', () => {
		const types = new Set(buildActions(site()).map((a) => a.type));
		for (const t of ['request', 'submitted', 'lastmod'] as const) expect(types.has(t), t).toBe(false);
	});
});

// ───────────────────────────── MCP ─────────────────────────────
describe('MCP', () => {
	let readKey = '', submitKey = '';
	const call = async (k: string, name: string, args: object = {}) => {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
	};
	beforeAll(() => {
		readKey = createApiKey('rq-read', null).key;
		submitKey = createApiKey('rq-submit', null, null, 'submit').key;
	});

	it('lastmod health is readable with a read-only key, and compare_live fetches pages', async () => {
		setSitemap(many(25, () => iso(-9)));
		const r = await call(readKey, 'get_sitemap_lastmod_health', { site: '1' });
		expect(r.isError).toBe(false);
		expect(r.data).toMatchObject({ verdict: 'bad', counts: { urls: 25, withDate: 25, commonestDate: { count: 25 } }, liveComparison: null });
		expect(r.data.findings[0].level).toBe('bad');
		const live = await call(readKey, 'get_sitemap_lastmod_health', { site: '1', compare_live: true });
		expect(live.data.liveComparison).toMatchObject({ pagesFetched: 20 }); // the demo site sends no Last-Modified, so it says it cannot tell
		expect(live.data.liveComparison.findings[0].level).toBe('info');
	});

	it('the Request list is read with a read key; building and recording need the submit permission', async () => {
		setSitemap([{ url: U('/new1'), lastmod: iso(-1) }, { url: U('/new2'), lastmod: iso(-2) }]);
		plan.set(U('/new1'), { ...NOT, inspectionResultLink: LINK });
		for (const [name, args] of [['build_request_indexing_queue', { site: '1' }], ['mark_indexing_requested', { site: '1', urls: [U('/new1')], action: 'requested' }], ['inspect_and_submit_urls', { site: '1', urls: [U('/new1')] }]] as const) {
			const r = await call(readKey, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.data, name).toMatch(/"submit" permission/);
		}
		const built = await call(submitKey, 'build_request_indexing_queue', { site: '1' });
		expect(built.data).toMatchObject({ built: true, listed: 2, askedGoogleAbout: 2, liveInspections: 2 });
		expect(built.data.toRequest[0]).toMatchObject({ url: U('/new1'), openInSearchConsole: LINK });
		const q = await call(readKey, 'get_request_indexing_queue', { site: '1' });
		expect(q.data.toRequest).toHaveLength(2);
		expect(q.data.allowance).toMatchObject({ perDay: 10, left: 10 });
		const rec = await call(submitKey, 'mark_indexing_requested', { site: '1', urls: [U('/new1'), 'https://other.example/x'], action: 'requested' });
		expect(rec.data).toMatchObject({ recorded: 1, rejected: [{ reason: expect.stringMatching(/outside this site/) }] });
		expect((await call(readKey, 'get_request_indexing_queue', { site: '1' })).data.askedRecently[0]).toMatchObject({ url: U('/new1'), result: 'waiting' });
		expect((await call(submitKey, 'mark_indexing_requested', { site: '1', urls: [U('/new2')], action: 'skip' })).data.skipped).toBe(1);
		expect((await call(submitKey, 'mark_indexing_requested', { site: '1', urls: [U('/new2')], action: 'maybe' })).data).toMatch(/must be requested or skip/);
		expect((await call(submitKey, 'mark_indexing_requested', { site: '1', action: 'requested' })).data).toMatch(/`urls` is required/);
	});

	it('building spends the key\'s inspection budget, and says so when it is gone', async () => {
		setSitemap(many(6, (i) => iso(-1 - i)));
		process.env.MCP_INSPECT_PER_KEY_DAY = '3';
		try {
			const r = await call(submitKey, 'build_request_indexing_queue', { site: '1' });
			expect(r.data.askedGoogleAbout).toBeLessThanOrEqual(3);
			const again = await call(submitKey, 'build_request_indexing_queue', { site: '1' });
			expect(again.isError).toBe(true);
			expect(again.data).toMatch(/used its 3 live URL inspections/);
		} finally {
			delete process.env.MCP_INSPECT_PER_KEY_DAY;
		}
	});

	it('inspect_and_submit_urls: inspects first, sends only what is not indexed and not blocked, and says why for the rest', async () => {
		plan.set(U('/gap'), NOT);
		plan.set(U('/have'), INDEXED);
		plan.set(U('/blocked'), { indexStatusResult: { ...NOT.indexStatusResult, robotsTxtState: 'DISALLOWED' } });
		const dry = await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/gap'), U('/have'), U('/blocked')], dry_run: true, channels: ['bing'] });
		expect(dry.isError).toBe(false);
		expect(dry.data.inspected.map((x: { url: string; google: string }) => [x.url, x.google])).toEqual([[U('/gap'), 'not_indexed'], [U('/have'), 'indexed'], [U('/blocked'), 'not_indexed']]);
		expect(dry.data.notSubmitted).toEqual([{ url: U('/have'), why: 'Already indexed.' }, { url: U('/blocked'), why: expect.stringMatching(/robots\.txt blocks/) }]);
		expect(dry.data.submission).toMatchObject({ dryRun: true, urls: 1, channels: [{ channel: 'bing', attempted: 1, accepted: 0 }] });
		expect(db().prepare('SELECT COUNT(*) n FROM index_submissions').get()).toEqual({ n: 0 });
		const real = await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/gap'), U('/have'), U('/blocked')], channels: ['bing'] });
		expect(real.data.submission.channels[0]).toMatchObject({ channel: 'bing', accepted: 1 });
		expect(db().prepare('SELECT url FROM index_submissions').all()).toEqual([{ url: U('/gap') }]);
		const all = await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/have')], only_if_not_indexed: false, channels: ['bing'] });
		expect(all.data.submission.channels[0].accepted).toBe(1);
		const none = await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/have')] });
		expect(none.data).toMatchObject({ submission: null, note: 'Nothing needed submitting.' });
	});

	it('inspect_and_submit_urls validates its input like inspect_url and submit_urls_for_indexing', async () => {
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1' })).data).toMatch(/`urls` is required/);
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: ['https://other.example/x'] })).data).toMatch(/outside the property/);
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: ['nope'] })).data).toMatch(/not a full http/);
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: Array.from({ length: 21 }, (_, i) => U('/p' + i)) })).data).toMatch(/At most 20/);
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/a')], channels: ['pigeon'] })).data).toMatch(/channels/);
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/a')], drip_days: 99 })).data).toMatch(/drip_days/);
		process.env.READ_ONLY = '1';
		expect((await call(submitKey, 'inspect_and_submit_urls', { site: '1', urls: [U('/gap')], channels: ['bing'] })).data).toMatch(/READ_ONLY=1/);
	});
});

// ───────────────────────────── the Inspect tab ─────────────────────────────
describe('the Inspect tab: submit and request straight from the results', () => {
	const act = async (name: 'submitSelected' | 'addToRequests', urls: string[]) => {
		const mod = await import('../src/routes/sites/[id]/inspect/+page.server');
		const body = new FormData();
		urls.forEach((u) => body.append('url', u));
		return (mod.actions as Record<string, (e: never) => Promise<Record<string, unknown>>>)[name]({ params: { id: '1' }, request: new Request('http://x', { method: 'POST', body }) } as never);
	};
	it('Submit sends the ticked URLs and answers with what each channel did', async () => {
		const r = await act('submitSelected', [U('/gap'), U('/gap2')]);
		expect(String(r.submitted)).toMatch(/Bing URL submission: 2 of 2 accepted/);
		expect(String(r.submitted)).toMatch(/IndexNow: not used/);
		expect(db().prepare("SELECT COUNT(*) n FROM index_submissions WHERE channel = 'bing'").get()).toEqual({ n: 2 });
		const none = await act('submitSelected', []);
		expect((none as { status?: number }).status).toBe(400);
	});
	it('Add to the Request list puts them on the list the Request tab shows', async () => {
		db().prepare('INSERT OR REPLACE INTO url_inspections (site_id, url, fetched_at, result) VALUES (1,?,?,?)').run(U('/gap'), Date.now(), JSON.stringify({ ...NOT, inspectionResultLink: LINK }));
		const r = await act('addToRequests', [U('/gap'), U('/fresh')]);
		expect(String(r.submitted)).toMatch(/2 added to the Request list/);
		expect(requestQueue(1).pending.map((i) => i.url).sort()).toEqual([U('/fresh'), U('/gap')]);
	});
	it('the table has a tick box per row and the two buttons', () => {
		const t = readFileSync('src/routes/sites/[id]/inspect/+page.svelte', 'utf8');
		expect(t).toMatch(/type="checkbox" name="url"/);
		expect(t).toMatch(/formaction="\?\/submitSelected"/);
		expect(t).toMatch(/formaction="\?\/addToRequests"/);
	});
});

// ───────────────────────────── legal pages and the menu ─────────────────────────────
describe('privacy policy, terms and the menu', () => {
	it('Digest is gone from the top menu (the page itself stays reachable) and the footer links the two legal pages', () => {
		const layout = readFileSync('src/routes/+layout.svelte', 'utf8');
		expect(layout).not.toMatch(/\['\/digest'/);
		expect(layout).toMatch(/href="\/privacy"/);
		expect(layout).toMatch(/href="\/terms"/);
		expect(readFileSync('src/routes/actions/+page.svelte', 'utf8')).not.toMatch(/href="\/digest"/);
	});
	it('the pages have tab titles', () => {
		expect(pageTitle('/privacy')).toBe('Privacy policy · SEOConsole');
		expect(pageTitle('/terms')).toBe('Terms of service · SEOConsole');
	});
	it('the operator\'s details come from the environment, with a placeholder (not an invented name) until they are set', () => {
		delete process.env.LEGAL_ENTITY;
		delete process.env.LEGAL_CONTACT_EMAIL;
		const none = legalContext();
		expect(none.configured).toBe(false);
		expect(none.context.entity).toBe('the operator of this SEOConsole installation');
		expect(none.context.contact).toBeNull();
		process.env.LEGAL_ENTITY = 'Acme Ltd';
		process.env.LEGAL_CONTACT_EMAIL = 'privacy@acme.example';
		process.env.LEGAL_GOVERNING_LAW = 'England and Wales';
		try {
			const c = legalContext();
			expect(c.configured).toBe(true);
			const text = JSON.stringify([privacySections(c.context), termsSections(c.context)]);
			expect(text).toContain('Acme Ltd');
			expect(text).toContain('privacy@acme.example');
			expect(text).toContain('England and Wales');
		} finally {
			delete process.env.LEGAL_ENTITY;
			delete process.env.LEGAL_CONTACT_EMAIL;
			delete process.env.LEGAL_GOVERNING_LAW;
		}
	});
	it('the policy carries Google\'s Limited Use statement and covers what the app really does, and the terms ban the abuse the indexing tools could enable', () => {
		const ctx = legalContext().context;
		const priv = privacySections(ctx);
		const text = priv.map((s) => [s.title, ...s.paras, ...(s.items ?? [])].join(' ')).join(' ');
		expect(text).toContain(GOOGLE_LIMITED_USE);
		expect(GOOGLE_LIMITED_USE).toMatch(/Google API Services User Data Policy, including the Limited Use requirements/);
		for (const needle of [/do not sell/i, /encrypted at rest/, /myaccount\.google\.com\/permissions/, /session cookie/, /Search Console/, /Analytics/, /Tag Manager/, /MCP/, /Indexing API/, /deleted/, /GDPR/]) expect(text, String(needle)).toMatch(needle);
		const terms = termsSections(ctx).map((s) => [s.title, ...s.paras, ...(s.items ?? [])].join(' ')).join(' ');
		for (const needle of [/Indexing API/, /quotas/, /as is/i, /MIT licence/, /Limit of liability|liable/]) expect(terms, String(needle)).toMatch(needle);
	});
	it('the pages are not behind the login in the hook, and the README and .env.example say how to fill them in', () => {
		const hook = readFileSync('src/hooks.server.ts', 'utf8');
		expect(hook).toMatch(/const isPublic = \(path: string\) => path === '\/login' .*\|\| isLegal\(path\);/);
		expect(hook).toMatch(/!event\.locals\.authed && !isPublic\(path\)/);
		expect(readFileSync('.env.example', 'utf8')).toMatch(/LEGAL_ENTITY=/);
	});
});

// ───────────────────────────── the Actions pages ─────────────────────────────
describe('the Actions pages', () => {
	it('filter by blocking, quick wins, site and kind, with readable kind names rather than raw slugs', () => {
		const g = readFileSync('src/routes/actions/+page.svelte', 'utf8');
		const s = readFileSync('src/routes/sites/[id]/actions/+page.svelte', 'utf8');
		for (const t of [g, s]) {
			expect(t).toMatch(/TYPE_LABEL\[/);
			expect(t).toMatch(/Quick wins/);
			expect(t).toMatch(/Blocking \(/);
			expect(t).toMatch(/Clear them/);
		}
		expect(g).toMatch(/All sites/);
		expect(s).not.toMatch(/\{t\}<\/button>/); // the raw type slug is no longer the label
		expect(readFileSync('src/lib/components/ActionCard.svelte', 'utf8')).toMatch(/<details[^>]*>.*evidence \(/s);
	});
});
