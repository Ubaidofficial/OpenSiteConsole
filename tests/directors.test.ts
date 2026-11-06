import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { addManualUpdate, importGoogleUpdates, kindOf, listUpdates, parseIncidents, removeManualUpdate, updatesBetween } from '../src/lib/server/gupdates';
import { createTest, evaluateTest, evaluateTestCached, listTests, testsByAnnotation } from '../src/lib/server/seotests';
import { parseSitemapXml } from '../src/lib/sitemap';
import { diagnoseSitemap, sitemapCoverage, sitemapText, syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { actionsFor, actionStates, buildActions, portfolioQueue, queueFor, setActionState } from '../src/lib/server/actions';
import { keyHash, rankActions, scoreOf, statusOf, type ActionItem } from '../src/lib/actions';
import { monitorSite } from '../src/lib/server/indexmon';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { parseScope } from '../src/lib/experiments';
import type { GscClient } from '../src/lib/server/google';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const dates = (from: string, to: string) => { const o: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) o.push(d.toISOString().slice(0, 10)); return o; };
const feed = JSON.parse(readFileSync('tests/fixtures/google-incidents.json', 'utf8'));

// ── Google updates ───────────────────────────────────────────────────────────
describe('Google ranking updates', () => {
	beforeEach(() => void (globalThis.__openSiteConsoleDb = openDb(':memory:')));
	it('reads the real Search Status Dashboard feed: updates in, the outage out', () => {
		const u = parseIncidents(feed);
		expect(u).toHaveLength(8);
		expect(u.map((x) => x.name)).not.toContain('Serving was experiencing an issue');
		const may = u.find((x) => x.name === 'May 2026 core update')!;
		expect(may).toMatchObject({ kind: 'core', begin: '2026-05-21', end: '2026-06-02', source: 'google' });
		expect(u.find((x) => x.name === 'August 2026 spam update')!.kind).toBe('spam');
		expect(u.find((x) => x.name === 'February 2026 Discover update')!.kind).toBe('discover');
		expect(u.every((x) => x.id.startsWith('g:'))).toBe(true);
	});
	it('names kinds sensibly and survives garbage', () => {
		expect([kindOf('March 2026 core update'), kindOf('X spam update'), kindOf('Discover core update'), kindOf('Something else')]).toEqual(['core', 'spam', 'discover', 'other']);
		for (const bad of [null, 5, 'x', {}, [null, 3, 'a'], [{ service_name: 'Ranking' }], [{ service_name: 'Ranking', external_desc: 'x', begin: 'yesterday', id: 'a' }], [{ service_name: 'Serving', external_desc: 'May core update', begin: '2026-05-01T00:00:00Z', id: 'a' }]]) expect(parseIncidents(bad)).toEqual([]);
	});
	it('imports, is idempotent, counts changes, and keeps what it has seen when a later feed is shorter', async () => {
		const ok = (async () => json(feed)) as never;
		expect(await importGoogleUpdates(ok)).toMatchObject({ ok: true, added: 8, updated: 0, total: 8 });
		expect(await importGoogleUpdates(ok)).toMatchObject({ ok: true, added: 0, updated: 0 });
		const changed = structuredClone(feed); changed.find((x: { external_desc: string }) => x.external_desc === 'May 2026 core update').end = '2026-06-09T00:00:00+00:00';
		expect(await importGoogleUpdates((async () => json(changed)) as never)).toMatchObject({ added: 0, updated: 1 });
		expect(await importGoogleUpdates((async () => json(feed.slice(0, 2))) as never)).toMatchObject({ ok: true });
		expect(listUpdates()).toHaveLength(8); // the dashboard forgot six; the app did not
	});
	it('reports failures without throwing', async () => {
		expect(await importGoogleUpdates((async () => new Response('x', { status: 503 })) as never)).toMatchObject({ ok: false, error: expect.stringMatching(/503/) });
		expect(await importGoogleUpdates((async () => new Response('<html>', { status: 200 })) as never)).toMatchObject({ ok: false, error: expect.stringMatching(/valid JSON/) });
		expect(await importGoogleUpdates((async () => { throw new Error('offline'); }) as never)).toMatchObject({ ok: false });
		expect(await importGoogleUpdates((async () => new Response('['.padEnd(5_000_000, ' '), { status: 200 })) as never)).toMatchObject({ ok: false, error: expect.stringMatching(/large/) });
	});
	it('manual updates are validated, and only manual ones can be removed', async () => {
		await importGoogleUpdates((async () => json(feed)) as never);
		expect(() => addManualUpdate('', '2025-03-13', null)).toThrow(/name/);
		expect(() => addManualUpdate('x', '2025-02-30', null)).toThrow(/real date/);
		expect(() => addManualUpdate('x', '2025-03-13', '2025-03-01')).toThrow(/on or after/);
		const id = addManualUpdate('March 2025 core update', '2025-03-13', '2025-03-27');
		expect(listUpdates().find((u) => u.id === id)).toMatchObject({ kind: 'core', source: 'manual' });
		removeManualUpdate('g:XhUDXP7A67iHCD2kmbVu');
		expect(listUpdates().some((u) => u.id === 'g:XhUDXP7A67iHCD2kmbVu')).toBe(true);
		removeManualUpdate(id);
		expect(listUpdates().some((u) => u.id === id)).toBe(false);
	});
	it('finds updates overlapping a window, including ones still rolling out', async () => {
		await importGoogleUpdates((async () => json(feed)) as never);
		expect(updatesBetween('2026-05-25', '2026-05-30').map((u) => u.name)).toEqual(['May 2026 core update']);
		expect(updatesBetween('2026-06-03', '2026-06-20')).toEqual([]);
		expect(updatesBetween('2026-03-20', '2026-03-26').map((u) => u.name).sort()).toEqual(['March 2026 spam update']);
		addManualUpdate('Open-ended', '2026-10-30', null);
		expect(updatesBetween('2026-11-01', '2026-11-03').map((u) => u.name)).toContain('Open-ended');
	});
});

