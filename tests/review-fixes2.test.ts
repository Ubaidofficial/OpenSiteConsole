import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { inProperty } from '../src/lib/property';
import { syncSitemapUrls } from '../src/lib/server/sitemapcov';
import { armOf, scopeHostsOutside, conversionsFor } from '../src/lib/server/ga4tests';
import { scopeMatcher } from '../src/lib/experiments';
import { runUrgentAlerts, runWeeklyDigest, listDigests } from '../src/lib/server/digest';
import { portfolioQueue, actionsFor } from '../src/lib/server/actions';
import { headlineOf } from '../src/lib/digest';
import { organicLandingDaily } from '../src/lib/server/ga4';
import type { GscClient } from '../src/lib/server/google';

describe('property membership (a sitemap can list URLs that are not this property)', () => {
	it('domain property: host and subdomains, either scheme; nothing else', () => {
		expect(inProperty('https://x.example/a', 'sc-domain:x.example')).toBe(true);
		expect(inProperty('http://www.x.example/a', 'sc-domain:x.example')).toBe(true);
		expect(inProperty('https://blog.x.example/a', 'sc-domain:x.example')).toBe(true);
		expect(inProperty('https://notx.example/a', 'sc-domain:x.example')).toBe(false);
		expect(inProperty('https://x.example.evil.com/a', 'sc-domain:x.example')).toBe(false);
		expect(inProperty('ftp://x.example/a', 'sc-domain:x.example')).toBe(false);
	});
	it('URL-prefix property: exact scheme and host (www differs), path prefix', () => {
		expect(inProperty('https://www.x.example/page', 'https://www.x.example/')).toBe(true);
		expect(inProperty('https://x.example/page', 'https://www.x.example/')).toBe(false);
		expect(inProperty('http://www.x.example/page', 'https://www.x.example/')).toBe(false);
		expect(inProperty('https://www.x.example/blog/a', 'https://www.x.example/blog/')).toBe(true);
		expect(inProperty('https://www.x.example/shop/a', 'https://www.x.example/blog/')).toBe(false);
		expect(inProperty('nonsense', 'https://www.x.example/')).toBe(false);
	});
});

describe('sitemap sync: off-property URLs and partial reads', () => {
	const xml = (urls: string[]) => `<urlset>${urls.map((u) => `<url><loc>${u}</loc></url>`).join('')}</urlset>`;
	const gsc = (paths: string[]): GscClient => ({ listSitemaps: async () => paths.map((path) => ({ path })) }) as never;
	const serve = (files: Record<string, string>) => (async (u: string) => (files[u] === undefined ? new Response('x', { status: 500 }) : new Response(files[u], { status: 200 }))) as never;
	const count = () => (db().prepare('SELECT COUNT(*) n FROM sitemap_urls WHERE site_id = 1').get() as { n: number }).n;
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
	});
	it('leaves out URLs of another host, so the indexing monitor never queues an address Google would refuse', async () => {
		db().prepare("UPDATE sites SET site_url = 'https://www.x.example/' WHERE id = 1").run();
		const r = await syncSitemapUrls(1, { client: gsc(['https://www.x.example/s.xml']), fetchImpl: serve({ 'https://www.x.example/s.xml': xml(['https://www.x.example/a', 'https://x.example/b', 'http://www.x.example/c']) }) });
		expect(r.urls).toBe(1);
		expect(r.offProperty).toBe(2);
		expect((db().prepare('SELECT url FROM sitemap_urls WHERE site_id = 1').all() as { url: string }[]).map((x) => x.url)).toEqual(['https://www.x.example/a']);
	});
	it('a read in which one file failed neither deletes URLs nor reports them as removed, and recovery reports no false "added"', async () => {
		db().prepare("UPDATE sites SET site_url = 'sc-domain:x.example' WHERE id = 1").run();
		const idx = 'https://x.example/i.xml';
		const files: Record<string, string> = {
			[idx]: '<sitemapindex><sitemap><loc>https://x.example/a.xml</loc></sitemap><sitemap><loc>https://x.example/b.xml</loc></sitemap></sitemapindex>',
			'https://x.example/a.xml': xml(['https://x.example/a1', 'https://x.example/a2']),
			'https://x.example/b.xml': xml(['https://x.example/b1', 'https://x.example/b2'])
		};
		await syncSitemapUrls(1, { client: gsc([idx]), fetchImpl: serve(files) });
		expect(count()).toBe(4);
		const { 'https://x.example/b.xml': gone, ...partial } = files;
		const bad = await syncSitemapUrls(1, { client: gsc([idx]), fetchImpl: serve(partial) });
		expect(bad.error).toMatch(/500/);
		expect(bad.changes).toBeNull();
		expect(count()).toBe(4); // nothing deleted
		const ok = await syncSitemapUrls(1, { client: gsc([idx]), fetchImpl: serve({ ...partial, 'https://x.example/b.xml': gone }) });
		expect(ok.changes?.added).toEqual([]); // b1 and b2 were never "removed", so they are not "added"
		expect(ok.changes?.removed).toEqual([]);
	});
});

