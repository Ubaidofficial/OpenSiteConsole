import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm, hasGtmScope, linkGtmManually } from '../src/lib/server/connect';
import { syncGtm } from '../src/lib/server/channels';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { containerHosts, liveVersion, listContainers, summarizeVersion } from '../src/lib/server/gtm';
import { webStreamMeasurementIds } from '../src/lib/server/ga4';
import { buildAuthUrl, SCOPE_GTM_READ } from '../src/lib/server/google';
import { gtmSnapshot, trackingHealth } from '../src/lib/server/tracking';
import { linksFor } from '../src/lib/server/links';
import { getSite } from '../src/lib/server/clients';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { queueDepth } from '../src/lib/server/jobs';
import { auditTracking, type TrackingInput, type TrackingTag } from '../src/lib/tracking';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

describe('OAuth scopes', () => {
	afterEach(() => void delete process.env.GOOGLE_INCLUDE_GTM);
	it('requests read-only Tag Manager access by default and never a write scope', () => {
		process.env.GOOGLE_CLIENT_ID = 'cid';
		const scope = new URL(buildAuthUrl('s')).searchParams.get('scope')!;
		expect(scope.split(' ')).toContain(SCOPE_GTM_READ);
		expect(scope).not.toMatch(/tagmanager\.(edit|publish|manage)/);
	});
	it('GOOGLE_INCLUDE_GTM=0 leaves it out', () => {
		process.env.GOOGLE_INCLUDE_GTM = '0';
		expect(new URL(buildAuthUrl('s')).searchParams.get('scope')).not.toContain('tagmanager');
	});
	it('hasGtmScope reads the stored scope string; demo accounts always have it', () => {
		expect(hasGtmScope({ scopes: `openid ${SCOPE_GTM_READ}`, is_demo: 0 })).toBe(true);
		expect(hasGtmScope({ scopes: 'openid email webmasters', is_demo: 0 })).toBe(false);
		expect(hasGtmScope({ scopes: '', is_demo: 1 })).toBe(true);
	});
});

describe('summarizeVersion', () => {
	const version = {
		containerVersionId: '7',
		name: 'v7',
		trigger: [{ triggerId: '2', name: 'All Pages', type: 'pageview' }, { triggerId: '5', name: 'Consent denied', type: 'customEvent' }],
		variable: [{ variableId: '1', name: 'GA4 ID', type: 'c', parameter: [{ key: 'value', value: 'g-abc12345' }] }],
		tag: [
			{ tagId: '1', name: 'Google tag', type: 'googtag', firingTriggerId: ['2'], parameter: [{ key: 'tagId', value: '{{GA4 ID}}' }] },
			{ tagId: '2', name: 'GA4 lead', type: 'gaawe', firingTriggerId: ['9'], blockingTriggerId: ['5'], parameter: [{ key: 'measurementIdOverride', value: 'G-ZZZZ9999' }, { key: 'eventName', value: 'generate_lead' }] },
			{ tagId: '3', name: 'Old', type: 'ua', paused: true },
			{ tagId: '4', name: 'Not GA', type: 'html', parameter: [{ key: 'tagId', value: 'G-NOPE1234' }] }
		]
	};
	it('resolves constant variables, trigger names, pause state and ignores IDs on non-GA tags', () => {
		const s = summarizeVersion(version);
		expect(s.versionId).toBe('7');
		expect(s.tags[0]).toMatchObject({ measurementId: 'G-ABC12345', firing: ['All Pages'], paused: false });
		expect(s.tags[1]).toMatchObject({ measurementId: 'G-ZZZZ9999', eventName: 'generate_lead', firing: ['trigger 9'], blocking: ['Consent denied'] });
		expect(s.tags[2]).toMatchObject({ paused: true, measurementId: null });
		expect(s.tags[3].measurementId).toBeNull();
	});
	it('tolerates a nearly empty version', () => {
		expect(summarizeVersion({})).toMatchObject({ tags: [], triggers: [], variables: [] });
	});
});

describe('containerHosts', () => {
	it('uses domainName, and a host-like name when domainName is empty', () => {
		expect(containerHosts({ domains: ['https://www.shop.example/'], name: 'Shop' })).toEqual(['shop.example']);
		expect(containerHosts({ domains: [], name: 'https://blog.example.com/' })).toEqual(['blog.example.com']);
		expect(containerHosts({ domains: [], name: 'Marketing site (new)' })).toEqual([]);
	});
});

