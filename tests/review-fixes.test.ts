import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { aiTrafficReport, comparability, forecastReport, groupsReport, trendsReport, urlClassesReport } from '../src/lib/server/insights';
import { createTest, evaluateTest, isRealDate, listTests } from '../src/lib/server/seotests';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { fetchPage, guardedFetch, hostAllowed, isPrivateIp } from '../src/lib/server/onpage';
import { linksFor, setLink } from '../src/lib/server/links';
import { liftTestCalibrated, MIN_PLACEBOS, parseScope, placebosFrom, tCdf, tQuantile } from '../src/lib/experiments';
import { countryCannibalization, groupPages, spansHosts, topicClusters, urlSection } from '../src/lib/groups';
import { parseOnPage } from '../src/lib/onpage';
import { weeklyTotals, projectClicks } from '../src/lib/trends';
import { assistantOf } from '../src/lib/ai';
import { fitCtrCurve } from '../src/lib/analytics';

// ── calibrated significance test ─────────────────────────────────────────────
describe('calibrated lift test', () => {
	it('Student t matches textbook values', () => {
		expect(tQuantile(0.975, 3)).toBeCloseTo(3.182, 2);
		expect(tQuantile(0.975, 10)).toBeCloseTo(2.228, 2);
		expect(tCdf(2, 5)).toBeCloseTo(0.949, 3);
		expect(tCdf(-2, 5)).toBeCloseTo(0.051, 3);
		expect(tCdf(0, 4)).toBeCloseTo(0.5, 6);
	});

	let seed = 4242;
	const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
	const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
	const pois = (lam: number) => { if (lam > 50) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss())); const l = Math.exp(-lam); let p = 1, n = 0; do { n++; p *= rnd(); } while (p > l); return n - 1; };
	const series = (mean: number, rho: number, sd: number, len: number, jumpFrom: number, jump: number) => { let lvl = 0; return Array.from({ length: len }, (_, i) => { lvl = rho * lvl + Math.sqrt(1 - rho * rho) * sd * gauss(); return pois(mean * Math.exp(lvl) * (i >= jumpFrom ? jump : 1)); }); };
	const n = 28;
	const run = (windows: number, rho: number, sd: number, effect: number, N: number) => {
		let verdicts = 0, est = 0;
		for (let i = 0; i < N; i++) {
			const S = windows * n;
			const t = series(40, rho, sd, S + n, S, effect), c = series(400, rho, sd, S + n, S, 1);
			const r = liftTestCalibrated({ pre: t.slice(S - n, S), post: t.slice(S) }, { pre: c.slice(S - n, S), post: c.slice(S) }, placebosFrom(t, c, S, n, n));
			if (r.verdict === 'estimate-only') est++; else if (r.verdict !== 'inconclusive') verdicts++;
		}
		return { fp: verdicts / N, est: est / N };
	};

	it('stays near the nominal 5% false-positive rate even when traffic drifts (it was 40-60% before calibration)', () => {
		for (const [rho, sd] of [[0, 0], [0.9, 0.1], [0.9, 0.2], [0.97, 0.2]] as const) {
			const r = run(5, rho, sd, 1, 300);
			expect(r.fp, `rho ${rho} sd ${sd}`).toBeLessThan(0.09);
			expect(r.est).toBe(0);
		}
	}, 60_000);

	it('still finds a real +40% change on steady traffic', () => {
		expect(run(5, 0, 0, 1.4, 200).fp).toBeGreaterThan(0.9);
	}, 60_000);

	it('refuses a verdict when there are fewer than three earlier windows to measure drift on', () => {
		expect(MIN_PLACEBOS).toBe(3);
		for (const windows of [1, 2, 3]) {
			const r = run(windows, 0, 0, 1.4, 20);
			expect(r.est, `${windows} windows of history`).toBe(1);
			expect(r.fp).toBe(0);
		}
		expect(run(4, 0, 0, 1.4, 50).est).toBe(0); // exactly four windows (three earlier ones) is enough
	}, 60_000);

	it('estimate-only results show the figure but no range and no p-value', () => {
		const t = series(40, 0, 0, 56, 28, 1.4), c = series(400, 0, 0, 56, 28, 1);
		const r = liftTestCalibrated({ pre: t.slice(0, 28), post: t.slice(28) }, { pre: c.slice(0, 28), post: c.slice(28) }, []);
		expect(r).toMatchObject({ verdict: 'estimate-only', ciLow: null, p: null });
		expect(r.lift!).toBeGreaterThan(0.2);
		expect(r.note).toMatch(/earlier windows/);
	});
});