describe('tests know about Google updates and change-log entries', () => {
	const START = '2026-06-01';
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const d = db();
		d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
		const ins = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','MOBILE',?,?,5)");
		d.transaction(() => { for (const day of dates('2025-12-01', '2026-06-30')) { for (let i = 0; i < 5; i++) ins.run(day, `q t${i}`, `https://x.example/t/${i}`, 8 + (i % 3), 160); for (let i = 0; i < 20; i++) ins.run(day, `q c${i}`, `https://x.example/c/${i}`, 10 + (i % 4), 200); } })();
		d.prepare("UPDATE sites SET synced_through = '2026-06-30', backfill_done = 1, last_sync_at = 1 WHERE id = 1").run();
		createTest(1, { name: 't', kind: 'before_after', startDate: START, treatment: parseScope('/t/'), annotationId: 7 });
	});
	it('flags which window an update overlaps, and recomputes when the update list changes', () => {
		const site = () => getSite(1)!;
		expect(evaluateTest(site(), listTests(1)[0]).updates).toEqual([]);
		const first = evaluateTestCached(site(), listTests(1)[0]);
		expect(first.updates).toEqual([]);
		addManualUpdate('June core update', '2026-06-10', '2026-06-24');
		addManualUpdate('Earlier spam update', '2026-05-10', '2026-05-12');
		addManualUpdate('Spans the change', '2026-05-28', '2026-06-04');
		const o = evaluateTestCached(site(), listTests(1)[0]); // the cache must notice
		const w = Object.fromEntries(o.updates.map((u) => [u.name, u.window]));
		expect(w).toEqual({ 'June core update': 'after', 'Earlier spam update': 'before', 'Spans the change': 'both' });
	});
	it('finds the test created from a change-log entry', () => {
		expect(testsByAnnotation(1).get(7)?.name).toBe('t');
		expect(testsByAnnotation(1).get(8)).toBeUndefined();
	});
});