describe('Tag Manager API client', () => {
	beforeEach(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
	});
	const acct = () => upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: SCOPE_GTM_READ });

	it('lists containers across accounts, following the documented paths', async () => {
		const id = acct();
		const urls: string[] = [];
		const f = vi.fn(async (url: string) => {
			urls.push(url);
			if (url.endsWith('/accounts')) return json({ account: [{ accountId: '10', name: 'Acme' }] });
			return json({ container: [{ path: 'accounts/10/containers/20', containerId: '20', name: 'acme.example', publicId: 'GTM-ACME1', domainName: ['acme.example'], usageContext: ['web'] }, { containerId: '21', name: 'App', usageContext: ['ios'] }] });
		});
		const cs = await listContainers(id, { fetchImpl: f as never });
		expect(urls).toEqual(['https://tagmanager.googleapis.com/tagmanager/v2/accounts', 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/10/containers']);
		expect(cs).toHaveLength(2);
		expect(cs[0]).toMatchObject({ path: 'accounts/10/containers/20', publicId: 'GTM-ACME1', accountName: 'Acme' });
		expect(cs[1].path).toBe('accounts/10/containers/21'); // path rebuilt when Google omits it
	});

	it('liveVersion returns null for a never-published container (404) but rethrows other errors', async () => {
		const id = acct();
		const notFound = vi.fn(async (_url: string) => json({ error: { message: 'not found', status: 'NOT_FOUND' } }, 404));
		expect(await liveVersion(id, 'accounts/1/containers/2', { fetchImpl: notFound as never })).toBeNull();
		expect(notFound.mock.calls[0][0]).toBe('https://tagmanager.googleapis.com/tagmanager/v2/accounts/1/containers/2/versions:live');
		const denied = vi.fn(async () => json({ error: { message: 'API disabled', status: 'PERMISSION_DENIED' } }, 403));
		await expect(liveVersion(id, 'accounts/1/containers/2', { fetchImpl: denied as never })).rejects.toThrow(/API disabled/);
	});

	it('reads GA4 measurement IDs from web streams and ignores streams without one', async () => {
		const id = acct();
		const f = vi.fn(async () => json({ dataStreams: [{ webStreamData: { measurementId: 'G-AAAA1111' } }, { webStreamData: {} }, {}] }));
		expect(await webStreamMeasurementIds(id, 'properties/9', { fetchImpl: f as never })).toEqual(['G-AAAA1111']);
	});
});

// ── audit rules ──────────────────────────────────────────────────────────────
const tag = (o: Partial<TrackingTag>): TrackingTag => ({ name: 't', type: 'html', paused: false, firing: ['All Pages'], measurementId: null, ...o });
const base = (o: Partial<TrackingInput> = {}): TrackingInput => ({
	gtm: { publicId: 'GTM-X', published: true, tags: [tag({ name: 'Google tag', type: 'googtag', measurementId: 'G-GOOD1234' })] },
	ga4: { measurementIds: ['G-GOOD1234'] },
	traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 900 },
	...o
});
const ids = (i: TrackingInput) => auditTracking(i).map((f) => f.id);

