import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { enqueueSiteSync, queueDepth } from '../src/lib/server/jobs';
import { getSite } from '../src/lib/server/clients';

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
});

describe('job queue', () => {
	it('chains backfill chunks through the queue until history is complete', async () => {
		await ensureDemoAccounts();
		expect(enqueueSiteSync(1, 'auto')).toBe(true);
		expect(enqueueSiteSync(1, 'auto')).toBe(false); // duplicate while queued/running is ignored
		const deadline = Date.now() + 60_000;
		while (Date.now() < deadline) {
			const s = getSite(1)!;
			const q = queueDepth();
			if (s.backfill_done && q.active + q.waiting === 0) break;
			await new Promise((r) => setTimeout(r, 100));
		}
		const s = getSite(1)!;
		expect(s.backfill_done).toBe(1);
		const days = (db().prepare('SELECT COUNT(*) n FROM site_daily WHERE site_id = 1').get() as { n: number }).n;
		expect(days).toBeGreaterThan(200);
	}, 90_000);
});
