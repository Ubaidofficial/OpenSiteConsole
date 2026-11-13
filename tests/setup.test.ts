import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { compile } from 'svelte/compiler';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4, autoMatchGtm } from '../src/lib/server/connect';
import { syncGtm } from '../src/lib/server/channels';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { queueDepth } from '../src/lib/server/jobs';
import { allLinks, linksFor, removeLink } from '../src/lib/server/links';
import { gtmSnapshot } from '../src/lib/server/tracking';
import { buildAuthUrl } from '../src/lib/server/google';
import { ALL_PAGES_TRIGGER, GTM_WRITE_SCOPES, ga4TagBody, realGtmAdmin, type GtmAdmin, type GtmWriter } from '../src/lib/server/gtmwrite';
import { ga4TosUrl, hasGa4Write, realGa4Admin, SCOPE_GA4_EDIT, type Ga4Admin } from '../src/lib/server/ga4write';
import { gtmOnSite, hasSetupGrant, planSetup, runSetup, SETUP_SCOPES, siteHost, startGa4Account, validCurrency, validTimeZone, type SetupApi } from '../src/lib/server/setup';
import { demoSetup } from '../src/lib/server/demo-channels';
import type { GtmContainer, GtmLive } from '../src/lib/server/gtm';
import { gtmSnippet } from '../src/lib/gtminstall';
import { GET as authConnect } from '../src/routes/auth/connect/+server';
import { GET as authCallback } from '../src/routes/auth/callback/+server';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
const auditActions = () => (db().prepare('SELECT action FROM audit_log ORDER BY id').all() as { action: string }[]).map((r) => r.action);

describe('the grant', () => {
	const redirectTarget = (fn: () => unknown): string | null => {
		try {
			fn();
		} catch (e) {
			return (e as { location?: string }).location ?? null;
		}
		return null;
	};
	const start = (qs: string) => redirectTarget(() => authConnect({ cookies: { set() {} }, url: new URL(`http://localhost/auth/connect${qs}`) } as never));
	const scopesOf = (loc: string | null) => new URL(loc!).searchParams.get('scope')!.split(' ');
	beforeAll(() => {
		process.env.GOOGLE_CLIENT_ID = 'cid';
		process.env.GOOGLE_CLIENT_SECRET = 'secret';
	});
	afterEach(() => void delete process.env.READ_ONLY);

	it('the normal sign-in asks for nothing that edits Google Analytics or Tag Manager', () => {
		const normal = scopesOf(start('')).join(' ');
		expect(normal).not.toMatch(/analytics\.edit|tagmanager\.(edit|publish)/);
	});
	it('?grant=setup adds analytics.edit and the three Tag Manager write scopes (containers, versions, publish)', () => {
		const s = scopesOf(start('?grant=setup'));
		expect(SETUP_SCOPES).toEqual([SCOPE_GA4_EDIT, ...GTM_WRITE_SCOPES]);
		for (const x of ['https://www.googleapis.com/auth/analytics.edit', 'https://www.googleapis.com/auth/tagmanager.edit.containers', 'https://www.googleapis.com/auth/tagmanager.edit.containerversions', 'https://www.googleapis.com/auth/tagmanager.publish']) expect(s).toContain(x);
		expect(new URL(buildAuthUrl('s', SETUP_SCOPES)).searchParams.get('scope')).toContain('analytics.edit');
	});
	it('?grant=gtm-write (the Clarity install) still asks for no Google Analytics write access', () => {
		const s = scopesOf(start('?grant=gtm-write')).join(' ');
		expect(s).toContain('tagmanager.edit.containers');
		expect(s).not.toContain('analytics.edit');
	});
	it('a read-only server never adds any of them, however it is asked', () => {
		process.env.READ_ONLY = '1';
		for (const g of ['setup', 'gtm-write']) expect(scopesOf(start(`?grant=${g}`)).join(' ')).not.toMatch(/analytics\.edit|tagmanager\.(edit|publish)/);
	});
	it('hasSetupGrant needs all four; hasGa4Write only analytics.edit; demo accounts always have them', () => {
		expect(hasSetupGrant({ scopes: `openid ${SETUP_SCOPES.join(' ')}`, is_demo: 0 })).toBe(true);
		expect(hasSetupGrant({ scopes: `openid ${GTM_WRITE_SCOPES.join(' ')}`, is_demo: 0 })).toBe(false);
		expect(hasGa4Write({ scopes: `openid ${SCOPE_GA4_EDIT}`, is_demo: 0 })).toBe(true);
		expect(hasSetupGrant({ scopes: '', is_demo: 1 })).toBe(true);
	});
	it('Google’s Terms of Service page can send the person back to /auth/callback with nothing: they land on Connect, not on an error', async () => {
		const err = await Promise.resolve(authCallback({ url: new URL('http://localhost/auth/callback'), cookies: { get: () => undefined, delete() {} } } as never)).catch((e: { status?: number; location?: string }) => e);
		expect(err).toMatchObject({ status: 303 });
		expect((err as { location: string }).location).toMatch(/^\/connect\?flash=/);
		// a real sign-in return without its state is still refused
		await expect(Promise.resolve(authCallback({ url: new URL('http://localhost/auth/callback?code=x'), cookies: { get: () => undefined, delete() {} } } as never))).rejects.toMatchObject({ status: 400 });
	});
});