describe('auditTracking', () => {
	it('is quiet when everything lines up', () => expect(ids(base())).toEqual([]));

	it('flags an unpublished container as critical and skips tag checks', () => {
		const f = auditTracking(base({ gtm: { publicId: 'GTM-X', published: false, tags: [] } }));
		expect(f.map((x) => x.id)).toEqual(['gtm-unpublished']);
		expect(f[0].severity).toBe('critical');
	});

	it('flags a container that sends to another GA4 property, naming both IDs', () => {
		const f = auditTracking(base({ gtm: { publicId: 'GTM-X', published: true, tags: [tag({ type: 'googtag', measurementId: 'G-OTHER999' })] } }));
		expect(f[0]).toMatchObject({ id: 'ga4-id-mismatch', severity: 'critical' });
		expect(f[0].detail).toContain('G-OTHER999');
		expect(f[0].detail).toContain('G-GOOD1234');
	});

	it('accepts the container when any of its GA4 IDs matches the property', () => {
		const tags = [tag({ type: 'googtag', measurementId: 'G-OTHER999' }), tag({ type: 'gaawe', measurementId: 'G-GOOD1234' })];
		expect(ids(base({ gtm: { publicId: 'GTM-X', published: true, tags } }))).toEqual([]);
	});

	it('says so, instead of guessing, when IDs cannot be compared', () => {
		expect(ids(base({ ga4: { measurementIds: [] } }))).toEqual(['ga4-id-unknown']);
		const hidden = base({ gtm: { publicId: 'GTM-X', published: true, tags: [tag({ type: 'googtag', measurementId: null })] } });
		expect(ids(hidden)).toEqual(['ga4-id-hidden']);
	});

	it('warns when the live container has no GA4/Google tag, and about UA, paused and trigger-less tags', () => {
		const tags = [tag({ name: 'UA', type: 'ua' }), tag({ name: 'Old', paused: true }), tag({ name: 'Orphan', firing: [] })];
		const got = ids(base({ gtm: { publicId: 'GTM-X', published: true, tags } }));
		expect(got).toEqual(expect.arrayContaining(['gtm-no-ga4-tag', 'gtm-ua', 'gtm-paused', 'gtm-no-trigger']));
		const noTrig = auditTracking(base({ gtm: { publicId: 'GTM-X', published: true, tags } })).find((f) => f.id === 'gtm-no-trigger')!;
		expect(noTrig.detail).toContain('Orphan');
		expect(noTrig.detail).not.toContain('Old'); // a paused tag is reported once, as paused
	});

	it('GA4 versus Search Console: zero is critical, a big gap is a warning, a small gap is fine', () => {
		expect(auditTracking(base({ traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 0 } }))[0]).toMatchObject({ id: 'ga4-no-organic', severity: 'critical' });
		expect(auditTracking(base({ traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 300 } }))[0]).toMatchObject({ id: 'ga4-gap', severity: 'warning' });
		expect(ids(base({ traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 600 } }))).toEqual([]);
	});

	it('does not compare traffic on tiny sites, or when GA4 has not synced (null is unknown, not zero)', () => {
		expect(ids(base({ traffic: { days: 28, gscClicks: 40, ga4OrganicSessions: 0 } }))).toEqual([]);
		expect(ids(base({ traffic: { days: 28, gscClicks: 5000, ga4OrganicSessions: null } }))).toEqual([]);
	});

	it('suggests linking GA4 when only Tag Manager is present, and orders critical first', () => {
		expect(ids(base({ ga4: null }))).toEqual(['ga4-not-linked']);
		const f = auditTracking(base({ gtm: { publicId: 'GTM-X', published: true, tags: [tag({ name: 'Old', paused: true })] }, traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 0 } }));
		expect(f.map((x) => x.severity)).toEqual([...f.map((x) => x.severity)].sort((a, b) => ['critical', 'warning', 'info'].indexOf(a) - ['critical', 'warning', 'info'].indexOf(b)));
		expect(f[0].severity).toBe('critical');
	});

	it('works with no Tag Manager at all (GA4 vs Search Console only)', () => {
		expect(ids(base({ gtm: null, traffic: { days: 28, gscClicks: 1000, ga4OrganicSessions: 0 } }))).toEqual(['ga4-no-organic']);
	});
});