// ── partial history, empty history, weekly blocks ────────────────────────────
describe('comparisons need a trustworthy previous period', () => {
	async function fresh(days: number, backfillDone: number, end = '2026-10-31') {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const d = db();
		d.prepare('DELETE FROM sa_rows').run();
		d.prepare('DELETE FROM site_daily').run();
		let seed = 3;
		const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
		const ins = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','MOBILE',?,?,?)");
		const day = d.prepare('INSERT OR REPLACE INTO site_daily VALUES (1,?,?,?,?)');
		d.transaction(() => {
			for (let i = days - 1; i >= 0; i--) {
				const date = new Date(Date.parse(end) - i * 86400000).toISOString().slice(0, 10);
				let c = 0, im = 0;
				for (let q = 0; q < 60; q++) { const clicks = Math.floor(rnd() * 12); ins.run(date, 'how to query ' + q, 'https://x.example/blog/p' + (q % 15), clicks, clicks * 15 + 20, 1 + rnd() * 15); c += clicks; im += clicks * 15 + 20; }
				day.run(date, c, im, 6);
			}
		})();
		const first = new Date(Date.parse(end) - (days - 1) * 86400000).toISOString().slice(0, 10);
		d.prepare('UPDATE sites SET synced_through = ?, backfill_done = ?, backfilled_to = ? WHERE id = 1').run(end, backfillDone, first);
		return getSite(1)!;
	}

	it('while history is still downloading, trends do not call everything a winner', async () => {
		const site = await fresh(30, 0);
		const t = trendsReport(site, 28);
		expect(t.comparable).toBe(false);
		expect(t.reason).toMatch(/still being downloaded/);
		expect(t.queryMovers.winners).toEqual([]);
		expect(t.newQueries).toEqual([]);
		expect(t.bands.prev).toBeNull();
		expect(t.bands.now.reduce((a, b) => a + b.queries, 0)).toBeGreaterThan(0); // this period is still reported
		const g = groupsReport(site, 28);
		expect(g.comparable).toBe(false);
		expect(g.groups[0].deltaPct).toBeNull();
		expect(g.groups[0].prevClicks).toBe(0);
		const u = urlClassesReport(site, 28);
		expect(u.comparable).toBe(false);
		expect(u.counts.dead + u.counts.fading).toBe(0);
	});

	it('the same data with complete history compares normally', async () => {
		const site = await fresh(56, 1);
		const t = trendsReport(site, 28);
		expect(t.comparable).toBe(true);
		expect(t.bands.prev).not.toBeNull();
		expect(t.queryMovers.winners.length).toBeLessThan(15);
	});

	it('a site with nothing before the current period has nothing to compare with, even once backfill is done', async () => {
		const site = await fresh(28, 1);
		expect(comparability(site, { prevStart: '2026-09-03', prevEnd: '2026-10-03', days: 28 }).comparable).toBe(false);
		expect(trendsReport(site, 28).reason).toMatch(/no data/);
	});

	it('MCP says so instead of returning a flood of winners', async () => {
		await fresh(30, 0);
		const key = createApiKey('k', null).key;
		const call = async (name: string, args: object) => (await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }))).json()).result;
		const r = JSON.parse((await call('get_trends', { site: '1', view: 'movers' })).content[0].text);
		expect(r).toMatchObject({ comparable: false });
		expect(r.note).toMatch(/downloaded/);
		const g = JSON.parse((await call('get_content_groups', { site: '1', view: 'folders' })).content[0].text);
		expect(g.comparisonUnavailable).toBeTruthy();
	});

	it('an SEO test is not judged against a half-downloaded "before"', async () => {
		const site = await fresh(40, 0);
		// 40 days are stored (back to 22 Sep). A change on 10 Oct needs a "before" from 12 Sep: partly missing.
		createTest(1, { name: 't', kind: 'split', startDate: '2026-10-10', treatment: parseScope('/blog/p1'), control: parseScope('/blog/p2'), windowDays: 28 });
		const o = evaluateTest(site, listTests(1)[0]);
		expect(o.clicks.verdict).toBe('too-little-data');
		expect(o.clicks.note).toMatch(/still downloading/);
		expect(o.clicks.lift).toBeNull();
		// the guard is what decides it: once the backfill is complete the same test gets past that check
		db().prepare('UPDATE sites SET backfill_done = 1 WHERE id = 1').run();
		expect(evaluateTest(getSite(1)!, listTests(1)[0]).clicks.note).not.toMatch(/still downloading/);
	});

	it('weekly blocks stop at the first stored day instead of padding with zeros', () => {
		const days = Array.from({ length: 21 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 11) + i * 86400000).toISOString().slice(0, 10), clicks: 100, impressions: 1000, position: 5 }));
		const w = weeklyTotals(days, '2026-10-31', 26, '2026-10-11');
		expect(w).toHaveLength(3);
		expect(w.every((x) => x.clicks === 700)).toBe(true);
		expect(weeklyTotals(days, '2026-10-31', 26)).toHaveLength(26); // old behaviour, kept when no first date is given
		expect(projectClicks(w)).toBeNull(); // three weeks is not "8 complete weeks"
	});

	it('forecast for a young site refuses instead of projecting zero-padded history', async () => {
		const site = await fresh(25, 1);
		const f = forecastReport(site);
		expect(f.weekly).toHaveLength(3);
		expect(f.projection).toBeNull();
	});
});