// ── sitemaps ─────────────────────────────────────────────────────────────────
describe('sitemap parsing', () => {
	it('keeps the FIRST entry (a real sitemap lost it because "<urlset" matched "<url")', () => {
		const p = parseSitemapXml(readFileSync('tests/fixtures/sitemap-real-shape.xml', 'utf8'));
		expect(p.kind).toBe('urlset');
		expect(p.entries).toHaveLength(8);
		expect(p.entries[0]).toEqual({ loc: 'https://bookmentions.net', lastmod: '2026-11-05' });
	});
	it('does the same for a sitemap index', () => {
		const p = parseSitemapXml('<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>https://x.com/a.xml</loc></sitemap><sitemap><loc>https://x.com/b.xml</loc><lastmod>2026-01-02</lastmod></sitemap></sitemapindex>');
		expect(p.kind).toBe('index');
		expect(p.entries.map((e) => e.loc)).toEqual(['https://x.com/a.xml', 'https://x.com/b.xml']);
	});
	it('handles CDATA, entities, whitespace, odd dates and junk entries', () => {
		const p = parseSitemapXml(`<urlset><url><loc> <![CDATA[https://x.com/a?x=1&y=2]]> </loc></url><url><loc>https://x.com/b?x=1&amp;y=2</loc><lastmod>2026-02-03T10:00:00+00:00</lastmod></url><url><loc>ftp://x.com/c</loc></url><url><loc>notaurl</loc></url><url><lastmod>2026-01-01</lastmod></url><url><loc>https://x.com/d</loc><lastmod>soon</lastmod></url></urlset>`);
		expect(p.entries).toEqual([{ loc: 'https://x.com/a?x=1&y=2', lastmod: null }, { loc: 'https://x.com/b?x=1&y=2', lastmod: '2026-02-03' }, { loc: 'https://x.com/d', lastmod: null }]);
	});
	it('says "unknown" for things that are not sitemaps, and stops at an unterminated element', () => {
		expect(parseSitemapXml('<html><body>Please log in</body></html>').kind).toBe('unknown');
		expect(parseSitemapXml('<urlset><url><loc>https://x.com/1</loc></url><url><loc>https://x.com/2</loc>').entries).toHaveLength(1);
	});
	it('is linear on hostile input and honours the 50,000 limit (an entry with no <lastmod> once scanned the whole file: 41 s)', () => {
		for (const bit of ['<url>', '<url><loc>', '<loc>https://x.com/a</loc>', '<!--', '<sitemap>']) {
			const t = Date.now();
			parseSitemapXml('<urlset>' + bit.repeat(80_000));
			expect(Date.now() - t, bit).toBeLessThan(1500);
		}
		const big = '<urlset>' + Array.from({ length: 50_010 }, (_, i) => `<url><loc>https://x.com/${i}</loc></url>`).join('') + '</urlset>';
		const p = parseSitemapXml(big);
		expect(p.entries).toHaveLength(50_000);
		expect(p.truncated).toBe(true);
	}, 30_000);
	it('decompresses gzip by its magic bytes, not its name', () => {
		const xml = '<urlset><url><loc>https://x.com/z</loc></url></urlset>';
		expect(sitemapText(gzipSync(Buffer.from(xml)))).toBe(xml);
		expect(sitemapText(Buffer.from(xml))).toBe(xml);
	});
});

