import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts, upsertGoogleAccount } from '../src/lib/server/accounts';
import { autoMatchGa4 } from '../src/lib/server/connect';
import { ga4SourceFor, pullGa4Periods, syncGa4, type Ga4Source } from '../src/lib/server/channels';
import { landingPath, organicGoogleLanding, usersByChannel } from '../src/lib/server/ga4';
import { linksFor } from '../src/lib/server/links';
import { pacificToday } from '../src/lib/server/dates';
import { enqueueSiteSync } from '../src/lib/server/jobs';
import { PERIODS } from '../src/lib/periods';

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const n = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;

describe('GA4 request shapes and parsing', () => {
	it('strips query strings and fragments from landing pages, keeps the root', () => {
		expect(landingPath('/blog/x?utm_source=a#top')).toBe('/blog/x');
		expect(landingPath('/blog/x/')).toBe('/blog/x');
		expect(landingPath('/?ref=1')).toBe('/');
		expect(landingPath('')).toBe('/');
	});

	it('asks GA4 for unique users per channel with no date dimension (daily users cannot be summed)', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, unknown> = {};
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [{ dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '42' }] }] })));
		const rows = await usersByChannel(id, 'properties/1', '2026-01-01', '2026-01-28', { fetchImpl: f as never });
		expect(rows).toEqual([{ channel: 'Organic Search', users: 42 }]);
		expect((body.dimensions as { name: string }[]).map((d) => d.name)).toEqual(['sessionDefaultChannelGroup']);
		expect((body.metrics as { name: string }[]).map((m) => m.name)).toEqual(['totalUsers']);
	});

	it('requests Google-organic landing pages only, and merges rows that differ by query string', async () => {
		const id = upsertGoogleAccount({ sub: 's', email: 'a@b.c', accessToken: 'AT', refreshToken: 'RT', expiresIn: 3600, scope: 'analytics.readonly' });
		let body: Record<string, any> = {};
		const row = (page: string, s: number, e: number, k: number) => ({ dimensionValues: [{ value: page }], metricValues: [s, e, k].map((value) => ({ value: String(value) })) });
		const f = vi.fn(async (_u: string, init?: RequestInit) => ((body = JSON.parse(String(init?.body))), json({ rows: [row('/a?x=1', 10, 6, 1), row('/a/', 5, 3, 0), row('/b', 7, 7, 2)] })));
		const out = await organicGoogleLanding(id, 'properties/1', '2026-01-01', '2026-01-28', { fetchImpl: f as never });
		expect(out).toEqual([
			{ page: '/a', sessions: 15, engagedSessions: 9, keyEvents: 1 },
			{ page: '/b', sessions: 7, engagedSessions: 7, keyEvents: 2 }
		]);
		expect(body.dimensionFilter.filter).toEqual({ fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } });
		expect(body.dimensions).toEqual([{ name: 'landingPagePlusQueryString' }]);
	});
});

describe('GA4 period reports in sync', () => {
	async function linked() {
		await ensureDemoAccounts();
		await autoMatchGa4();
		// drain queued syncs from the match
		for (let i = 0; i < 200 && (n("SELECT COUNT(*) n FROM site_links WHERE kind='ga4' AND sync_status IN ('queued','running')") > 0); i++) await new Promise((r) => setTimeout(r, 50));
		return linksFor(1).ga4!;
	}

	it('stores unique users and landing pages for every period length, once a day', async () => {
		const link = await linked();
		const today = pacificToday();
		db().prepare('UPDATE sites SET ga4_periods_on = NULL').run();
		db().prepare('DELETE FROM ga4_period_users').run();
		db().prepare('DELETE FROM ga4_landing').run();
		const real = ga4SourceFor(link.account_id!);
		let calls = 0;
		const src: Ga4Source = { ...real, usersByChannel: (...a) => (calls++, real.usersByChannel(...a)), landing: (...a) => (calls++, real.landing(...a)) };
		expect((await pullGa4Periods(1, link.external_id, src, today)).ok).toBe(true);
		expect(calls).toBe(PERIODS.length * 2);
		for (const days of PERIODS) {
			expect(n('SELECT COUNT(*) n FROM ga4_period_users WHERE site_id = 1 AND days = ?', days)).toBeGreaterThan(0);
			expect(n('SELECT COUNT(*) n FROM ga4_landing WHERE site_id = 1 AND days = ?', days)).toBeGreaterThan(0);
		}
		// unique users over a window are fewer than the sum of daily users
		const summed = n("SELECT SUM(users) n FROM ga4_daily WHERE site_id = 1 AND channel = 'Organic Search' AND date >= date(?, '-27 day')", today);
		const unique = n("SELECT users n FROM ga4_period_users WHERE site_id = 1 AND days = 28 AND channel = 'Organic Search'");
		expect(unique).toBeLessThan(summed);
		await pullGa4Periods(1, link.external_id, src, today);
		expect(calls).toBe(PERIODS.length * 2); // second call the same day does nothing
	});

	it('a failing report never fails the GA4 sync, and is retried next time', async () => {
		const link = await linked();
		db().prepare('UPDATE sites SET ga4_periods_on = NULL').run();
		const real = ga4SourceFor(link.account_id!);
		const broken: Ga4Source = { ...real, landing: async () => { throw new Error('quota'); } };
		const r = await syncGa4(1, broken);
		expect(r.rows).toBeGreaterThanOrEqual(0);
		expect(linksFor(1).ga4!.sync_status).toBe('idle');
		expect(linksFor(1).ga4!.sync_message).toMatch(/will retry/);
		expect((db().prepare('SELECT ga4_periods_on FROM sites WHERE id = 1').get() as { ga4_periods_on: string | null }).ga4_periods_on).toBeNull();
		await syncGa4(1, real);
		expect(linksFor(1).ga4!.sync_message).toBeNull();
	});
});
void enqueueSiteSync;
