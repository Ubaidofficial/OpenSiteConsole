import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { createApiKey } from '../src/lib/server/apikeys';
import { getSite } from '../src/lib/server/clients';
import { onboardingFacts, onboardingFor, setOnboardingHidden } from '../src/lib/server/onboarding';
import { actions } from '../src/routes/+page.server';
import { onboardingProgress, onboardingSteps, runningSummary, PHASES, type OnboardingFacts } from '../src/lib/onboarding';

const none: OnboardingFacts = { demo: false, googleConfigured: false, googleAccounts: 0, sitesTotal: 0, sitesSynced: 0, actionsHandled: 0, openActions: null, blockingActions: null, sourcesLinked: 0, cruxConnected: false, indexMonitorSites: 0, brandTermSites: 0, digestWebhook: false, agentKeys: 0, teamMembers: 0, topSite: null, monitorUrls: 40, mcpUrl: 'https://app.example/api/mcp' };
const started: OnboardingFacts = { ...none, googleConfigured: true, googleAccounts: 1, sitesTotal: 6, sitesSynced: 4, openActions: 34, blockingActions: 3, topSite: { id: 7, name: 'greenleaf.example', brandGuess: 'greenleaf' } };

describe('the set-up steps', () => {
	it('three phases in order; a fresh install has nothing done and Google flagged as needing setup', () => {
		const s = onboardingSteps(none);
		expect(s.map((x) => x.id)).toEqual(['google', 'sync', 'sources', 'actions', 'indexing', 'brand', 'alerts', 'agent', 'team']);
		expect(PHASES.map((p) => p.id)).toEqual(['connect', 'act', 'automate']);
		expect(s.map((x) => x.phase)).toEqual(['connect', 'connect', 'connect', 'act', 'act', 'act', 'automate', 'automate', 'automate']);
		expect(s.every((x) => !x.done)).toBe(true);
		expect(s[0].blocked).toMatch(/GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET/);
		expect(onboardingSteps({ ...none, googleConfigured: true })[0].blocked).toBeNull();
		expect(onboardingProgress(s)).toMatchObject({ done: 0, total: 8, complete: false, minutesLeft: 18 });
		expect(onboardingProgress(s).next?.id).toBe('google');
		expect(s.find((x) => x.id === 'indexing')?.href).toBeNull(); // no site yet, nowhere to go
	});
	it('says what each step unlocks in the installation\'s own numbers', () => {
		const s = onboardingSteps(started);
		const by = (id: string) => s.find((x) => x.id === id)!;
		expect(by('sync')).toMatchObject({ done: true, status: '4 of 6 sites synced', progress: 4 / 6 });
		expect(by('actions').impact).toMatch(/^34 open items across your sites, 3 of them blocking/);
		expect(by('indexing').impact).toMatch(/up to 40 pages of greenleaf\.example every day/);
		expect(by('brand').impact).toMatch(/we guessed “greenleaf” for greenleaf\.example/);
		expect(by('sources').impact).toMatch(/^6 sites only have Search Console data/);
	});
	it('does what it can from the guide itself: monitor on, brand guess confirmed, values to copy', () => {
		const s = onboardingSteps(started);
		const by = (id: string) => s.find((x) => x.id === id)!;
		expect(by('indexing').inline).toEqual({ kind: 'form', action: 'onboardIndexing', fields: { siteId: '7' }, label: 'Turn on for greenleaf.example' });
		expect(by('brand').inline).toEqual({ kind: 'form', action: 'onboardBrand', fields: { siteId: '7', terms: 'greenleaf' }, label: 'Use “greenleaf”' });
		expect(by('agent').inline).toEqual({ kind: 'copy', value: 'https://app.example/api/mcp', label: 'Copy the MCP address' });
		expect(by('alerts').inline).toMatchObject({ kind: 'copy', value: 'DIGEST_WEBHOOK_URL=' });
		// no inline action once done
		expect(onboardingSteps({ ...started, indexMonitorSites: 1 }).find((x) => x.id === 'indexing')!.inline).toBeNull();
	});
	it('suggests a question for the agent only once an agent is connected', () => {
		expect(onboardingSteps(started).some((x) => x.agentPrompt)).toBe(false);
		const withAgent = onboardingSteps({ ...started, agentKeys: 1 });
		expect(withAgent.find((x) => x.id === 'actions')!.agentPrompt).toBe('What should I fix first across my sites?');
	});
	it('the optional team step never holds the guide open; done shows what is running', () => {
		const all = { ...started, sitesSynced: 6, actionsHandled: 1, sourcesLinked: 2, indexMonitorSites: 1, brandTermSites: 1, digestWebhook: true, agentKeys: 1 };
		const p = onboardingProgress(onboardingSteps(all));
		expect(p).toMatchObject({ done: 8, total: 8, complete: true, minutesLeft: 0 });
		expect(p.next?.id).toBe('team');
		expect(runningSummary(all)).toEqual(['6 sites syncing', '2 sites with extra sources', 'Indexing watched on 1 site', 'Digest and alerts to your webhook', '1 agent connection']);
	});
});

