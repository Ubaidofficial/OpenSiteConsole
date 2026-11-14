import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, syncAccountSites } from '../src/lib/server/accounts';
import { OWNER, accessRefusal } from '../src/lib/server/roles';
import { SWITCHES, applyDefaultsToNewSite, applyToAll, counts, getDefaults, setDefault } from '../src/lib/server/automation';
import { actions, load } from '../src/routes/connect/+page.server';

/**
 * The three per-site switches that start off (indexing monitor, daily Request list, sitemap resubmission), set for every site at
 * once, and what a site found later starts with. Nothing changes until someone chooses; existing sites are never flipped back.
 */
const col = (id: number, c: string) => (db().prepare(`SELECT ${c} v FROM sites WHERE id = ?`).get(id) as { v: number }).v;
const form = (o: Record<string, string>) => {
	const f = new FormData();
	for (const [k, v] of Object.entries(o)) f.set(k, v);
	return { request: new Request('http://localhost/connect', { method: 'POST', body: f }) } as never;
};
const call = (name: 'automationDefault' | 'automationApply', o: Record<string, string>) => (actions[name] as (e: never) => Promise<Record<string, unknown>>)(form(o));

beforeEach(() => {
	process.env.SCHEDULER = '0';
	delete process.env.READ_ONLY;
	delete process.env.DEMO_MODE;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'o@example.com', 'active', 1)").run();
	const ins = d.prepare('INSERT INTO sites (id, account_id, site_url, permission, hidden, created_at) VALUES (?, 1, ?, ?, ?, 1)');
	ins.run(1, 'https://a.example/', 'siteOwner', 0);
	ins.run(2, 'https://b.example/', 'siteFullUser', 0);
	ins.run(3, 'https://hidden.example/', 'siteOwner', 1);
	ins.run(4, 'https://gone.example/', 'none', 0);
	ins.run(5, 'https://unverified.example/', 'siteUnverifiedUser', 0);
});

describe('automation switches', () => {
	it('start with everything off, and counting only the sites the dashboard shows', () => {
		expect(getDefaults()).toEqual({ indexMonitor: false, requestAuto: false, sitemapAuto: false });
		expect(counts()).toEqual({ total: 2, on: { indexMonitor: 0, requestAuto: 0, sitemapAuto: 0 } });
	});

	it('turn on for all changes only eligible sites, says how many, and a repeat changes none', () => {
		expect(applyToAll('indexMonitor', true)).toBe(2);
		expect([1, 2].map((i) => col(i, 'index_monitor'))).toEqual([1, 1]);
		expect([3, 4, 5].map((i) => col(i, 'index_monitor'))).toEqual([0, 0, 0]); // hidden, removed, unverified
		expect(col(1, 'request_auto')).toBe(0); // the other switches are untouched
		expect(applyToAll('indexMonitor', true)).toBe(0);
		expect(counts().on.indexMonitor).toBe(2);
	});

	it('turn off for all reverses it', () => {
		applyToAll('requestAuto', true);
		expect(applyToAll('requestAuto', false)).toBe(2);
		expect(counts().on.requestAuto).toBe(0);
	});

	it('does not switch on sitemap resubmission when READ_ONLY forbids writing to Search Console', () => {
		process.env.READ_ONLY = '1';
		expect(applyToAll('sitemapAuto', true)).toBe(0);
		expect(counts().on.sitemapAuto).toBe(0);
		delete process.env.READ_ONLY;
		expect(applyToAll('sitemapAuto', true)).toBe(2);
	});

	it('writes what it did to the audit log', () => {
		applyToAll('indexMonitor', true);
		setDefault('requestAuto', true);
		const rows = db().prepare("SELECT action, detail FROM audit_log WHERE action LIKE 'automation.%' ORDER BY id").all() as { action: string; detail: string }[];
		expect(rows.map((r) => r.action)).toEqual(['automation.apply', 'automation.default']);
		expect(rows[0].detail).toContain('2 site(s)');
	});
});

