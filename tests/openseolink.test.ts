import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { connectOpenSeo } from '../src/lib/server/connect';
import { buildActions } from '../src/lib/server/actions';
import { fetchVolumes, openSeoFor, storedAudit, syncAudit, trackCandidates, trackPreview, trackSend, volumeCandidates, volumesFor, type OseoApi } from '../src/lib/server/openseolink';

/** A fake OpenSEO that records every call and answers with a function per tool. */
const recorder = (answers: Record<string, (args: Record<string, unknown>) => unknown>) => {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const api: OseoApi = {
		async callTool(name, args) {
			calls.push({ name, args });
			const f = answers[name];
			if (!f) throw new Error(`unexpected tool ${name}`);
			return f(args);
		}
	};
	return { api, calls };
};
const site = () => getSite(1)!;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	await connectOpenSeo('https://openseo.example', 'demo');
}, 180_000);

describe('linking', () => {
	it('the demo site is linked to its OpenSEO project by domain', () => {
		expect(openSeoFor(1)?.projectId).toBe('demo-proj-greenleaf');
		expect(openSeoFor(2)).toBeNull(); // pixelforge has no OpenSEO project
	});
});

describe('search volume for the site\'s own queries', () => {
	it('asks get_keyword_metrics for the queries with most impressions, within OpenSEO\'s limits, and keeps the answers', async () => {
		const { api, calls } = recorder({ get_keyword_metrics: (a) => ({ keywords: (a.keywords as string[]).slice(0, 5).map((k, i) => ({ keyword: k.toUpperCase(), search_volume: 100 * (i + 1), keyword_difficulty: 20 + i, main_intent: 'commercial', cpc: 1.5 })) }) });
		const r = await fetchVolumes(1, { api });
		expect(calls).toHaveLength(1);
		expect(calls[0].name).toBe('get_keyword_metrics');
		const a = calls[0].args as { projectId: string; keywords: string[]; includeMonthlyTrends: boolean };
		expect(a.projectId).toBe('demo-proj-greenleaf');
		expect(a.includeMonthlyTrends).toBe(false);
		expect(a.keywords.length).toBeGreaterThan(5);
		expect(a.keywords.length).toBeLessThanOrEqual(700);
		expect(a.keywords.every((k) => k.length <= 80 && k === k.toLowerCase())).toBe(true);
		expect(new Set(a.keywords).size).toBe(a.keywords.length);
		expect(r).toEqual({ asked: a.keywords.length, withVolume: 5 });
		const v = volumesFor(1);
		expect(v.get(a.keywords[0])).toMatchObject({ volume: 100, kd: 20, intent: 'commercial' }); // matched case-insensitively
		expect(v.get(a.keywords[6])?.volume).toBeNull(); // no data: kept as unknown, so it is not asked for again
		expect(volumeCandidates(site())).toEqual([]);
		expect(await fetchVolumes(1, { api })).toEqual({ asked: 0, withVolume: 0 });
		expect(calls).toHaveLength(1); // nothing new to ask
	});
	it('an OpenSEO error is reported with its reason', async () => {
		db().prepare('DELETE FROM oseo_volumes').run();
		const { api } = recorder({ get_keyword_metrics: () => { throw new Error('Insufficient credits'); } });
		await expect(fetchVolumes(1, { api })).rejects.toThrow(/OpenSEO: Insufficient credits/);
	});
	it('the demo OpenSEO answers in the same shape', async () => {
		const r = await fetchVolumes(1);
		expect(r.withVolume).toBeGreaterThan(0);
		expect(r.withVolume).toBeLessThan(r.asked); // some too small to measure
	});
});

