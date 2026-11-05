import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import type { GscClient, QueryBody } from '../src/lib/server/google';
import { appearanceFor, periodFor, summary, typeBreakdown, typeSeries } from '../src/lib/server/queries';
import { getSite } from '../src/lib/server/clients';
import { ALL_TYPES, appearanceLabel } from '../src/lib/searchTypes';

beforeEach(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
});

const typed = (b: QueryBody) => (b.type ?? b.searchType ?? 'web') !== 'web';
const rowsFor = (id: number, type?: string) => (db().prepare(`SELECT COUNT(*) n FROM site_daily_type WHERE site_id = ?${type ? ' AND search_type = ?' : ''}`).get(...(type ? [id, type] : [id])) as { n: number }).n;

/** Find a demo site that has image traffic and one that has none, so both paths are covered. */
async function sitesWithAndWithoutImages() {
	const c = new DemoClient('demo-a');
	const withImg: number[] = [];
	const without: number[] = [];
	for (const s of db().prepare("SELECT id, site_url FROM sites WHERE account_id = (SELECT id FROM accounts WHERE google_sub = 'demo-a')").all() as { id: number; site_url: string }[]) {
		const rows = await c.query(s.site_url, { startDate: '2026-01-01', endDate: '2026-12-31', dimensions: ['date'], type: 'image' });
		(rows.length ? withImg : without).push(s.id);
	}
	return { withImg, without };
}

describe('search types sync', () => {
	it('stores non-web totals for sites that have them, none for sites that do not, and leaves web untouched', async () => {
		const { withImg, without } = await sitesWithAndWithoutImages();
		expect(withImg.length).toBeGreaterThan(0);
		const client = new DemoClient('demo-a');
		const id = withImg[0];
		await syncSite(id, { client, backfillChunkDays: 30 });
		expect(rowsFor(id, 'image')).toBeGreaterThan(0);
		expect(getSite(id)!.types_synced_at).toBeTruthy();
		const p = periodFor(getSite(id)!, 28);
		const b = typeBreakdown(id, p.start, p.end);
		expect(b.web!.clicks).toBe(summary(id, p.start, p.end).clicks);
		expect(b.image!.impressions).toBeGreaterThan(0);
		expect(b.image!.clicks).toBeLessThan(b.web!.clicks); // a share of web, never a copy of it
		if (without.length) {
			await syncSite(without[0], { client, backfillChunkDays: 30 });
			expect(rowsFor(without[0], 'image')).toBe(0);
			expect(getSite(without[0])!.types_synced_at).toBeTruthy(); // nothing to fetch is still "done"
		}
	});

	it('pulls the whole history once, then only the recent window', async () => {
		const { withImg } = await sitesWithAndWithoutImages();
		const id = withImg[0];
		const real = new DemoClient('demo-a');
		const calls: QueryBody[] = [];
		const spy: GscClient = new Proxy(real, { get: (t, k) => (k === 'query' ? async (u: string, b: QueryBody) => (calls.push(b), t.query(u, b)) : (t as never)[k]) }) as never;
		await syncSite(id, { client: spy, backfillChunkDays: 30 });
		const firstSpan = calls.filter((c) => c.type === 'image' && c.dimensions?.[0] === 'date').map((c) => c.startDate);
		calls.length = 0;
		await syncSite(id, { client: spy, backfillChunkDays: 30 });
		const secondSpan = calls.filter((c) => c.type === 'image' && c.dimensions?.[0] === 'date').map((c) => c.startDate);
		expect(firstSpan[0] < secondSpan[0]).toBe(true); // first pull reaches back to the retention horizon, the next does not
	});

	it('never fails the main sync when a type errors, and retries the history pull next time', async () => {
		const real = new DemoClient('demo-a');
		const flaky: GscClient = new Proxy(real, { get: (t, k) => (k === 'query' ? async (u: string, b: QueryBody) => { if (b.type === 'discover') throw new Error('boom'); return t.query(u, b); } : (t as never)[k]) }) as never;
		const r = await syncSite(1, { client: flaky, backfillChunkDays: 30 });
		expect(r.days).toBeGreaterThan(0);
		expect(getSite(1)!.sync_status).toBe('idle');
		expect(getSite(1)!.types_synced_at).toBeNull();
	});

	it('refuses to store "image" data that is really web data (an API that ignored the filter)', async () => {
		const real = new DemoClient('demo-a');
		const ignoring: GscClient = new Proxy(real, { get: (t, k) => (k === 'query' ? async (u: string, b: QueryBody) => t.query(u, typed(b) ? { ...b, type: 'web', searchType: 'web' } : b) : (t as never)[k]) }) as never;
		await syncSite(1, { client: ignoring, backfillChunkDays: 30 });
		expect(rowsFor(1)).toBe(0);
		expect(getSite(1)!.types_synced_at).toBeNull();
	});

	it('stores the search-appearance report per window, once a day', async () => {
		const client = new DemoClient('demo-a');
		let appearanceCalls = 0;
		const spy: GscClient = new Proxy(client, { get: (t, k) => (k === 'query' ? async (u: string, b: QueryBody) => { if (b.dimensions?.[0] === 'searchAppearance') appearanceCalls++; return t.query(u, b); } : (t as never)[k]) }) as never;
		const { withImg } = await sitesWithAndWithoutImages();
		for (const id of [1, 2, 3, withImg[0]]) await syncSite(id, { client: spy, backfillChunkDays: 30 });
		const any = [1, 2, 3].map((id) => appearanceFor(id, 28)).find((a) => a.rows.length);
		expect(any).toBeTruthy();
		expect(any!.pulledOn).toBeTruthy();
		const before = appearanceCalls;
		await syncSite(1, { client: spy, backfillChunkDays: 30 });
		expect(appearanceCalls).toBe(before); // already pulled today
	});

	it('typeSeries is a filled calendar for every type', async () => {
		await syncSite(1, { client: new DemoClient('demo-a'), backfillChunkDays: 30 });
		const p = periodFor(getSite(1)!, 28);
		const s = typeSeries(1, p.start, p.end);
		for (const t of ALL_TYPES) expect(s[t]).toHaveLength(28);
		expect(s.web.some((n) => n > 0)).toBe(true);
	});
});

describe('labels', () => {
	it('humanises appearance codes without assuming a list', () => {
		expect(appearanceLabel('RICH_RESULT')).toBe('Rich Result');
		expect(appearanceLabel('AMP_BLUE_LINK')).toBe('Amp Blue Link');
		expect(appearanceLabel('')).toBe('');
	});
});