describe('GA4 arms for a test', () => {
	const T = scopeMatcher({ urls: [], prefixes: ['https://ga4.local/blog/'] });
	it("a section's own page (GA4 '/blog', Search Console '/blog/') belongs to the section, not the control", () => {
		expect(armOf('/blog', T, null)).toBe(1);
		expect(armOf('/blog/post', T, null)).toBe(1);
		expect(armOf('/pricing', T, null)).toBe(2);
		expect(armOf('/blogger', T, null)).toBe(2); // not the section: only /blog and /blog/...
		expect(armOf('/', T, null)).toBe(2);
	});
	it('a named control excludes everything else', () => {
		const C = scopeMatcher({ urls: [], prefixes: ['https://ga4.local/shop/'] });
		expect(armOf('/shop', T, C)).toBe(2);
		expect(armOf('/pricing', T, C)).toBe(0);
	});
	it('a test on another host cannot be separated in GA4 (landing pages carry no hostname) and says so', () => {
		expect(scopeHostsOutside({ urls: [], prefixes: ['https://blog.x.example/'] }, 'sc-domain:x.example')).toEqual(['blog.x.example']);
		expect(scopeHostsOutside({ urls: ['https://www.x.example/a'], prefixes: ['/guides/'] }, 'sc-domain:x.example')).toEqual([]);
		expect(scopeHostsOutside({ urls: [], prefixes: ['https://x.example/blog/'] }, 'https://www.x.example/')).toEqual([]);
	});
});

describe('GA4 daily load never truncates silently', () => {
	it('throws instead of dropping the newest days when the row cap is hit', async () => {
		const page = (n: number) => ({ rows: Array.from({ length: n }, (_, i) => ({ dimensionValues: [{ value: '20260101' }, { value: '/p' + i }], metricValues: [{ value: '1' }, { value: '0' }] })) });
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		const f = (async () => new Response(JSON.stringify(page(100_000)), { status: 200, headers: { 'content-type': 'application/json' } })) as never;
		await expect(organicLandingDaily(id, 'properties/1', '2026-01-01', '2026-02-01', { fetchImpl: f })).rejects.toThrow(/600,000/);
	});
});