describe('read from the stored data, and the guide\'s own actions', () => {
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		process.env.SCHEDULER = '0';
		delete process.env.DIGEST_WEBHOOK_URL;
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	}, 60_000);
	const post = (name: 'onboardIndexing' | 'onboardBrand', fields: Record<string, string>) => {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		return (actions[name] as (e: unknown) => Promise<unknown>)({ request: new Request('http://x/', { method: 'POST', body: fd }) });
	};

	it('each step ticks itself off as the installation is set up', async () => {
		let f = onboardingFacts();
		expect(f).toMatchObject({ googleConfigured: true, googleAccounts: 2, sitesSynced: 0, actionsHandled: 0, agentKeys: 0, digestWebhook: false, openActions: null });
		await syncSite(1, { client: new DemoClient('demo-a'), backfillChunkDays: 120 });
		f = onboardingFacts();
		expect(f.topSite).toMatchObject({ id: 1, name: 'greenleaf.example', brandGuess: 'greenleaf' });
		expect(f.openActions).toBeGreaterThan(0); // live to-do count while that step is open
		db().prepare("INSERT INTO action_state (site_id, key, state, until, updated_at) VALUES (1, 'k', 'done', 0, 0)").run();
		createApiKey('agent', null);
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example/x';
		f = onboardingFacts();
		expect(f).toMatchObject({ sitesSynced: 1, actionsHandled: 1, agentKeys: 1, digestWebhook: true, openActions: null });
		expect(onboardingFor().steps.filter((s) => s.done).map((s) => s.id)).toEqual(['google', 'sync', 'actions', 'alerts', 'agent']);
		delete process.env.DIGEST_WEBHOOK_URL;
	});
	it('turning the monitor on and confirming the brand guess from the guide; a brand someone set is never overwritten', async () => {
		await post('onboardIndexing', { siteId: '1' });
		expect(getSite(1)!.index_monitor).toBe(1);
		await post('onboardBrand', { siteId: '1', terms: 'greenleaf' });
		expect(getSite(1)!.brand_terms).toBe('greenleaf');
		const again = (await post('onboardBrand', { siteId: '1', terms: 'other' })) as { status: number };
		expect(again.status).toBe(409);
		expect(getSite(1)!.brand_terms).toBe('greenleaf');
		expect(onboardingFor().steps.filter((s) => s.done).map((s) => s.id)).toEqual(['google', 'sync', 'actions', 'indexing', 'brand', 'agent']);
	});
	it('hiding is remembered for the installation, and can be undone', () => {
		setOnboardingHidden(true);
		expect(onboardingFor().hidden).toBe(true);
		setOnboardingHidden(false);
		expect(onboardingFor().hidden).toBe(false);
	});
});