describe('the Google requests (bodies, URLs, scope token)', () => {
	beforeAll(() => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
	});
	const acct = () => upsertGoogleAccount({ sub: 'req', email: 'req@b.c', accessToken: 'AT-1', refreshToken: 'RT', expiresIn: 3600, scope: SETUP_SCOPES.join(' ') });
	const recorder = (answer: (url: string, init: RequestInit) => unknown) => {
		const seen: { method: string; url: string; body: unknown; auth: string }[] = [];
		const fetchImpl = vi.fn(async (url: string, init: RequestInit = {}) => {
			seen.push({ method: init.method ?? 'GET', url, body: init.body ? JSON.parse(init.body as string) : undefined, auth: (init.headers as Record<string, string>).authorization });
			return json(answer(url, init));
		}) as unknown as typeof fetch;
		return { seen, fetchImpl };
	};

	it('GA4: property, then web data stream, with the documented bodies; the measurement ID is read from the stream', async () => {
		const id = acct();
		const { seen, fetchImpl } = recorder((url) => (url.endsWith('/properties') ? { name: 'properties/555', displayName: 'example.com' } : { name: 'properties/555/dataStreams/9', webStreamData: { measurementId: 'G-ABC123DEF4', defaultUri: 'https://example.com' } }));
		const admin = realGa4Admin(id, { fetchImpl });
		expect(await admin.createProperty('accounts/77', { displayName: 'example.com', timeZone: 'Europe/Berlin', currencyCode: 'EUR' })).toEqual({ property: 'properties/555', displayName: 'example.com' });
		expect(await admin.createWebStream('properties/555', { displayName: 'example.com', uri: 'https://example.com' })).toEqual({ stream: 'properties/555/dataStreams/9', measurementId: 'G-ABC123DEF4' });
		expect(seen[0]).toEqual({ method: 'POST', url: 'https://analyticsadmin.googleapis.com/v1beta/properties', body: { parent: 'accounts/77', displayName: 'example.com', timeZone: 'Europe/Berlin', currencyCode: 'EUR' }, auth: 'Bearer AT-1' });
		expect(seen[1]).toEqual({ method: 'POST', url: 'https://analyticsadmin.googleapis.com/v1beta/properties/555/dataStreams', body: { type: 'WEB_DATA_STREAM', displayName: 'example.com', webStreamData: { defaultUri: 'https://example.com' } }, auth: 'Bearer AT-1' });
	});
	it('GA4: accounts come from accountSummaries (all pages); web streams carry their measurement IDs', async () => {
		const id = acct();
		const { seen, fetchImpl } = recorder((url) =>
			url.includes('accountSummaries')
				? url.includes('pageToken=p2')
					? { accountSummaries: [{ account: 'accounts/2', displayName: 'Two' }] }
					: { accountSummaries: [{ account: 'accounts/1', displayName: 'One' }, { name: 'accountSummaries/9' }], nextPageToken: 'p2' }
				: { dataStreams: [{ type: 'WEB_DATA_STREAM', webStreamData: { measurementId: 'G-1', defaultUri: 'https://a.example' } }, { type: 'IOS_APP_DATA_STREAM' }] }
		);
		const admin = realGa4Admin(id, { fetchImpl });
		expect(await admin.listAccounts()).toEqual([{ account: 'accounts/1', displayName: 'One' }, { account: 'accounts/2', displayName: 'Two' }]);
		expect(await admin.webStreams('properties/7')).toEqual([{ measurementId: 'G-1', uri: 'https://a.example' }]);
		expect(seen.map((s) => s.method)).toEqual(['GET', 'GET', 'GET']);
	});
	it('GA4: accounts.provisionAccountTicket posts the account name and the redirect address, and the Terms of Service link carries the ticket', async () => {
		const id = acct();
		const { seen, fetchImpl } = recorder(() => ({ accountTicketId: 'T 1/2' }));
		expect(await realGa4Admin(id, { fetchImpl }).provisionTicket('example.com', 'https://seo.example/auth/callback', 'ES')).toBe('T 1/2');
		expect(seen[0]).toMatchObject({ method: 'POST', url: 'https://analyticsadmin.googleapis.com/v1beta/accounts:provisionAccountTicket', body: { account: { displayName: 'example.com', regionCode: 'ES' }, redirectUri: 'https://seo.example/auth/callback' } });
		expect(ga4TosUrl('T 1/2')).toBe('https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/T%201%2F2');
	});
	it('GA4: an answer without the new ID is an error, never a silent success', async () => {
		const id = acct();
		const { fetchImpl } = recorder(() => ({}));
		const admin = realGa4Admin(id, { fetchImpl });
		await expect(admin.createProperty('accounts/1', { displayName: 'x', timeZone: 'UTC', currencyCode: 'USD' })).rejects.toThrow(/did not return/);
		await expect(admin.provisionTicket('x', 'https://r', 'ES')).rejects.toThrow(/did not return/);
		expect((await admin.createWebStream('properties/1', { displayName: 'x', uri: 'https://x' })).measurementId).toBe('');
	});
	it('Tag Manager: accounts.list, then containers.create with a web usage context and the domain', async () => {
		const id = acct();
		const { seen, fetchImpl } = recorder((url, init) => (init.method === 'POST' ? { path: 'accounts/88/containers/9', containerId: '9', publicId: 'GTM-NEW1234', name: 'example.com' } : { account: [{ path: 'accounts/88', accountId: '88', name: 'Acme' }] }));
		const admin = realGtmAdmin(id, { fetchImpl });
		expect(await admin.listAccounts()).toEqual([{ path: 'accounts/88', name: 'Acme' }]);
		expect(await admin.createContainer('accounts/88', { name: 'example.com', domainName: ['example.com'] })).toEqual({ path: 'accounts/88/containers/9', publicId: 'GTM-NEW1234', name: 'example.com' });
		expect(seen[0]).toMatchObject({ method: 'GET', url: 'https://tagmanager.googleapis.com/tagmanager/v2/accounts' });
		expect(seen[1]).toEqual({ method: 'POST', url: 'https://tagmanager.googleapis.com/tagmanager/v2/accounts/88/containers', body: { name: 'example.com', usageContext: ['web'], domainName: ['example.com'] }, auth: 'Bearer AT-1' });
	});
	it('Tag Manager: the Google tag is a googtag with the measurement ID, firing on All Pages', () => {
		expect(ga4TagBody('G-ABC123DEF4')).toMatchObject({ type: 'googtag', parameter: [{ type: 'template', key: 'tagId', value: 'G-ABC123DEF4' }], firingTriggerId: [ALL_PAGES_TRIGGER] });
	});
});