describe('striking-distance searches to OpenSEO rank tracking', () => {
	it('with no tracker for the domain: the preview says a manual one will be created, and sending creates it and adds the searches', async () => {
		const kws = trackCandidates(site(), 10).map((r) => r.query);
		expect(kws.length).toBeGreaterThan(0);
		const { api, calls } = recorder({
			get_rank_tracker: () => ({ configs: [{ id: 'other', domain: 'unrelated.example', scheduleInterval: 'daily', isActive: true }] }),
			create_rank_tracker: () => ({ trackerId: '11111111-1111-4111-8111-111111111111' }),
			add_rank_tracking_keywords: (a) => ({ added: (a.keywords as string[]).length, addedIds: [] })
		});
		const plan = await trackPreview(1, kws, { api });
		expect(plan).toMatchObject({ action: 'create', schedule: 'manual', trackerId: null, estimate: null });
		expect(calls.map((c) => c.name)).toEqual(['get_rank_tracker']); // the preview changed nothing
		const r = await trackSend(1, kws, null, { api });
		expect(r).toMatchObject({ created: true, added: kws.length, trackerId: '11111111-1111-4111-8111-111111111111' });
		expect(calls[2]).toEqual({ name: 'create_rank_tracker', args: { projectId: 'demo-proj-greenleaf', domain: 'greenleaf.example', scheduleInterval: 'manual' } });
		expect(calls[3]).toEqual({ name: 'add_rank_tracking_keywords', args: { projectId: 'demo-proj-greenleaf', trackerId: '11111111-1111-4111-8111-111111111111', keywords: kws } }); // no credit ceiling for a manual tracker
		expect(trackCandidates(site(), 100).some((c) => kws.includes(c.query))).toBe(false); // sent ones are not offered again
	});
	it('a scheduled tracker: the preview shows OpenSEO\'s estimate; sending needs that approved ceiling and passes it on', async () => {
		const kws = trackCandidates(site(), 3).map((r) => r.query);
		const tracker = { id: '22222222-2222-4222-8222-222222222222', domain: 'www.greenleaf.example', scheduleInterval: 'weekly', isActive: true, locationName: null };
		const { api, calls } = recorder({
			get_rank_tracker: () => ({ configs: [{ ...tracker, id: 'city', locationName: 'Austin,Texas,United States' }, tracker] }),
			estimate_rank_tracker_cost: () => ({ costUsd: 0.0432, costCredits: 44, scheduledEstimate: { scheduleInterval: 'weekly', costUsd: 0.0432, costCredits: 44, checksPerMonth: 4.3, monthlyCostUsd: 0.19, monthlyCostCredits: 190 } }),
			add_rank_tracking_keywords: (a) => ({ added: (a.keywords as string[]).length })
		});
		const plan = await trackPreview(1, kws, { api });
		expect(plan.trackerId).toBe(tracker.id); // the national tracker, not the city one
		expect(calls[1]).toEqual({ name: 'estimate_rank_tracker_cost', args: { projectId: 'demo-proj-greenleaf', trackerId: tracker.id, additionalKeywords: kws } });
		expect(plan.estimate?.scheduled).toEqual({ interval: 'weekly', costCredits: 44, monthlyCostUsd: 0.19, monthlyCostCredits: 190 });
		await expect(trackSend(1, kws, null, { api })).rejects.toThrow(/preview the cost first/);
		expect(calls.some((c) => c.name === 'add_rank_tracking_keywords')).toBe(false);
		await trackSend(1, kws, 44, { api });
		expect(calls.at(-1)).toEqual({ name: 'add_rank_tracking_keywords', args: { projectId: 'demo-proj-greenleaf', trackerId: tracker.id, keywords: kws, maxEstimatedScheduledCheckCredits: 44 } });
	});
});

describe('OpenSEO\'s site audit, joined with Search Console', () => {
	it('reads the latest audit (get_audit_issues, no audit id) and lists issues on pages with clicks in the action queue', async () => {
		const top = (db().prepare('SELECT page, SUM(clicks) c FROM sa_rows WHERE site_id = 1 GROUP BY page ORDER BY c DESC LIMIT 2').all() as { page: string }[]).map((r) => r.page);
		const { api, calls } = recorder({
			get_audit_issues: () => ({
				summary: [{ issueType: 'missing_title', title: 'Missing title', severity: 'critical', count: 3 }, { issueType: 'image_missing_alt', title: 'Image without alt', severity: 'info', count: 9 }],
				issues: [
					{ severity: 'critical', issueType: 'missing_title', title: 'Missing title', url: top[0], howToFix: 'Add a unique title.' },
					{ severity: 'critical', issueType: 'missing_title', title: 'Missing title', url: 'https://greenleaf.example/never-seen', howToFix: 'Add a unique title.' },
					{ severity: 'info', issueType: 'image_missing_alt', title: 'Image without alt', url: top[1], howToFix: 'Add alt text.' }
				],
				total: 12, page: 1
			})
		});
		const snap = await syncAudit(1, { api });
		expect(calls[0]).toEqual({ name: 'get_audit_issues', args: { projectId: 'demo-proj-greenleaf', limit: 1000 } });
		expect(snap?.total).toBe(12);
		const items = buildActions(site()).filter((a) => a.type === 'audit');
		expect(items).toHaveLength(1); // info-level issues are left out; the page with no clicks is not evidence
		expect(items[0]).toMatchObject({ confidence: 'high', blocking: false, how: 'Add a unique title.', href: '/sites/1/onpage#openseo' });
		expect(items[0].title).toBe('OpenSEO audit: Missing title on 1 page that earns clicks');
		expect(items[0].evidence[0]).toMatch(/clicks\)$/);
	});
	it('no audit yet is not an error; another failure is kept to show', async () => {
		const none = recorder({ get_audit_issues: () => { throw new Error('No audits exist for this project yet. Start one with run_site_audit.'); } });
		expect(await syncAudit(1, { api: none.api })).toMatchObject({ error: null, total: 0 });
		const down = recorder({ get_audit_issues: () => { throw new Error('OpenSEO returned 500'); } });
		expect((await syncAudit(1, { api: down.api }))?.error).toBe('OpenSEO returned 500');
		expect(storedAudit(1)?.error).toBe('OpenSEO returned 500');
		expect(buildActions(site()).some((a) => a.type === 'audit')).toBe(false);
	});
});