// ── hostile input to the on-page parser ──────────────────────────────────────
describe('on-page parsing resists hostile pages', () => {
	const timed = (html: string) => { const s = Date.now(); parseOnPage(html); return Date.now() - s; };
	it('stays linear on thousands of unterminated tags (these were quadratic regexes: 40k took 3-4 s each)', () => {
		for (const bit of ['<!--', '<h1>', '<meta ', '<script>', '<style>', '<link ', '<title>', '<html ', '<meta name="description" content="']) {
			const ms = timed(bit.repeat(60_000));
			expect(ms, bit).toBeLessThan(800);
		}
	});
	it('a huge numeric entity does not throw', () => {
		const p = parseOnPage('<html><head><title>a &#99999999; b &#xFFFFFFF; c &#55357; d</title></head></html>');
		expect(p.title).toContain('a');
		expect(p.title).not.toBeNull();
	});
	it('reads attributes with ">" inside quotes and still handles ordinary pages', () => {
		const p = parseOnPage('<html lang="en"><head><meta name="description" content="a > b, c"><TITLE>Hi</TITLE></head><body><H1 class=x>Head <b>line</b></H1></body></html>');
		expect(p).toMatchObject({ description: 'a > b, c', title: 'Hi', lang: 'en', h1: ['Head line'] });
	});
});

// ── fetch confinement ────────────────────────────────────────────────────────
describe('on-page fetching refuses what it should', () => {
	afterEach(() => void delete process.env.ONPAGE_ALLOW_PRIVATE);
	const SITE = 'sc-domain:example.com';
	it('only the site itself or its subdomains, on standard ports, never an IP', () => {
		for (const ok of ['https://example.com/a', 'http://www.example.com/', 'https://blog.example.com/x', 'https://example.com:443/']) expect(hostAllowed(ok, SITE), ok).toBe(true);
		for (const bad of ['http://com/', 'https://evil.com/', 'https://example.com.evil.com/', 'http://example.com:6379/', 'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'http://[::1]/', 'ftp://example.com/', 'file:///etc/passwd', 'not a url']) expect(hostAllowed(bad, SITE), bad).toBe(false);
		expect(hostAllowed('https://shop.example.com/', 'https://blog.example.com/')).toBe(false); // a subdomain property does not open its siblings
		expect(hostAllowed('https://example.com/', 'https://blog.example.com/')).toBe(false); // or its parent
	});
	it('classifies private, loopback, link-local and reserved addresses', () => {
		for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '224.0.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1']) expect(isPrivateIp(a), a).toBe(true);
		for (const a of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '172.15.0.1', '2606:4700:4700::1111', '::ffff:8.8.8.8']) expect(isPrivateIp(a), a).toBe(false);
	});
	it('the real fetcher refuses localhost and IP literals at connect time, without needing the pre-check', async () => {
		const srv = http.createServer((_q, r) => r.writeHead(200, { 'content-type': 'text/html' }).end('<title>secret internal page</title>'));
		await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
		const port = (srv.address() as { port: number }).port;
		try {
			await expect(guardedFetch(`http://localhost:${port}/`, {})).rejects.toThrow(/Private address/);
			await expect(guardedFetch(`http://127.0.0.1:${port}/`, {})).rejects.toThrow(/Private address/);
			process.env.ONPAGE_ALLOW_PRIVATE = '1';
			const res = await guardedFetch(`http://127.0.0.1:${port}/`, {});
			expect(await res.text()).toContain('secret internal page');
			// and fetchPage turns the refusal into a plain error, never a throw
			delete process.env.ONPAGE_ALLOW_PRIVATE;
			const r = await fetchPage(`http://localhost:${port}/`, 'sc-domain:localhost');
			expect(r.html).toBeNull();
			expect(r.error).toBeTruthy();
		} finally {
			srv.close();
		}
	});
	it('a body that breaks mid-read, or a redirect with a body, is an error result, not an exception', async () => {
		const broken = vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('<html><title>x')); c.error(new Error('reset')); } }), { status: 200, headers: { 'content-type': 'text/html' } }));
		const r = await fetchPage('https://example.com/', SITE, broken as never);
		expect(r.html).toBeNull();
		expect(r.error).toMatch(/connection broke/);
		const cancelled = vi.fn();
		const redir = vi.fn(async () => new Response(new ReadableStream({ cancel: cancelled }), { status: 302, headers: { location: 'https://evil.com/' } }));
		expect((await fetchPage('https://example.com/', SITE, redir as never)).error).toMatch(/not part of this site/);
		expect(cancelled).toHaveBeenCalled(); // the unread body is released
	});
});