describe('the setup panel markup', () => {
	it('the country field keeps its pattern: Svelte turns a literal {2} inside an attribute into an expression, which made "US" fail the browser check', () => {
		const html = compile(readFileSync('src/lib/components/SiteSetup.svelte', 'utf8'), { generate: 'server', filename: 'SiteSetup.svelte' }).js.code;
		const patterns = [...html.matchAll(/pattern="([^"]*)"/g)].map((m) => m[1]);
		expect(patterns.length).toBeGreaterThan(0);
		for (const p of patterns) {
			expect(p).toBe('[A-Za-z]{2}');
			expect(new RegExp(`^(?:${p})$`).test('US')).toBe(true);
			expect(new RegExp(`^(?:${p})$`).test('USA')).toBe(false);
		}
	});
});

describe('the install code', () => {
	it('carries the container ID in both pieces', () => {
		const s = gtmSnippet('gtm-abc1234')!;
		expect(s.head).toContain("'GTM-ABC1234'");
		expect(s.head).toContain('googletagmanager.com/gtm.js');
		expect(s.body).toContain('ns.html?id=GTM-ABC1234');
	});
	it('refuses anything that is not a container ID, so nothing can be injected into the markup', () => {
		for (const bad of ['', 'ABC1234', "GTM-X');alert(1);//", 'GTM-AB"><script>', 'GTM-12']) expect(gtmSnippet(bad)).toBeNull();
	});
	it('siteHost, validTimeZone, validCurrency', () => {
		expect(siteHost('sc-domain:Example.com')).toBe('example.com');
		expect(siteHost('https://www.example.com/blog/')).toBe('www.example.com');
		expect(validTimeZone('Europe/Berlin')).toBe(true);
		expect(validTimeZone('America/Argentina/Buenos_Aires')).toBe(true);
		for (const bad of ['', 'Mars/Olympus', 'Europe/Berlin; DROP', '../etc']) expect(validTimeZone(bad)).toBe(false);
		expect(validCurrency('EUR')).toBe(true);
		for (const bad of ['eur', 'EURO', '', '€']) expect(validCurrency(bad)).toBe(false);
	});
});

