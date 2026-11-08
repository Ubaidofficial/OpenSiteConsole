import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { createApiKey } from '../src/lib/server/apikeys';
import { onboardingFacts, onboardingFor, setOnboardingHidden } from '../src/lib/server/onboarding';
import { onboardingProgress, onboardingSteps, type OnboardingFacts } from '../src/lib/onboarding';

const none: OnboardingFacts = { demo: false, googleConfigured: false, googleAccounts: 0, sitesTotal: 0, sitesSynced: 0, actionsHandled: 0, sourcesLinked: 0, cruxConnected: false, indexMonitorSites: 0, brandTermSites: 0, digestWebhook: false, agentKeys: 0, teamMembers: 0, firstSiteId: null };

describe('the get-started steps', () => {
	it('a fresh install: nothing done, Google flagged as needing setup, the first step is next', () => {
		const s = onboardingSteps(none);
		expect(s.map((x) => x.id)).toEqual(['google', 'sync', 'actions', 'sources', 'indexing', 'brand', 'alerts', 'agent', 'team']);
		expect(s.every((x) => !x.done)).toBe(true);
		expect(s[0].blocked).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
		expect(onboardingSteps({ ...none, googleConfigured: true })[0].blocked).toBeNull();
		expect(onboardingProgress(s)).toMatchObject({ done: 0, total: 8, complete: false });
		expect(onboardingProgress(s).next?.id).toBe('google');
		// per-site steps have nowhere to go until there is a site
		expect(s.find((x) => x.id === 'indexing')?.href).toBeNull();
	});
	it('the optional team step never holds the guide open', () => {
		const all = { ...none, googleConfigured: true, googleAccounts: 1, sitesTotal: 3, sitesSynced: 3, actionsHandled: 1, sourcesLinked: 1, indexMonitorSites: 1, brandTermSites: 1, digestWebhook: true, agentKeys: 1, firstSiteId: 7 };
		const p = onboardingProgress(onboardingSteps(all));
		expect(p).toMatchObject({ done: 8, total: 8, complete: true });
		expect(p.next?.id).toBe('team');
		expect(onboardingSteps(all).find((x) => x.id === 'indexing')?.href).toBe('/sites/7/indexing');
	});
	it('status lines count what is there', () => {
		const s = onboardingSteps({ ...none, googleAccounts: 2, sitesTotal: 6, sitesSynced: 4 });
		expect(s[0].status).toBe('2 accounts');
		expect(s[1].status).toBe('4 of 6 sites synced');
		expect(s[1].done).toBe(true);
	});
});

describe('read from the stored data', () => {
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.DIGEST_WEBHOOK_URL;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	}, 60_000);

	it('each step ticks itself off as the installation is set up', async () => {
		let f = onboardingFacts();
		expect(f).toMatchObject({ googleConfigured: true, googleAccounts: 2, sitesSynced: 0, actionsHandled: 0, agentKeys: 0, digestWebhook: false });
		expect(f.sitesTotal).toBeGreaterThan(0);
		await syncSite(1, { client: new DemoClient('demo-a'), backfillChunkDays: 120 });
		db().prepare("INSERT INTO action_state (site_id, key, state, until, updated_at) VALUES (1, 'k', 'done', 0, 0)").run();
		db().prepare("UPDATE sites SET index_monitor = 1, brand_terms = 'greenleaf' WHERE id = 1").run();
		createApiKey('agent', null);
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/x';
		f = onboardingFacts();
		expect(f).toMatchObject({ sitesSynced: 1, actionsHandled: 1, indexMonitorSites: 1, brandTermSites: 1, agentKeys: 1, digestWebhook: true, firstSiteId: 1 });
		const done = onboardingFor().steps.filter((s) => s.done).map((s) => s.id);
		expect(done).toEqual(['google', 'sync', 'actions', 'indexing', 'brand', 'alerts', 'agent']);
		delete process.env.DIGEST_WEBHOOK_URL;
	});
	it('hiding is remembered for the installation, and can be undone', () => {
		expect(onboardingFor().hidden).toBe(false);
		setOnboardingHidden(true);
		expect(onboardingFor().hidden).toBe(true);
		setOnboardingHidden(false);
		expect(onboardingFor().hidden).toBe(false);
	});
});