// ── dates ────────────────────────────────────────────────────────────────────
describe('test dates', () => {
	it('accepts only real calendar days', () => {
		expect(isRealDate('2026-02-28')).toBe(true);
		expect(isRealDate('2024-02-29')).toBe(true);
		for (const d of ['2026-02-31', '9999-99-99', '2026-13-01', '2026-00-10', '2026-1-1', 'yesterday', '']) expect(isRealDate(d), d).toBe(false);
	});
	it('rejects bad dates at creation, and one unreadable test cannot break the MCP list', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		expect(() => createTest(1, { name: 'x', kind: 'before_after', startDate: '2026-02-31', treatment: parseScope('/a/') })).toThrow(/real date/);
		createTest(1, { name: 'good', kind: 'before_after', startDate: '2026-02-01', treatment: parseScope('/a/') });
		db().prepare("INSERT INTO seo_tests (site_id,name,kind,start_date,window_days,treatment,control,meta,created_at) VALUES (1,'corrupt','before_after','9999-99-99',28,'{\"prefixes\":[\"/a/\"],\"urls\":[]}','{\"restOfSite\":true}','{}',1)").run();
		const key = createApiKey('k', null).key;
		const res = await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_seo_tests', arguments: { site: '1' } } }) }))).json();
		expect(res.result.isError).toBeUndefined();
		const list = JSON.parse(res.result.content[0].text) as { name: string; error?: string }[];
		expect(list.find((x) => x.name === 'corrupt')!.error).toMatch(/could not be evaluated/);
		expect(list.find((x) => x.name === 'good')!.error).toBeUndefined();
	});
});