// ── the plan and each create path, against the demo accounts with the Google calls replaced by recorders ──────────────────
describe('planSetup and runSetup', () => {
	const siteId = (host: string) => (db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id;

	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const [id, sub] of [[1, 'demo-a'], [2, 'demo-a'], [3, 'demo-a'], [4, 'demo-b'], [5, 'demo-b'], [6, 'demo-b']] as const) await syncSite(id, { client: new DemoClient(sub), mode: 'incremental' });
		await autoMatchGa4();
		await autoMatchGtm();
		await drain();
	}, 120_000);
	afterEach(async () => {
		await drain();
		delete process.env.READ_ONLY;
	});

	/** Records every Google call; each part can be overridden. Nothing matches by default. */
	function fake(o: { props?: { property: string; displayName: string; account: string }[]; urls?: Record<string, string[]>; ga4Accounts?: { account: string; displayName: string }[]; streams?: Record<string, { measurementId: string; uri: string }[]>; containers?: GtmContainer[]; live?: Record<string, GtmLive | null>; gtmAccounts?: { path: string; name: string }[]; latest?: string | null; failStream?: boolean } = {}) {
		const calls: string[] = [];
		const sent: Record<string, any> = {};
		const ga4Admin: Ga4Admin = {
			listAccounts: async () => o.ga4Accounts ?? [{ account: 'accounts/77', displayName: 'Acme Analytics' }],
			webStreams: async (p) => o.streams?.[p] ?? [],
			createProperty: async (account, p) => (calls.push('createProperty'), (sent.property = { account, ...p }), { property: 'properties/555', displayName: p.displayName }),
			createWebStream: async (property, s) => {
				calls.push('createWebStream');
				sent.stream = { property, ...s };
				if (o.failStream) throw new Error('quota');
				return { stream: `${property}/dataStreams/1`, measurementId: 'G-NEWNEW0001' };
			},
			provisionTicket: async (name, redirect, region) => (calls.push('provisionTicket'), (sent.ticket = { name, redirect, region }), 'TICKET-1')
		};
		const gtmAdmin: GtmAdmin = {
			listAccounts: async () => o.gtmAccounts ?? [{ path: 'accounts/88', name: 'Acme TM' }],
			createContainer: async (account, c) => (calls.push('createContainer'), (sent.container = { account, ...c }), { path: 'accounts/88/containers/9', publicId: 'GTM-NEW1234', name: c.name })
		};
		const writer: GtmWriter = {
			latestVersionId: async () => (o.latest === undefined ? '5' : o.latest),
			createWorkspace: async (c, name) => (calls.push('workspace'), (sent.workspace = { c, name }), { path: `${c}/workspaces/3`, workspaceId: '3' }),
			createTag: async (w, tag) => (calls.push('tag'), (sent.tag = { w, tag }), { tagId: '1' }),
			createVersion: async (w) => (calls.push('version'), { path: w.replace(/workspaces\/\d+$/, 'versions/6'), versionId: '6', compilerError: false }),
			publish: async () => (calls.push('publish'), { versionId: '6', compilerError: false })
		};
		const api: Partial<SetupApi> = {
			ga4Read: () => ({ listProperties: async () => o.props ?? [], streamUrls: async (p) => o.urls?.[p] ?? [] }),
			// the first demo account stands for "the Google account"; the second sees nothing, so a container is never counted twice
			gtmRead: (id) => ({ listContainers: async () => (id === 2 ? (o.containers ?? []) : []), liveVersion: async (path) => o.live?.[path] ?? null }),
			ga4Admin: () => ga4Admin,
			gtmAdmin: () => gtmAdmin,
			writer: () => writer
		};
		return { api, calls, sent };
	}
	const container = (path: string, publicId: string, name: string, domains: string[] = [name]): GtmContainer => ({ path, publicId, name, domains, usage: ['web'], accountName: 'Acme TM' });
	const live = (tags: Partial<GtmLive['tags'][number]>[], versionId = '5'): GtmLive => ({ versionId, versionName: 'v', tags: tags.map((t, i) => ({ id: String(i), name: 't', type: 'html', paused: false, firing: ['All Pages'], blocking: [], measurementId: null, eventName: null, ...t })), triggers: [], variables: [] });
	// northwind is on the second demo account: its GA4 and container links are removed so every test starts from "nothing linked"
	const clean = () => {
		const id = siteId('northwind');
		removeLink(id, 'ga4');
		removeLink(id, 'gtm');
		return id;
	};
	beforeEach(() => void clean());

	it('a plan only reads: nothing is created or linked', async () => {
		const id = siteId('northwind');
		const f = fake();
		const before = JSON.stringify(allLinks());
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan).toMatchObject({ ok: true, ga4: { state: 'create', account: 'accounts/77', displayName: 'www.northwind-tools.example', uri: 'https://www.northwind-tools.example' }, gtm: { state: 'create', account: 'accounts/88', domain: 'www.northwind-tools.example' }, tag: { state: 'add', newContainer: true, canPublish: true }, ready: true });
		expect(f.calls).toEqual([]);
		expect(JSON.stringify(allLinks())).toBe(before);
	});

	it('nothing matches: creates the property, its web stream and the container, links both, adds the Google tag and publishes it', async () => {
		const id = siteId('northwind');
		const f = fake({ props: [{ property: 'properties/1', displayName: 'Someone else', account: 'A' }], urls: { 'properties/1': ['https://other.example'] }, containers: [container('accounts/1/containers/1', 'GTM-OTHER11', 'other.example')] });
		const r = await runSetup(id, { timeZone: 'Europe/Berlin', currencyCode: 'eur' }, 'publish', { api: f.api });
		expect(r).toMatchObject({ ok: true, published: true, measurementId: 'G-NEWNEW0001', container: { publicId: 'GTM-NEW1234' } });
		expect(f.calls).toEqual(['createProperty', 'createWebStream', 'createContainer', 'workspace', 'tag', 'version', 'publish']);
		expect(f.sent.property).toEqual({ account: 'accounts/77', displayName: 'www.northwind-tools.example', timeZone: 'Europe/Berlin', currencyCode: 'EUR' });
		expect(f.sent.stream).toEqual({ property: 'properties/555', displayName: 'www.northwind-tools.example', uri: 'https://www.northwind-tools.example' });
		expect(f.sent.container).toEqual({ account: 'accounts/88', name: 'www.northwind-tools.example', domainName: ['www.northwind-tools.example'] });
		expect(f.sent.tag.tag).toMatchObject({ type: 'googtag', parameter: [{ key: 'tagId', value: 'G-NEWNEW0001' }], firingTriggerId: [ALL_PAGES_TRIGGER] });
		// Tag Manager rejects ":" in a name ("The name contains invalid character"), found on the first live run: nothing sent may contain one
		for (const n of [f.sent.workspace.name, f.sent.tag.tag.name]) expect(n, n).not.toMatch(/[:"<>&]/);
		expect(linksFor(id).ga4).toMatchObject({ external_id: 'properties/555', account_id: 2 });
		expect(linksFor(id).gtm).toMatchObject({ external_id: 'accounts/88/containers/9', label: 'GTM-NEW1234 · www.northwind-tools.example' });
		expect(r.snippet?.head).toContain('GTM-NEW1234');
		expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['ga4:done', 'gtm:done', 'tag:done']);
		expect(auditActions()).toEqual(expect.arrayContaining(['setup.ga4_property_created', 'setup.ga4_stream_created', 'setup.gtm_container_created', 'setup.tag_published', 'setup.completed']));
	});

	it('"review first" leaves the tag in a workspace and never versions or publishes', async () => {
		const f = fake();
		const r = await runSetup(siteId('northwind'), { timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: f.api });
		expect(r).toMatchObject({ ok: true, published: false });
		expect(r.reviewUrl).toMatch(/workspaces\/3$/);
		expect(f.calls).toEqual(['createProperty', 'createWebStream', 'createContainer', 'workspace', 'tag']);
		expect(auditActions()).toContain('setup.tag_prepared');
	});

	it('matches first: an existing property and container are linked, and nothing is created', async () => {
		const id = siteId('northwind');
		const f = fake({
			props: [{ property: 'properties/42', displayName: 'Northwind (GA4)', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-EXIST11', 'northwind-tools.example')],
			live: { 'accounts/5/containers/6': live([{ type: 'googtag', measurementId: 'G-EXIST00001' }]) }
		});
		const r = await runSetup(id, {}, 'publish', { api: f.api });
		expect(r).toMatchObject({ ok: true, published: false, measurementId: 'G-EXIST00001', container: { publicId: 'GTM-EXIST11' } });
		expect(f.calls).toEqual([]);
		expect(r.steps.map((s) => `${s.id}:${s.status}`)).toEqual(['ga4:done', 'gtm:done', 'tag:skipped']);
		expect(linksFor(id).ga4?.external_id).toBe('properties/42');
		expect(linksFor(id).gtm?.external_id).toBe('accounts/5/containers/6');
	});

	it('a container with no Google tag in its live version gets one (tag type googtag, matched container, nothing created)', async () => {
		const f = fake({
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-EXIST11', 'northwind-tools.example')],
			live: { 'accounts/5/containers/6': live([{ type: 'ua' }, { type: 'html' }]) }
		});
		const r = await runSetup(siteId('northwind'), {}, 'publish', { api: f.api });
		expect(r).toMatchObject({ ok: true, published: true });
		expect(f.calls).toEqual(['workspace', 'tag', 'version', 'publish']);
		expect(f.sent.tag.tag.parameter[0].value).toBe('G-EXIST00001');
	});

	it('a Google tag that sends to another measurement ID is left alone and reported', async () => {
		const f = fake({
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-EXIST11', 'northwind-tools.example')],
			live: { 'accounts/5/containers/6': live([{ type: 'googtag', measurementId: 'G-OLDSITE01' }]) }
		});
		const plan = await planSetup(siteId('northwind'), {}, { api: f.api });
		expect(plan.tag).toMatchObject({ state: 'present' });
		expect(plan.tag?.mismatch).toMatch(/G-OLDSITE01.*G-EXIST00001/);
	});

	it('publishing is refused when the newest version is not the live one, and so is a container never published; review-first still works', async () => {
		const base = {
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-EXIST11', 'northwind-tools.example')]
		};
		const newer = fake({ ...base, latest: '9', live: { 'accounts/5/containers/6': live([{ type: 'ua' }]) } });
		const r1 = await runSetup(siteId('northwind'), {}, 'publish', { api: newer.api });
		expect(r1.ok).toBe(false);
		expect(r1.error).toMatch(/newer version/);
		expect(newer.calls).toEqual([]);
		expect(linksFor(siteId('northwind')).ga4).toBeUndefined(); // refused before anything was linked
		const never = fake({ ...base, latest: '1', live: {} });
		expect((await runSetup(siteId('northwind'), {}, 'publish', { api: never.api })).error).toMatch(/never been published/);
		expect((await runSetup(siteId('northwind'), {}, 'workspace', { api: never.api })).ok).toBe(true);
		expect(never.calls).toEqual(['workspace', 'tag']);
	});

	it('a brand-new container the person made by hand (no versions at all) can be published to; one with an unpublished version cannot', async () => {
		const id = siteId('northwind');
		const base = {
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-NEWHAND1', 'northwind-tools.example')],
			live: {}
		};
		const fresh = fake({ ...base, latest: null });
		expect((await planSetup(id, {}, { api: fresh.api })).tag).toMatchObject({ state: 'add', canPublish: true });
		const r = await runSetup(id, {}, 'publish', { api: fresh.api });
		expect(r).toMatchObject({ ok: true, published: true });
		expect(fresh.calls).toEqual(['workspace', 'tag', 'version', 'publish']);
		removeLink(id, 'ga4');
		removeLink(id, 'gtm');
		const draft = fake({ ...base, latest: '3' });
		const plan = await planSetup(id, {}, { api: draft.api });
		expect(plan.tag).toMatchObject({ state: 'add', canPublish: false });
		expect(plan.tag?.publishBlocked).toMatch(/never been published but already has a version \(3\)/);
	});

	it('several properties match: the person picks one, and nothing is created meanwhile', async () => {
		const id = siteId('northwind');
		const f = fake({
			props: [{ property: 'properties/1', displayName: 'Old', account: 'A' }, { property: 'properties/2', displayName: 'New', account: 'A' }],
			urls: { 'properties/1': ['https://northwind-tools.example'], 'properties/2': ['https://www.northwind-tools.example'] },
			streams: { 'properties/2': [{ measurementId: 'G-PICKED0002', uri: 'https://www.northwind-tools.example' }] }
		});
		// both have an exact-host stream: ambiguous (a sub-domain would have decided it)
		f.api.ga4Read = () => ({ listProperties: async () => [{ property: 'properties/1', displayName: 'Old', account: 'A' }, { property: 'properties/2', displayName: 'New', account: 'A' }], streamUrls: async () => ['https://www.northwind-tools.example'] });
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan.ga4).toMatchObject({ state: 'choose', candidates: [{ property: 'properties/1' }, { property: 'properties/2' }] });
		expect(plan.ready).toBe(false);
		expect((await runSetup(id, {}, 'workspace', { api: f.api })).ok).toBe(false);
		expect(f.calls).toEqual([]);
		const chosen = await planSetup(id, { ga4Property: 'properties/2' }, { api: f.api });
		expect(chosen.ga4).toMatchObject({ state: 'match', property: 'properties/2', measurementId: 'G-PICKED0002' });
		// a value that was not offered is ignored
		expect((await planSetup(id, { ga4Property: 'properties/999' }, { api: f.api })).ga4?.state).toBe('choose');
	});

	it('several GA4 accounts: the person picks where to create it; an account that was not offered is ignored', async () => {
		const id = siteId('northwind');
		const f = fake({ ga4Accounts: [{ account: 'accounts/1', displayName: 'One' }, { account: 'accounts/2', displayName: 'Two' }] });
		const plan = await planSetup(id, { timeZone: 'UTC' }, { api: f.api });
		expect(plan.ga4).toMatchObject({ state: 'create', account: null });
		expect(plan.ready).toBe(false);
		expect(plan.blockers.join(' ')).toMatch(/Choose the Google Analytics account/);
		expect((await runSetup(id, { timeZone: 'UTC' }, 'workspace', { api: f.api })).ok).toBe(false);
		expect(f.calls).toEqual([]);
		expect((await planSetup(id, { ga4Account: 'accounts/nope' }, { api: f.api })).ga4).toMatchObject({ account: null });
		const r = await runSetup(id, { ga4Account: 'accounts/2', timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: f.api });
		expect(r.ok).toBe(true);
		expect(f.sent.property.account).toBe('accounts/2');
	});

	it('several Tag Manager accounts: the person picks where to create the container', async () => {
		const id = siteId('northwind');
		const f = fake({ gtmAccounts: [{ path: 'accounts/1', name: 'One' }, { path: 'accounts/2', name: 'Two' }] });
		expect((await planSetup(id, {}, { api: f.api })).gtm).toMatchObject({ state: 'create', account: null });
		expect((await runSetup(id, { timeZone: 'UTC' }, 'workspace', { api: f.api })).ok).toBe(false);
		expect(f.calls).toEqual([]); // nothing created in GA4 either: the whole plan is checked first
		const r = await runSetup(id, { gtmAccount: 'accounts/2', timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: f.api });
		expect(r.ok).toBe(true);
		expect(f.sent.container.account).toBe('accounts/2');
	});

	it('no GA4 account: Terms of Service first. The ticket is asked for with the site name and the sign-in return address, and no property is created', async () => {
		const id = siteId('northwind');
		process.env.GOOGLE_CLIENT_ID = 'cid';
		const f = fake({ ga4Accounts: [] });
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan.ga4).toMatchObject({ state: 'tos' });
		expect(plan.ready).toBe(false);
		expect((await runSetup(id, { timeZone: 'UTC' }, 'workspace', { api: f.api })).error).toMatch(/Terms of Service/);
		expect(f.calls).toEqual([]);
		const t = await startGa4Account(id, { api: f.api, regionCode: 'gb' });
		expect(t).toEqual({ ok: true, url: 'https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/TICKET-1' });
		expect(f.sent.ticket).toMatchObject({ name: 'www.northwind-tools.example', redirect: expect.stringMatching(/\/auth\/callback$/), region: 'GB' });
		expect(auditActions()).toContain('setup.ga4_account_started');
	});
	it('someone with accounts can still ask for a brand-new one for this site: same ticket, named after the site, and no property is created', async () => {
		process.env.GOOGLE_CLIENT_ID = 'cid';
		const f = fake({ ga4Accounts: [{ account: 'accounts/1', displayName: 'One' }, { account: 'accounts/2', displayName: 'Two' }] });
		expect((await planSetup(siteId('northwind'), {}, { api: f.api })).ga4?.state).toBe('create');
		const t = await startGa4Account(siteId('northwind'), { api: f.api, regionCode: 'ES' });
		expect(t).toEqual({ ok: true, url: 'https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/TICKET-1' });
		expect(f.sent.ticket).toMatchObject({ name: 'www.northwind-tools.example', region: 'ES' });
		expect(f.calls).toEqual(['provisionTicket']);
		// Google rejects the request without a valid country (seen live), so it is checked before Google is asked
		f.calls.length = 0;
		for (const bad of [undefined, '', 'E', 'ESP', 'E1', '€€']) expect((await startGa4Account(siteId('northwind'), { api: f.api, regionCode: bad })).error, String(bad)).toMatch(/two-letter/);
		expect(f.calls).toEqual([]);
	});
	it('a new account is only offered while the site has no property: not once one is linked or matched', async () => {
		const f = fake({
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] }
		});
		const r = await startGa4Account(siteId('northwind'), { api: f.api, regionCode: 'ES' });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/only offered while/);
		expect(f.calls).toEqual([]);
	});
	it('an account named after the site (a new one the person just made) is chosen for them, in GA4 and in Tag Manager; an explicit choice still wins', async () => {
		const id = siteId('northwind');
		const f = fake({
			ga4Accounts: [{ account: 'accounts/1', displayName: 'Other' }, { account: 'accounts/2', displayName: 'northwind-tools.example' }],
			gtmAccounts: [{ path: 'accounts/10', name: 'Other TM' }, { path: 'accounts/20', name: 'www.northwind-tools.example' }]
		});
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan.ga4).toMatchObject({ state: 'create', account: 'accounts/2' });
		expect(plan.gtm).toMatchObject({ state: 'create', account: 'accounts/20' });
		expect(plan.ready).toBe(true);
		expect((await planSetup(id, { ga4Account: 'accounts/1', gtmAccount: 'accounts/10' }, { api: f.api })).ga4).toMatchObject({ account: 'accounts/1' });
		await runSetup(id, { timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: f.api });
		expect(f.sent.property.account).toBe('accounts/2');
		expect(f.sent.container.account).toBe('accounts/20');
	});
	it('two accounts that both match the site name are left for the person to choose', async () => {
		const f = fake({ ga4Accounts: [{ account: 'accounts/1', displayName: 'northwind-tools.example' }, { account: 'accounts/2', displayName: 'Northwind-Tools.example' }] });
		expect((await planSetup(siteId('northwind'), {}, { api: f.api })).ga4).toMatchObject({ state: 'create', account: null });
	});
	it('a Tag Manager container the person made by hand in a new account is found and linked on the next try (nothing created)', async () => {
		const f = fake({ gtmAccounts: [{ path: 'accounts/20', name: 'northwind-tools.example' }], containers: [container('accounts/20/containers/1', 'GTM-HAND111', 'www.northwind-tools.example')], live: { 'accounts/20/containers/1': null }, latest: null });
		const plan = await planSetup(siteId('northwind'), { timeZone: 'UTC' }, { api: f.api });
		expect(plan.gtm).toMatchObject({ state: 'match', publicId: 'GTM-HAND111' });
		const r = await runSetup(siteId('northwind'), { timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: f.api });
		expect(r.ok).toBe(true);
		expect(f.calls).not.toContain('createContainer');
		expect(linksFor(siteId('northwind')).gtm?.external_id).toBe('accounts/20/containers/1');
	});

	it('no Tag Manager account: the API cannot create one, so the plan says so and nothing at all is created (not even the GA4 property)', async () => {
		const id = siteId('northwind');
		const f = fake({ gtmAccounts: [] });
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan.gtm).toMatchObject({ state: 'no-account' });
		expect(plan.blockers.join(' ')).toMatch(/tagmanager\.google\.com/);
		const r = await runSetup(id, { timeZone: 'UTC' }, 'workspace', { api: f.api });
		expect(r.ok).toBe(false);
		expect(f.calls).toEqual([]);
		// after they make one, trying again works
		expect((await runSetup(id, { timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: fake().api })).ok).toBe(true);
	});

	it('several containers match: the person picks one (offered by key); one that was not offered is ignored', async () => {
		const id = siteId('northwind');
		const f = fake({
			props: [{ property: 'properties/42', displayName: 'N', account: 'A' }],
			urls: { 'properties/42': ['https://www.northwind-tools.example'] },
			streams: { 'properties/42': [{ measurementId: 'G-EXIST00001', uri: 'https://www.northwind-tools.example' }] },
			containers: [container('accounts/5/containers/6', 'GTM-AAAA111', 'northwind-tools.example'), container('accounts/5/containers/7', 'GTM-BBBB222', 'northwind-tools.example')],
			live: { 'accounts/5/containers/7': live([{ type: 'googtag', measurementId: 'G-EXIST00001' }]) }
		});
		const plan = await planSetup(id, {}, { api: f.api });
		expect(plan.gtm).toMatchObject({ state: 'choose', candidates: [{ key: '2|accounts/5/containers/6' }, { key: '2|accounts/5/containers/7' }] });
		expect(plan.ready).toBe(false);
		expect((await planSetup(id, { gtmContainer: '2|accounts/9/containers/9' }, { api: f.api })).gtm?.state).toBe('choose');
		const r = await runSetup(id, { gtmContainer: '2|accounts/5/containers/7' }, 'publish', { api: f.api });
		expect(r).toMatchObject({ ok: true, container: { publicId: 'GTM-BBBB222' } });
		expect(linksFor(id).gtm?.external_id).toBe('accounts/5/containers/7');
	});

	it('a time zone or currency Google would refuse is caught before anything is created', async () => {
		const f = fake();
		expect((await runSetup(siteId('northwind'), { timeZone: 'Mars/Olympus', currencyCode: 'USD' }, 'workspace', { api: f.api })).error).toMatch(/time zone/);
		expect((await runSetup(siteId('northwind'), { timeZone: 'UTC', currencyCode: 'dollars' }, 'workspace', { api: f.api })).error).toMatch(/currency/);
		expect(f.calls).toEqual([]);
	});

	it('a run that stops after the property exists continues with it: no second property, only the missing stream', async () => {
		const id = siteId('northwind');
		const first = fake({ failStream: true });
		const r1 = await runSetup(id, { timeZone: 'UTC', currencyCode: 'USD' }, 'workspace', { api: first.api });
		expect(r1.ok).toBe(false);
		expect(r1.error).toMatch(/Google Analytics: quota/);
		expect(first.calls).toEqual(['createProperty', 'createWebStream']);
		expect(linksFor(id).ga4?.external_id).toBe('properties/555'); // linked the moment it was created
		expect(auditActions()).toContain('setup.failed');
		const second = fake(); // properties/555 has no stream yet
		const plan = await planSetup(id, {}, { api: second.api });
		expect(plan.ga4).toMatchObject({ state: 'stream', property: 'properties/555' });
		const r2 = await runSetup(id, {}, 'workspace', { api: second.api });
		expect(r2.ok).toBe(true);
		expect(second.calls).toEqual(['createWebStream', 'createContainer', 'workspace', 'tag']);
	});

	it('a failure while adding the tag keeps the links and says so; a retry only adds the tag', async () => {
		const id = siteId('northwind');
		const f = fake();
		f.api.writer = () => ({
			latestVersionId: async () => null,
			createWorkspace: async () => {
				throw new Error('workspace limit exceeded');
			},
			createTag: async () => ({ tagId: '' }),
			createVersion: async () => ({ path: '', versionId: '', compilerError: false }),
			publish: async () => ({ versionId: '', compilerError: false })
		});
		const r = await runSetup(id, { timeZone: 'UTC', currencyCode: 'USD' }, 'publish', { api: f.api });
		expect(r.ok).toBe(false);
		expect(r.error).toMatch(/three workspaces/);
		expect(r.error).toMatch(/already done is kept/);
		expect(linksFor(id).ga4).toBeDefined();
		expect(linksFor(id).gtm).toBeDefined();
		expect(r.snippet?.head).toContain('GTM-NEW1234'); // the container exists: the code can still be shown
		expect(auditActions()).toContain('setup.tag_failed');
	});

	it('an account that has not granted editing is sent to grant it first, and nothing runs', async () => {
		const id = siteId('northwind');
		const acc = (db().prepare('SELECT account_id FROM sites WHERE id = ?').get(id) as { account_id: number }).account_id;
		const original = db().prepare('SELECT scopes, is_demo FROM accounts WHERE id = ?').get(acc) as { scopes: string; is_demo: number };
		const readScopes = 'openid https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/tagmanager.readonly';
		db().prepare('UPDATE accounts SET is_demo = 0, scopes = ? WHERE id = ?').run(readScopes, acc);
		try {
			const f = fake();
			const plan = await planSetup(id, { timeZone: 'UTC' }, { api: f.api });
			expect(plan.needsGrant).toHaveLength(1);
			expect(plan.ready).toBe(false);
			const r = await runSetup(id, { timeZone: 'UTC' }, 'publish', { api: f.api });
			expect(r.ok).toBe(false);
			expect(r.error).toMatch(/Allow it first/);
			expect(f.calls).toEqual([]);
			db().prepare('UPDATE accounts SET scopes = ? WHERE id = ?').run(`${readScopes} ${SETUP_SCOPES.join(' ')}`, acc);
			expect((await planSetup(id, { timeZone: 'UTC' }, { api: f.api })).ready).toBe(true);
		} finally {
			db().prepare('UPDATE accounts SET is_demo = ?, scopes = ? WHERE id = ?').run(original.is_demo, original.scopes, acc);
		}
	});

	it('an account that cannot read GA4 at all is told to reconnect, not offered a property it could not check for duplicates', async () => {
		const id = siteId('northwind');
		const acc = (db().prepare('SELECT account_id FROM sites WHERE id = ?').get(id) as { account_id: number }).account_id;
		const original = db().prepare('SELECT scopes, is_demo FROM accounts WHERE id = ?').get(acc) as { scopes: string; is_demo: number };
		db().prepare("UPDATE accounts SET is_demo = 0, scopes = 'openid' WHERE id = ?").run(acc);
		try {
			const plan = await planSetup(id, {}, { api: fake().api });
			expect(plan.ga4).toMatchObject({ state: 'blocked' });
			expect(plan.ready).toBe(false);
		} finally {
			db().prepare('UPDATE accounts SET is_demo = ?, scopes = ? WHERE id = ?').run(original.is_demo, original.scopes, acc);
		}
	});

	it('a read-only server never plans or changes anything', async () => {
		process.env.READ_ONLY = '1';
		const f = fake();
		expect((await planSetup(siteId('northwind'), {}, { api: f.api })).error).toMatch(/READ_ONLY/);
		expect((await runSetup(siteId('northwind'), { timeZone: 'UTC' }, 'publish', { api: f.api })).ok).toBe(false);
		expect((await startGa4Account(siteId('northwind'), { api: f.api, regionCode: 'ES' })).ok).toBe(false);
		expect(f.calls).toEqual([]);
	});

	it('gtmOnSite reads the last page check: seen, not seen, or never checked', () => {
		const id = siteId('northwind');
		expect(gtmOnSite(id, 'GTM-NEW1234')).toBeNull();
		const put = (pages: unknown[]) => db().prepare('INSERT OR REPLACE INTO clarity_scans (site_id, checked_at, payload) VALUES (?,?,?)').run(id, 123, JSON.stringify(pages));
		put([{ url: 'https://x/', ok: true, clarityIds: [], clarityLoader: false, gtmIds: ['GTM-NEW1234'] }]);
		expect(gtmOnSite(id, 'gtm-new1234')).toEqual({ checkedAt: 123, seen: true, pagesRead: 1 });
		put([{ url: 'https://x/', ok: true, clarityIds: [], clarityLoader: false, gtmIds: [] }, { url: 'https://x/a', ok: false, error: '403', clarityIds: [], clarityLoader: false, gtmIds: [] }]);
		expect(gtmOnSite(id, 'GTM-NEW1234')).toEqual({ checkedAt: 123, seen: false, pagesRead: 1 });
		db().prepare('DELETE FROM clarity_scans WHERE site_id = ?').run(id);
	});
});