describe('sitemap sync, coverage and diagnosis', () => {
	const SITE = 'sc-domain:x.example';
	const xml = (urls: [string, string?][]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(([u, m]) => `<url><loc>${u}</loc>${m ? `<lastmod>${m}</lastmod>` : ''}</url>`).join('')}</urlset>`;
	const site = () => getSite(1)!;
	const gsc = (paths: string[], info: object = {}): GscClient => ({ listSitemaps: async () => paths.map((path) => ({ path, ...info })) }) as never;
	const serve = (files: Record<string, string | Buffer>, calls: string[] = []) => (async (u: string) => { calls.push(u); const f = files[u]; return f === undefined ? new Response('nope', { status: 404 }) : new Response(f as never, { status: 200, headers: { 'content-type': u.endsWith('.gz') ? 'application/gzip' : 'application/xml' } }); }) as never;

	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		db().prepare("UPDATE sites SET site_url = ? WHERE id = 1").run(SITE);
		const ins = db().prepare("INSERT INTO sa_rows VALUES (1,?,'q',?,'usa','MOBILE',?,?,5)");
		for (const day of dates('2026-08-10', '2026-10-30')) { ins.run(day, 'https://www.x.example/a/', 5, 50); if (day > '2026-09-30') ins.run(day, 'https://x.example/b', 2, 20); ins.run(day, 'https://x.example/only-in-gsc', 3, 30); }
		db().prepare("UPDATE sites SET synced_through = '2026-10-30', backfill_done = 1 WHERE id = 1").run();
	});

	it('reads an index, its children and a gzipped file; keeps duplicates out; ignores other hosts', async () => {
		const files = {
			'https://x.example/sitemap_index.xml': '<sitemapindex><sitemap><loc>https://x.example/s1.xml</loc></sitemap><sitemap><loc>https://x.example/s2.xml.gz</loc></sitemap><sitemap><loc>https://evil.example/s3.xml</loc></sitemap></sitemapindex>',
			'https://x.example/s1.xml': xml([['https://x.example/a', '2026-08-01'], ['https://x.example/b'], ['https://x.example/a']]),
			'https://x.example/s2.xml.gz': gzipSync(Buffer.from(xml([['https://x.example/c', '2026-10-28']])))
		};
		const calls: string[] = [];
		const r = await syncSitemapUrls(1, { client: gsc(['https://x.example/sitemap_index.xml']), fetchImpl: serve(files, calls) });
		expect(r).toMatchObject({ sitemaps: 4, urls: 3 }); // a, b, c
		expect(calls).not.toContain('https://evil.example/s3.xml'); // never fetched: not this site
		expect(r.error).toMatch(/evil\.example.*not on this site/);
	});

	it('keeps the previous snapshot when nothing can be read', async () => {
		await syncSitemapUrls(1, { client: gsc(['https://x.example/s.xml']), fetchImpl: serve({ 'https://x.example/s.xml': xml([['https://x.example/a'], ['https://x.example/b']]) }) });
		const r = await syncSitemapUrls(1, { client: gsc(['https://x.example/s.xml']), fetchImpl: serve({}) });
		expect(r.urls).toBe(0);
		expect(r.error).toMatch(/404/);
		expect((db().prepare('SELECT COUNT(*) n FROM sitemap_urls WHERE site_id = 1').get() as { n: number }).n).toBe(2);
		expect(sitemapCoverage(site()).totalUrls).toBe(2);
		expect(sitemapCoverage(site()).error).toMatch(/404/);
	});

	it('coverage: matches despite www / slash / query, separates never-shown from too-new, lists click-earners that are missing', async () => {
		const files = { 'https://x.example/s.xml': xml([['https://x.example/a', '2026-01-01'], ['https://x.example/b?utm=1'], ['https://x.example/never-1', '2026-02-01'], ['https://x.example/never-2', '2026-09-01'], ['https://x.example/too-new', '2026-10-25']]) };
		await syncSitemapUrls(1, { client: gsc(['https://x.example/s.xml']), fetchImpl: serve(files) });
		const c = sitemapCoverage(site());
		expect(c.totalUrls).toBe(5);
		expect(c.shown).toBe(2); // /a (seen as www + trailing slash) and /b (seen without the query)
		expect(c.neverShown.count).toBe(2);
		expect(c.neverShown.tooNew).toBe(1);
		expect(c.neverShown.sample.map((s) => s.url)).toEqual(['https://x.example/never-2', 'https://x.example/never-1']); // newest first
		expect(c.notInSitemap.sample.map((s) => s.url)).toEqual(['https://x.example/only-in-gsc']);
		expect(c.notInSitemap.clicks).toBe(3 * 82);
		expect(c.window.complete).toBe(true);
		expect(sitemapCoverage({ ...site(), backfill_done: 0, backfilled_to: '2026-10-20' }).window.complete).toBe(false);
	});

	it('the indexing monitor checks never-shown sitemap URLs before pages that lost visibility and the top pages', async () => {
		await syncSitemapUrls(1, { client: gsc(['https://x.example/s.xml']), fetchImpl: serve({ 'https://x.example/s.xml': xml([['https://x.example/never-1', '2026-02-01'], ['https://x.example/never-2', '2026-02-02']]) }) });
		const calls: string[] = [];
		const stub = { inspectUrl: async (_s: string, u: string) => (calls.push(u), { indexStatusResult: { verdict: 'PASS' } }) } as never;
		const r = await monitorSite(1, { client: stub, limit: 3 });
		expect(r.candidates.gap).toBe(2);
		expect(calls.slice(0, 2).sort()).toEqual(['https://x.example/never-1', 'https://x.example/never-2']);
	});

	it('diagnosis: explains pending, count differences, redirects, wrong hosts, wrong content, and says when nothing is wrong', async () => {
		const good = serve({ 'https://x.example/s.xml': xml([['https://x.example/1'], ['https://x.example/2'], ['https://x.example/3']]), 'https://x.example/robots.txt': 'Sitemap: https://x.example/s.xml' });
		const google = { path: 'https://x.example/s.xml', isPending: true, lastDownloaded: '2026-11-02T10:00:00Z', contents: [{ type: 'web', submitted: 2 }] };
		const a = await diagnoseSitemap('https://x.example/s.xml', SITE, google, good);
		expect(a).toMatchObject({ reachable: true, kind: 'urlset', urls: 3, googleCounted: 2, googlePending: true, robotsListsIt: true });
		const text = a.notes.map((n) => n.text).join(' | ');
		expect(text).toMatch(/1 more URLs than Google last counted \(2, read 2026-11-02\)/);
		expect(text).toMatch(/pending.*normal.*Last read/);
		expect(text).toMatch(/Nothing is wrong with the file itself/);
		const html = await diagnoseSitemap('https://x.example/s.xml', SITE, undefined, serve({ 'https://x.example/s.xml': '<html>Log in</html>' }));
		expect(html.kind).toBe('unknown');
		expect(html.notes[0]).toMatchObject({ level: 'bad' });
		const other = await diagnoseSitemap('https://x.example/s.xml', SITE, undefined, serve({ 'https://x.example/s.xml': xml([['https://x.example/1'], ['https://other.example/2'], ['https://x.example/1']]) }));
		expect(other.otherHosts).toEqual(['other.example']);
		expect(other.duplicates).toBe(1);
		expect(other.notes.some((n) => n.level === 'warn' && /other hosts/.test(n.text))).toBe(true);
		const redirect = (async (u: string) => (u.endsWith('old.xml') ? new Response(null, { status: 301, headers: { location: 'https://x.example/s.xml' } }) : new Response(xml([['https://x.example/1']]), { status: 200, headers: { 'content-type': 'text/plain' } }))) as never;
		const rd = await diagnoseSitemap('https://x.example/old.xml', SITE, undefined, redirect);
		expect(rd.notes.some((n) => /redirects to https:\/\/x\.example\/s\.xml/.test(n.text))).toBe(true);
		const gone = await diagnoseSitemap('https://x.example/s.xml', SITE, undefined, serve({}));
		expect(gone.reachable).toBe(false);
		expect(gone.notes[0].text).toMatch(/Could not fetch it/);
		const offsite = await diagnoseSitemap('https://evil.example/s.xml', SITE, undefined, good);
		expect(offsite.reachable).toBe(false);
	});
});

// ── the action queue ─────────────────────────────────────────────────────────
const item = (o: Partial<ActionItem>): ActionItem => ({ key: 'k', type: 'striking', siteId: 1, title: 't', why: '', how: '', impact: null, confidence: 'medium', effort: 'low', blocking: false, href: '/', evidence: [], ...o });

describe('ranking', () => {
	it('blocking first, then impact x confidence, then unquantified, then a fixed order', () => {
		const r = rankActions([
			item({ key: 'small', impact: 50, confidence: 'high' }),
			item({ key: 'big-low-conf', impact: 400, confidence: 'low' }), // 120
			item({ key: 'mid-med', impact: 150, confidence: 'medium' }), // 90
			item({ key: 'none-onpage', type: 'onpage', impact: null }),
			item({ key: 'none-tracking-warn', type: 'tracking', impact: null }),
			item({ key: 'block-small', type: 'blocked', impact: 5, confidence: 'high', blocking: true }),
			item({ key: 'block-big', type: 'tracking', impact: null, blocking: true }),
			item({ key: 'block-big2', type: 'deindexed', impact: 900, confidence: 'high', blocking: true })
		]);
		expect(r.map((x) => x.key)).toEqual(['block-big2', 'block-small', 'block-big', 'big-low-conf', 'mid-med', 'small', 'none-tracking-warn', 'none-onpage']);
		// (the two blocking items with impact outrank the unquantified blocking one; ties inside a group follow the type order)
	});
	it('a low-confidence giant can outrank a sure small win, but not a blocking problem', () => {
		expect(scoreOf(item({ impact: 1000, confidence: 'low' }))).toBeGreaterThan(scoreOf(item({ impact: 100, confidence: 'high' })));
		expect(rankActions([item({ key: 'a', impact: 1e6, confidence: 'high' }), item({ key: 'b', blocking: true })])[0].key).toBe('b');
	});
	it('is deterministic and does not mutate its input', () => {
		const xs = [item({ key: 'b' }), item({ key: 'a' })];
		const copy = [...xs];
		expect(rankActions(xs).map((x) => x.key)).toEqual(['a', 'b']);
		expect(xs).toEqual(copy);
	});
	it('hashes are stable and sensitive; done/snoozed expire', () => {
		expect(keyHash(['a', 'b'])).toBe(keyHash(['a', 'b']));
		expect(keyHash(['a', 'b'])).not.toBe(keyHash(['b', 'a']));
		const now = 1000;
		expect(statusOf(undefined, now)).toBe('open');
		expect(statusOf({ state: 'done', until: now + 1 }, now)).toBe('done');
		expect(statusOf({ state: 'snoozed', until: now + 1 }, now)).toBe('snoozed');
		expect(statusOf({ state: 'done', until: now }, now)).toBe('open'); // expired: a problem that is still there comes back
	});
});

describe('building the queue from a site', () => {
	let key = '';
	beforeAll(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		for (const id of [1, 2]) {
			const client = new DemoClient('demo-a');
			let guard = 0;
			await syncSite(id, { client, backfillChunkDays: 120 });
			while (!getSite(id)!.backfill_done && guard++ < 12) await syncSite(id, { client, backfillChunkDays: 120 });
		}
		key = createApiKey('only site 1', [1]).key;
	}, 120_000);
	const site = () => getSite(1)!;

	it('produces well-formed, uniquely keyed, correctly ordered items from the demo data', () => {
		const items = actionsFor(site());
		expect(items.length).toBeGreaterThan(3);
		expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
		for (const i of items) {
			expect(i.title.length).toBeGreaterThan(5);
			expect(i.how.length).toBeGreaterThan(10);
			expect(['high', 'medium', 'low']).toContain(i.confidence);
			expect(i.href.startsWith('/sites/1')).toBe(true);
			if (i.impact != null) expect(i.impact).toBeGreaterThanOrEqual(0);
		}
		expect(items).toEqual(rankActions(items));
		const types = new Set(items.map((i) => i.type));
		expect([...types].some((t) => ['cannibalization', 'ctr-gap', 'striking', 'decay'].includes(t))).toBe(true);
	});

	it('blocked pages, de-indexed pages and a collapse in traffic come out as blocking items', () => {
		const d = db();
		const page = (d.prepare('SELECT page FROM sa_rows WHERE site_id = 1 GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 1').get() as { page: string }).page;
		const other = (d.prepare('SELECT page FROM sa_rows WHERE site_id = 1 GROUP BY page ORDER BY SUM(clicks) DESC LIMIT 1 OFFSET 1').get() as { page: string }).page;
		d.prepare('INSERT OR REPLACE INTO url_inspections VALUES (1,?,?,?)').run(page, Date.now(), JSON.stringify({ indexStatusResult: { verdict: 'NEUTRAL', robotsTxtState: 'DISALLOWED' } }));
		d.prepare("INSERT INTO index_events (site_id,url,at,kind,detail) VALUES (1,?,?,'deindexed','Crawled - currently not indexed')").run(other, Date.now() - 86400000);
		const items = buildActions(site());
		const blocked = items.find((i) => i.type === 'blocked')!;
		expect(blocked).toMatchObject({ blocking: true, confidence: 'high' });
		expect(blocked.impact).toBeGreaterThan(0);
		expect(blocked.evidence[0]).toContain(new URL(page).pathname);
		const dropped = items.find((i) => i.type === 'deindexed')!;
		expect(dropped.title).toMatch(/dropped 1 page/);
		expect(items.find((i) => i.type === 'deindexed')!.evidence[0]).toContain(new URL(other).pathname);
		// the same page is not reported twice (blocked wins over the other findings)
		expect(items.filter((i) => i.type === 'deindexed' && i.evidence.some((e) => e.startsWith(new URL(page).pathname + ' (')))).toHaveLength(0);
		// a collapse
		d.prepare("UPDATE sa_rows SET clicks = CAST(clicks * 0.4 AS INTEGER) WHERE site_id = 1 AND date > date((SELECT synced_through FROM sites WHERE id = 1), '-27 day')").run();
		d.prepare("UPDATE site_daily SET clicks = CAST(clicks * 0.4 AS INTEGER) WHERE site_id = 1 AND date > date((SELECT synced_through FROM sites WHERE id = 1), '-27 day')").run();
		const after = buildActions(site());
		const sw = after.find((i) => i.type === 'sitewide')!;
		expect(sw.blocking).toBe(true); // -60% is an emergency
		expect(sw.impact).toBeGreaterThan(1000);
		expect(rankActions(after).slice(0, 3).every((i) => i.blocking)).toBe(true);
	});

	it('mentions a Google update that overlaps a decline, and tells you not to overreact', () => {
		addManualUpdate('Test core update', getSite(1)!.synced_through!.slice(0, 8) + '01', null);
		const sw = buildActions(site()).find((i) => i.type === 'sitewide')!;
		expect(sw.how).toMatch(/Google update.*Do not make sweeping changes/);
		expect(sw.evidence.join(' ')).toMatch(/Test core update/);
	});

	it('done and snooze hide an item, expire, and can be restored; the result is cached until something changes', () => {
		const first = queueFor(site()).open[0];
		setActionState(1, first.key, 'done');
		expect(queueFor(site()).open.some((i) => i.key === first.key)).toBe(false);
		expect(queueFor(site()).hidden.find((i) => i.key === first.key)).toMatchObject({ status: 'done' });
		db().prepare('UPDATE action_state SET until = ? WHERE site_id = 1').run(Date.now() - 1); // expired
		expect(queueFor(site()).open.some((i) => i.key === first.key)).toBe(true);
		setActionState(1, first.key, 'snoozed');
		expect(queueFor(site()).hidden.find((i) => i.key === first.key)).toMatchObject({ status: 'snoozed' });
		setActionState(1, first.key, 'open');
		expect(actionStates(1).size).toBe(0);
		// cache: tamper with the stored payload and it comes back; a sync (last_sync_at) invalidates it
		const cached = actionsFor(site());
		db().prepare("UPDATE action_cache SET payload = '[]' WHERE site_id = 1").run();
		expect(actionsFor(site())).toEqual([]);
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(Date.now() + 5);
		expect(actionsFor(getSite(1)!)).toEqual(cached.length ? expect.arrayContaining([expect.objectContaining({ key: cached[0].key })]) : []);
	});

	it('across sites: ranked together, each labelled, and a site-limited API key sees only its own', async () => {
		const all = portfolioQueue(200);
		expect(new Set(all.map((i) => i.siteId)).size).toBeGreaterThanOrEqual(1);
		expect(all.every((i) => typeof i.site === 'string' && i.site.length > 0)).toBe(true);
		expect(all).toEqual(rankActions(all));
		const call = async (args: object) => (await (await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_action_queue', arguments: args } }) }))).json()).result;
		const own = await call({});
		expect(own.isError).toBeUndefined();
		const items = JSON.parse(own.content[0].text) as { site: string }[];
		expect(items.length).toBeGreaterThan(0);
		expect(new Set(items.map((i) => i.site))).toEqual(new Set(['greenleaf.example'])); // never site 2
		expect((await call({ site: '2' })).isError).toBe(true);
		const one = JSON.parse((await call({ site: '1', limit: 3 })).content[0].text);
		expect(one.items.length).toBeLessThanOrEqual(3);
		expect(one.items[0]).toHaveProperty('whatToDo');
	});
});