// ── AI traffic ───────────────────────────────────────────────────────────────
describe('AI assistant traffic', () => {
	it('does not count unrelated sites that share a word with an assistant', () => {
		for (const s of ['gemini.com', 'exchange.gemini.com', 'platform.openai.com', 'copilot.money', 'claudeandco.com', 'some-gemini-fan-site.example', 'chatgpt.com.evil.example']) expect(assistantOf(s), s).toBeNull();
		for (const [s, a] of [['chatgpt.com', 'ChatGPT'], ['chat.openai.com', 'ChatGPT'], ['perplexity.ai', 'Perplexity'], ['www.perplexity.ai', 'Perplexity'], ['gemini.google.com', 'Gemini'], ['claude.ai', 'Claude'], ['copilot.microsoft.com', 'Copilot'], ['ChatGPT', 'ChatGPT']] as const) expect(assistantOf(s), s).toBe(a);
	});
	describe('report', () => {
		beforeEach(async () => {
			globalThis.__openSiteConsoleDb = openDb(':memory:');
			process.env.DEMO_MODE = '1';
			await ensureDemoAccounts();
			setLink(1, 'ga4', { accountId: 1, externalId: 'properties/1', label: 'x' });
		});
		it('says "pending" before the first period pull, "failed" when only the AI report failed, and "ok" otherwise', () => {
			const site = getSite(1)!;
			expect(aiTrafficReport(site, 28)).toMatchObject({ linked: true, status: 'pending' });
			db().prepare("UPDATE sites SET ga4_periods_on = '2026-10-31', ga4_ai_on = NULL WHERE id = 1").run();
			expect(aiTrafficReport(site, 28)).toMatchObject({ status: 'failed' }); // not a misleading "no sessions"
			db().prepare("UPDATE sites SET ga4_ai_on = '2026-10-31' WHERE id = 1").run();
			expect(aiTrafficReport(site, 28)).toMatchObject({ status: 'ok', sessions: 0 });
		});
		it('uses the same window for the AI sessions and for all sessions', () => {
			db().prepare("UPDATE sites SET ga4_periods_on = '2026-10-31', ga4_ai_on = '2026-10-31' WHERE id = 1").run();
			const ins = db().prepare("INSERT INTO ga4_daily VALUES (1,?,'Direct',?,0,0,0,0)");
			// 100 sessions a day for 28 days ending on the pull date, and a huge burst on the 3 later days that must not dilute the share
			for (let i = 0; i < 28; i++) ins.run(new Date(Date.UTC(2026, 9, 31) - i * 86400000).toISOString().slice(0, 10), 100);
			db().prepare("INSERT INTO ga4_ai VALUES (1,28,'ChatGPT','/',280,0,0,'2026-10-31')").run();
			const r = aiTrafficReport(getSite(1)!, 28);
			if (r.status !== 'ok') throw new Error('expected ok');
			expect(r.shareOfAllSessions).toBeCloseTo(280 / 2800, 6);
			expect(r.window).toEqual({ start: '2026-10-04', end: '2026-10-31' });
		});
	});
});

// ── groups, scopes, performance ──────────────────────────────────────────────
describe('groups and scopes', () => {
	const m = (clicks: number) => ({ clicks, impressions: clicks * 10, position: 5 });
	it('a domain property with several hosts keeps their folders apart', () => {
		const pages = [{ page: 'https://www.x.com/blog/a', ...m(5) }, { page: 'https://shop.x.com/blog/b', ...m(7) }];
		expect(spansHosts(pages.map((p) => p.page))).toBe(true);
		expect(groupPages(pages, []).map((g) => g.key).sort()).toEqual(['shop.x.com/blog/', 'x.com/blog/']);
		expect(groupPages(pages.slice(0, 1), []).map((g) => g.key)).toEqual(['/blog/']); // one host: plain folders
		expect(urlSection('https://www.x.com/a/b', 1, true)).toBe('x.com/a/');
	});
	it('"unclustered" does not count clusters that were merely cut by the display limit', () => {
		const words = ['alpha', 'beta', 'gamma', 'delta', 'omega'];
		const rows = words.flatMap((w) => Array.from({ length: 4 }, (_, i) => ({ query: `${w} item${w}${i}`, ...m(5) })));
		expect(topicClusters(rows, { minQueries: 3, limit: 100 }).unclusteredShare).toBeCloseTo(0, 5);
		const cut = topicClusters(rows, { minQueries: 3, limit: 2 });
		expect(cut.clusters).toHaveLength(2);
		expect(cut.unclusteredShare).toBeCloseTo(0, 5);
	});
	it('scopes: no comma splitting, and a bare "blog/" means "/blog/"', () => {
		expect(parseScope('blog/ /shop/* https://x.com/p?a=1,2')).toEqual({ prefixes: ['/blog/', '/shop/'], urls: ['https://x.com/p?a=1,2'] });
	});
	it('country grouping and topic clustering stay fast on big inputs (both were quadratic: 61 s for 150k rows)', () => {
		const rows = Array.from({ length: 80_000 }, (_, i) => ({ query: `q${i % 9000}`, page: `https://x.com/p${i % 700}`, country: 'usa', clicks: i % 5, impressions: 30 + (i % 20), position: 3 + (i % 15) }));
		let s = Date.now();
		countryCannibalization(rows, fitCtrCurve([]));
		expect(Date.now() - s).toBeLessThan(6000);
		const many = Array.from({ length: 25_000 }, (_, i) => ({ query: `common${i % 4} word${i}`, clicks: 1, impressions: 10, position: 5 }));
		s = Date.now();
		topicClusters(many);
		expect(Date.now() - s).toBeLessThan(3000);
	}, 30_000);
});