// ── demo end to end ──────────────────────────────────────────────────────────
describe('Tag Manager end to end (demo data)', () => {
	let key = '';
	const call = async (name: string, args: object = {}) => {
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		return { isError: !!r.isError, data: r.isError ? r.content[0].text : JSON.parse(r.content[0].text) };
	};
	const siteId = (host: string) => (db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id;
	let summary: Awaited<ReturnType<typeof autoMatchGtm>>;

	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const [id, sub] of [[1, 'demo-a'], [2, 'demo-a'], [3, 'demo-a'], [4, 'demo-b'], [5, 'demo-b'], [6, 'demo-b']] as const) await syncSite(id, { client: new DemoClient(sub), mode: 'incremental' });
		await autoMatchGa4();
		summary = await autoMatchGtm();
		await drain();
		key = createApiKey('all', null).key;
	}, 120_000);

	it('matches containers by domain, and by container name when domainName is empty; leaves the unmatched visible', () => {
		expect(summary.matched).toBe(5);
		expect(summary.unmatchedSites).toEqual(['https://www.northwind-tools.example/']);
		expect(summary.ambiguous).toEqual([]);
		expect(linksFor(siteId('coffeelab')).gtm?.label).toContain('GTM-COFFEEL'); // domainName empty in the demo container
		expect(linksFor(siteId('northwind'))).not.toHaveProperty('gtm');
	});

	it('stores the live version and the GA4 measurement IDs of the linked property', () => {
		const s = gtmSnapshot(siteId('greenleaf'))!;
		expect(s.published).toBe(true);
		expect(s.tags.map((t) => t.type)).toEqual(['googtag', 'gaawe', 'gaawe']);
		expect(s.ga4MeasurementIds).toHaveLength(1);
		expect(s.tags[0].measurementId).toBe(s.ga4MeasurementIds[0]);
		expect(gtmSnapshot(siteId('trailmaps'))!.published).toBe(false);
	});

	it('finds the planted problems and leaves the healthy site clean', () => {
		const health = (h: string) => {
			const site = getSite(siteId(h))!;
			return trackingHealth(site, 28).findings.map((f) => f.id);
		};
		expect(health('greenleaf')).toEqual([]);
		expect(health('pixelforge')).toEqual(expect.arrayContaining(['ga4-id-mismatch', 'gtm-paused']));
		expect(health('trailmaps')).toContain('gtm-unpublished');
		expect(health('ledgerly')).toEqual(expect.arrayContaining(['gtm-ua', 'gtm-no-ga4-tag']));
		expect(health('coffeelab')).toContain('gtm-no-trigger');
	});

	it('a second match run does not re-link or duplicate', async () => {
		const again = await autoMatchGtm();
		expect(again.matched).toBe(0);
	});

	it('links by hand using the public container ID, and rejects unknown or malformed ones', async () => {
		const nw = siteId('northwind');
		await expect(linkGtmManually(nw, 'GTM-NOSUCH1')).rejects.toThrow(/No container/);
		await expect(linkGtmManually(nw, 'not an id')).rejects.toThrow(/Enter a container ID/);
		const c = await linkGtmManually(nw, 'gtm-greenle'); // case-insensitive
		expect(c.publicId).toBe('GTM-GREENLE');
		expect(linksFor(nw).gtm?.external_id).toBe(c.path);
		await drain();
		expect(gtmSnapshot(nw)).not.toBeNull();
	});

	it('a failing API marks the link as errored and keeps the last snapshot', async () => {
		const id = siteId('greenleaf');
		const before = gtmSnapshot(id)!;
		await expect(syncGtm(id, { listContainers: async () => [], liveVersion: async () => { throw new Error('Tag Manager API has not been used in project 123'); } })).rejects.toThrow(/has not been used/);
		expect(linksFor(id).gtm).toMatchObject({ sync_status: 'error' });
		expect(linksFor(id).gtm?.sync_message).toMatch(/has not been used/);
		expect(gtmSnapshot(id)!.fetchedAt).toBe(before.fetchedAt);
	});

	it('MCP: get_gtm_container, get_tracking_health, get_connections and list_sites', async () => {
		const c = (await call('get_gtm_container', { site: 'greenleaf.example' })).data;
		expect(c.container.id).toBe('GTM-GREENLE');
		expect(c.counts.tags).toBe(3);
		expect(c.tags[0].type).toBe('Google tag');
		expect((await call('get_gtm_container', { site: 'trailmaps.example' })).data.liveVersion).toBeNull();

		const h = (await call('get_tracking_health', { site: 'pixelforge.example' })).data;
		expect(h.status).toBe('critical');
		expect(h.findings.map((f: { id: string }) => f.id)).toContain('ga4-id-mismatch');
		expect((await call('get_tracking_health', { site: 'greenleaf.example' })).data.status).toBe('ok');

		const conn = (await call('get_connections')).data;
		expect(conn.sites).toBe(6);
		expect(conn.tagManager.linkedSites).toBe(6); // five by match + northwind by hand in the earlier test
		expect(conn.ga4.linkedSites).toBeGreaterThan(0);

		const sites = (await call('list_sites')).data;
		expect(sites.find((s: { name: string }) => s.name === 'greenleaf.example').connected.gtm).toMatchObject({ container: expect.stringContaining('GTM-GREENLE') });
	});

	it('a linked GA4 property that has not synced yet is unknown, never "zero sessions"', () => {
		const id = siteId('coffeelab');
		expect(linksFor(id).ga4).toBeTruthy();
		db().prepare('DELETE FROM ga4_daily WHERE site_id = ?').run(id);
		const h = trackingHealth(getSite(id)!, 28);
		expect(h.input.traffic.gscClicks).toBeGreaterThan(100); // enough traffic that a real zero would be flagged
		expect(h.input.traffic.ga4OrganicSessions).toBeNull();
		expect(h.findings.map((f) => f.id)).not.toEqual(expect.arrayContaining(['ga4-no-organic']));
		expect(h.findings.map((f) => f.id)).not.toContain('ga4-gap');
	});

	it('MCP: an unlinked site gets a hint, not an error', async () => {
		db().prepare("DELETE FROM site_links WHERE kind = 'gtm' AND site_id = ?").run(siteId('ledgerly'));
		const r = await call('get_gtm_container', { site: 'ledgerly.example' });
		expect(r.isError).toBe(false);
		expect(r.data.connected).toBe(false);
		expect((await call('get_tracking_health', { site: 'ledgerly.example' })).data.hint).toMatch(/No Tag Manager container/);
	});
});