describe('what a new site starts with', () => {
	it('a site found later takes the chosen defaults, and only those', () => {
		setDefault('indexMonitor', true);
		setDefault('sitemapAuto', true);
		db().prepare("INSERT INTO sites (id, account_id, site_url, permission, created_at) VALUES (9, 1, 'https://new.example/', 'siteOwner', 1)").run();
		applyDefaultsToNewSite(9);
		expect([col(9, 'index_monitor'), col(9, 'sitemap_auto'), col(9, 'request_auto')]).toEqual([1, 1, 0]);
	});

	it('with nothing chosen a new site starts with everything off', () => {
		db().prepare("INSERT INTO sites (id, account_id, site_url, permission, created_at) VALUES (9, 1, 'https://new.example/', 'siteOwner', 1)").run();
		applyDefaultsToNewSite(9);
		expect([col(9, 'index_monitor'), col(9, 'sitemap_auto'), col(9, 'request_auto')]).toEqual([0, 0, 0]);
	});

	it('is applied when a sync discovers a property, never to one that was already known', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		setDefault('indexMonitor', true);
		await ensureDemoAccounts(); // the demo accounts' properties are all new
		const ids = (db().prepare("SELECT id FROM sites WHERE permission NOT IN ('none','siteUnverifiedUser')").all() as { id: number }[]).map((r) => r.id);
		expect(ids.length).toBeGreaterThan(0);
		expect(ids.every((i) => col(i, 'index_monitor') === 1)).toBe(true);
		// someone switches one off by hand; a later property refresh must not switch it back on
		db().prepare('UPDATE sites SET index_monitor = 0 WHERE id = ?').run(ids[0]);
		const acc = (db().prepare('SELECT id FROM accounts LIMIT 1').get() as { id: number }).id;
		await syncAccountSites(acc);
		expect(col(ids[0], 'index_monitor')).toBe(0);
	});
});

describe('the Connect page actions', () => {
	it('lists the switches with their counts and defaults', async () => {
		applyToAll('indexMonitor', true);
		setDefault('requestAuto', true);
		const data = (await (load as unknown as (e: never) => Promise<{ automation: { total: number; switches: { key: string; on: number; newSites: boolean; available: boolean }[] } }>)({ url: new URL('http://localhost/connect') } as never)).automation;
		expect(data.total).toBe(2);
		expect(data.switches.map((s) => s.key)).toEqual(SWITCHES.map((s) => s.key));
		expect(data.switches.find((s) => s.key === 'indexMonitor')).toMatchObject({ on: 2, newSites: false, available: true });
		expect(data.switches.find((s) => s.key === 'requestAuto')).toMatchObject({ on: 0, newSites: true });
	});

	it('the default action stores the choice and says existing sites are not changed', async () => {
		const r = await call('automationDefault', { key: 'indexMonitor', on: '1' });
		expect(r.ok).toMatch(/start with it on.*Existing sites are not changed/);
		expect(getDefaults().indexMonitor).toBe(true);
		expect(counts().on.indexMonitor).toBe(0);
		await call('automationDefault', { key: 'indexMonitor', on: '0' });
		expect(getDefaults().indexMonitor).toBe(false);
	});

	it('the apply action reports the count, and refuses an unknown switch or column name', async () => {
		expect((await call('automationApply', { key: 'requestAuto', on: '1' })).ok).toMatch(/switched on for 2 sites/);
		expect((await call('automationApply', { key: 'requestAuto', on: '1' })).ok).toMatch(/for 0 sites \(already all on\)/);
		for (const key of ['nope', 'index_monitor; DROP TABLE sites', '']) {
			const r = (await call('automationApply', { key, on: '1' })) as { status?: number; data?: { error?: string } };
			expect(r.status).toBe(400);
		}
		expect(db().prepare('SELECT COUNT(*) n FROM sites').get()).toEqual({ n: 5 });
	});

	it('refuses switching on sitemap resubmission in READ_ONLY mode', async () => {
		process.env.READ_ONLY = '1';
		const r = (await call('automationApply', { key: 'sitemapAuto', on: '1' })) as { status?: number };
		expect(r.status).toBe(400);
		expect(counts().on.sitemapAuto).toBe(0);
	});

	it('is for admins: an editor and a viewer are refused, the owner is not', () => {
		const u = (role: 'editor' | 'viewer' | 'admin') => ({ ...OWNER, id: 7, role, siteIds: null });
		const url = new URL('http://localhost/connect?/automationApply');
		expect(accessRefusal(u('editor'), 'POST', url)).toMatchObject({ kind: 'role', need: 'admin' });
		expect(accessRefusal(u('viewer'), 'POST', url)).toMatchObject({ kind: 'role' });
		expect(accessRefusal(u('admin'), 'POST', url)).toBeNull();
		expect(accessRefusal(OWNER, 'POST', new URL('http://localhost/connect?/automationDefault'))).toBeNull();
	});
});
