import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { anonymisedShare, siteCards, summary, periodFor, queryPageRows } from '../src/lib/server/queries';
import { getSite } from '../src/lib/server/clients';
import { decrypt, encrypt } from '../src/lib/server/crypto';
import { addDays, makePeriod, pacificToday } from '../src/lib/server/dates';

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

describe('crypto', () => {
	it('round-trips and rejects tampering', () => {
		const c = encrypt('refresh-token-123');
		expect(c).not.toContain('refresh-token');
		expect(decrypt(c)).toBe('refresh-token-123');
		expect(() => decrypt(c.slice(0, -4) + 'AAAA')).toThrow();
	});
});

describe('dates', () => {
	it('builds an equal-length previous period', () => {
		const p = makePeriod('2026-03-31', 28);
		expect(p.start).toBe('2026-03-04');
		expect(p.prevEnd).toBe('2026-03-03');
		expect(p.prevStart).toBe('2026-02-04');
	});
});

describe('sync engine (demo client)', () => {
	it('pulls recent days, then backfills in resumable chunks until history ends', async () => {
		await ensureDemoAccounts();
		const site = getSite(1)!;
		expect(site.site_url).toContain('greenleaf');
		const client = new DemoClient('demo-a');

		const r1 = await syncSite(1, { client, backfillChunkDays: 60 });
		const s1 = getSite(1)!;
		expect(r1.days).toBeGreaterThan(60); // a week of recent days + a 60-day chunk
		expect(s1.synced_through).toBe(addDays(pacificToday(), -2));
		expect(s1.sync_status).toBe('idle');

		// keep going until the demo history (240 days) is exhausted
		let guard = 0;
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 60 });
		const done = getSite(1)!;
		expect(done.backfill_done).toBe(1);
		const days = (db().prepare('SELECT COUNT(*) n FROM site_daily WHERE site_id = 1').get() as { n: number }).n;
		expect(days).toBeGreaterThan(200);
		expect(days).toBeLessThanOrEqual(242);
	}, 120_000);

	it('is idempotent: re-syncing does not duplicate rows', async () => {
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		await syncSite(1, { client, mode: 'incremental' });
		const count = () => (db().prepare('SELECT COUNT(*) n FROM sa_rows WHERE site_id = 1').get() as { n: number }).n;
		const a = count();
		await syncSite(1, { client, mode: 'incremental' });
		expect(count()).toBe(a);
	});

	it('records an error and status when the API fails', async () => {
		await ensureDemoAccounts();
		const bad = new DemoClient('demo-a');
		bad.query = async () => { throw new Error('quota exceeded'); };
		await expect(syncSite(1, { client: bad })).rejects.toThrow('quota');
		const s = getSite(1)!;
		expect(s.sync_status).toBe('error');
		expect(s.sync_message).toContain('quota');
	});

	it('exposes anonymised-query share and portfolio cards', async () => {
		await ensureDemoAccounts();
		await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
		const site = getSite(1)!;
		const p = periodFor(site, 7);
		const share = anonymisedShare(1, p.start, p.end)!;
		expect(share).toBeGreaterThan(0.05);
		expect(share).toBeLessThan(0.3);
		expect(summary(1, p.start, p.end).clicks).toBeGreaterThan(0);
		expect(queryPageRows(1, p.start, p.end).length).toBeGreaterThan(50);
		expect(siteCards(7)).toHaveLength(6);
	});
});

import { db } from '../src/lib/server/db';