describe('digest and alerts: nothing silently lost', () => {
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
	});
	it('headline counts every dropped page, not just the ten listed', () => {
		const site = { siteId: 1, name: 'a', week: { start: 'a', end: 'b' }, comparable: true, clicks: { now: 1, prev: 1, change: 0, significant: false }, impressions: { now: 1, prev: 1, change: 0 }, position: { now: 1, prev: 1 }, queryWinners: [], queryLosers: [], pageWinners: [], pageLosers: [], events: Array.from({ length: 10 }, () => ({ kind: 'deindexed', url: 'u', detail: null })), droppedPages: 23, updates: [], decidedTests: [], openActions: 0, blockingActions: 0, topActions: [] };
		expect(headlineOf([site], []).join(' ')).toMatch(/23 pages were dropped/);
	});
	it('a weekly digest whose webhook was down is sent again later, once, and not duplicated', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		let posts = 0;
		const down = (async () => (posts++, new Response('x', { status: 500 }))) as never;
		const up = (async () => (posts++, new Response('ok'))) as never;
		const first = await runWeeklyDigest({ fetchImpl: down, today: '2026-11-04' });
		expect(first).toMatchObject({ created: true, delivery: 'failed' });
		expect(posts).toBe(1);
		db().prepare("DELETE FROM kv WHERE key = 'digest_retry'").run();
		const again = await runWeeklyDigest({ fetchImpl: up, today: '2026-11-05' });
		expect(again).toMatchObject({ created: false, delivery: 'sent' });
		expect(listDigests('weekly')).toHaveLength(1);
		expect(listDigests('weekly')[0].delivery).toBe('sent');
		expect(await runWeeklyDigest({ fetchImpl: up, today: '2026-11-06' })).toMatchObject({ created: false });
		expect(posts).toBe(2); // delivered once, never again
		delete process.env.DIGEST_WEBHOOK_URL;
	});
	it('a retry is not made more than once an hour while the webhook stays down', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		let posts = 0;
		const down = (async () => (posts++, new Response('x', { status: 500 }))) as never;
		await runWeeklyDigest({ fetchImpl: down, today: '2026-11-04' });
		await runWeeklyDigest({ fetchImpl: down, today: '2026-11-04' }); // first retry
		await runWeeklyDigest({ fetchImpl: down, today: '2026-11-04' }); // within the hour: no post
		expect(posts).toBe(2);
		delete process.env.DIGEST_WEBHOOK_URL;
	});
	it('urgent alerts mark only the issues the message shows; the rest go out in the next one', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/abc';
		const real = (await import('../src/lib/server/actions')).queueFor;
		void real;
		// 12 blocking items on one site, planted straight into the cache the queue reads
		const site = getSite(1)!;
		const items = Array.from({ length: 12 }, (_, i) => ({ key: 'b' + i, type: 'blocked', siteId: 1, title: 'Blocked ' + i, why: 'w', how: 'h', impact: 10, confidence: 'high', effort: 'low', blocking: true, href: '/x', evidence: [] }));
		actionsFor(site); // fills the cache row
		const row = db().prepare('SELECT cache_key FROM action_cache WHERE site_id = 1 AND days = 28').get() as { cache_key: string };
		db().prepare('UPDATE action_cache SET payload = ? WHERE site_id = 1 AND days = 28').run(JSON.stringify(items));
		void row;
		db().prepare('DELETE FROM alerts_sent').run();
		const texts: string[] = [];
		const up = (async (_u: URL, i: RequestInit) => (texts.push(JSON.parse(String(i.body)).text), new Response('ok'))) as never;
		const first = await runUrgentAlerts({ fetchImpl: up });
		expect(first.alerted).toBe(8);
		expect(texts[0]).toContain('…and');
		const sent = db().prepare('SELECT COUNT(*) n FROM alerts_sent WHERE site_id = 1').get() as { n: number };
		expect(sent.n).toBe(8);
		const second = await runUrgentAlerts({ fetchImpl: up });
		expect(second.alerted).toBeGreaterThan(0); // items 9 to 12 are announced now
		delete process.env.DIGEST_WEBHOOK_URL;
	});
});

describe('action queue: cache and key scope', () => {
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
	});
	it('changing the brand terms invalidates the cached queue', () => {
		const a = db().prepare("SELECT 1").get();
		void a;
		const site = getSite(1)!;
		actionsFor(site);
		const k1 = (db().prepare('SELECT cache_key FROM action_cache WHERE site_id = 1').get() as { cache_key: string }).cache_key;
		db().prepare("UPDATE sites SET brand_terms = 'zzbrand' WHERE id = 1").run();
		actionsFor(getSite(1)!);
		const k2 = (db().prepare('SELECT cache_key FROM action_cache WHERE site_id = 1').get() as { cache_key: string }).cache_key;
		expect(k2).not.toBe(k1);
	});
	it('the portfolio queue applies the key scope before the limit', () => {
		for (const id of [1, 2]) { // plant one blocking item per site in the cache the queue reads
			actionsFor(getSite(id)!);
			db().prepare('UPDATE action_cache SET payload = ? WHERE site_id = ? AND days = 28').run(JSON.stringify([{ key: 'k' + id, type: 'blocked', siteId: id, title: 't', why: 'w', how: 'h', impact: 5, confidence: 'high', effort: 'low', blocking: true, href: '/x', evidence: [] }]), id);
		}
		expect(portfolioQueue(200).some((x) => x.siteId === 2)).toBe(true); // other sites do have items
		const one = [getSite(1)!];
		const items = portfolioQueue(5, 28, one as never);
		expect(items.every((x) => x.siteId === 1)).toBe(true);
	});
	it('conversions on a subdomain test are reported as unsupported, not computed on the whole property', () => {
		db().prepare("UPDATE sites SET site_url = 'sc-domain:x.example' WHERE id = 1").run();
		const r = conversionsFor(1, { start_date: '2026-06-01', window_days: 28, treatment: { urls: [], prefixes: ['https://blog.x.example/'] }, control: { restOfSite: true } }, '2026-06-30');
		expect(r.status).toBe('unsupported');
		expect(r.note).toMatch(/blog\.x\.example/);
	});
});