// ── demo mode: the buttons work end to end with the built-in demo writers (no fakes) ──────────────────────────────────────
describe('demo mode', () => {
	const siteId = (host: string) => (db().prepare('SELECT id FROM sites WHERE site_url LIKE ?').get(`%${host}%`) as { id: number }).id;
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.READ_ONLY;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
		for (const [id, sub] of [[1, 'demo-a'], [2, 'demo-a'], [3, 'demo-a'], [4, 'demo-b'], [5, 'demo-b'], [6, 'demo-b']] as const) await syncSite(id, { client: new DemoClient(sub), mode: 'incremental' });
		await autoMatchGa4();
		await autoMatchGtm();
		await drain();
	}, 120_000);
	afterEach(async () => {
		await drain();
		demoSetup.ga4.length = 0;
		demoSetup.containers.length = 0;
		demoSetup.ga4Tags.clear();
	});

	it('already set up (greenleaf): everything is skipped, no tag is added, and the code is still offered', async () => {
		const r = await runSetup(siteId('greenleaf'), {}, 'publish');
		expect(r).toMatchObject({ ok: true, published: false });
		expect(r.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
		expect(r.snippet?.head).toContain('GTM-GREENLE');
	});
	it('a container that sends to another property (pixelforge) is reported, not changed', async () => {
		const plan = await planSetup(siteId('pixelforge'));
		expect(plan.tag).toMatchObject({ state: 'present' });
		expect(plan.tag?.mismatch).toMatch(/G-OLDSITE01/);
	});
	it('no Google tag in the container (ledgerly): added and published, and the next sync sees it', async () => {
		const id = siteId('ledgerly');
		expect(await planSetup(id)).toMatchObject({ ok: true, ready: true, tag: { state: 'add', canPublish: true } });
		const r = await runSetup(id, {}, 'publish');
		expect(r).toMatchObject({ ok: true, published: true });
		await syncGtm(id);
		expect(gtmSnapshot(id)!.tags.some((t) => t.type === 'googtag' && t.measurementId)).toBe(true);
		expect((await planSetup(id)).tag?.state).toBe('present');
	});
	it('a container that was never published (trailmaps): publishing is refused, review-first works', async () => {
		const id = siteId('trailmaps');
		expect((await planSetup(id)).tag).toMatchObject({ state: 'add', canPublish: false });
		expect((await runSetup(id, {}, 'publish')).error).toMatch(/never been published/);
		expect(await runSetup(id, {}, 'workspace')).toMatchObject({ ok: true, published: false });
	});
	it('no container (northwind): one is created, linked and given the Google tag, and then shows up as set up', async () => {
		const id = siteId('northwind');
		expect(linksFor(id).gtm).toBeUndefined();
		const plan = await planSetup(id);
		expect(plan).toMatchObject({ ok: true, ready: true, ga4: { state: 'linked' }, gtm: { state: 'create', account: 'accounts/60000' }, tag: { state: 'add', newContainer: true } });
		const r = await runSetup(id, {}, 'publish');
		expect(r).toMatchObject({ ok: true, published: true });
		expect(r.container?.publicId).toMatch(/^GTM-DEMO\d+$/);
		expect(linksFor(id).gtm?.external_id).toBe(r.container!.path);
		await drain();
		await syncGtm(id);
		expect(gtmSnapshot(id)).toMatchObject({ published: true, publicId: r.container!.publicId });
		const again = await planSetup(id);
		expect(again).toMatchObject({ ok: true, ready: true, gtm: { state: 'linked' }, tag: { state: 'present' } });
		const second = await runSetup(id, {}, 'publish');
		expect(second.steps.map((s) => s.status)).toEqual(['skipped', 'skipped', 'skipped']);
	});
	it('an unlinked site with no property gets one created in the demo account', async () => {
		const id = siteId('northwind');
		removeLink(id, 'ga4');
		removeLink(id, 'gtm');
		// the demo property for northwind would match by its address; hide it so the create path runs
		const real = await import('../src/lib/server/setup');
		const plan = await real.planSetup(id, {}, { api: { ga4Read: () => ({ listProperties: async () => [], streamUrls: async () => [] }) } });
		expect(plan.ga4).toMatchObject({ state: 'create', account: 'accounts/9001' });
		const r = await real.runSetup(id, { timeZone: 'America/New_York', currencyCode: 'USD' }, 'publish', { api: { ga4Read: () => ({ listProperties: async () => [], streamUrls: async () => [] }) } });
		expect(r).toMatchObject({ ok: true, published: true });
		expect(r.measurementId).toMatch(/^G-DEMO/);
		expect(linksFor(id).ga4?.external_id).toMatch(/^properties\/9\d+$/);
		expect(demoSetup.ga4).toHaveLength(1);
	});
});
