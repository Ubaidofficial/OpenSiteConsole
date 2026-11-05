import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { syncSite } from '../src/lib/server/sync';
import { getSite } from '../src/lib/server/clients';
import { addDays, eachDay, pacificToday } from '../src/lib/server/dates';
import type { GscClient, QueryBody, SearchRow } from '../src/lib/server/google';

/** A low-traffic site like a real small property: impressions only on a few scattered, mostly old days. */
function sparseClient(daysAgoWithData: number[], today: string): GscClient {
	const has = new Set(daysAgoWithData.map((n) => addDays(today, -n)));
	const rowFor = (keys: string[]): SearchRow => ({ keys, clicks: 1, impressions: 20, ctr: 0.05, position: 12 });
	return {
		listSites: async () => [],
		addSite: async () => {},
		deleteSite: async () => {},
		listSitemaps: async () => [],
		submitSitemap: async () => {},
		deleteSitemap: async () => {},
		inspectUrl: async () => ({}),
		query: async (_u: string, b: QueryBody) => {
			const days = eachDay(b.startDate, b.endDate).filter((d) => has.has(d));
			if (b.dimensions?.[0] === 'date') return days.map((d) => rowFor([d]));
			return days.length ? [rowFor(['best widget', 'https://x.example/p', 'usa', 'MOBILE'])] : [];
		}
	};
}

beforeEach(() => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	db().prepare("INSERT INTO accounts (id, google_sub, email, created_at) VALUES (1,'s','a@b.c',1)").run();
	db().prepare("INSERT INTO sites (id, account_id, site_url, permission, created_at) VALUES (1,1,'https://x.example/','siteOwner',1)").run();
});

const stored = () => (db().prepare('SELECT COUNT(*) n FROM site_daily WHERE site_id = 1').get() as { n: number }).n;

async function runToCompletion(client: GscClient, today: string) {
	let guard = 0;
	while (!getSite(1)!.backfill_done && guard++ < 40) await syncSite(1, { client, today, backfillChunkDays: 45 });
	return guard;
}

describe('backfill on low-traffic properties', () => {
	it('finds history even when the last 7 days have no traffic at all', async () => {
		const today = pacificToday();
		const client = sparseClient([30, 90, 200], today); // nothing in the last 29 days
		await runToCompletion(client, today);
		expect(stored()).toBe(3);
		expect(getSite(1)!.backfill_done).toBe(1);
	});

	it('does not stop at a long quiet stretch: older data beyond a 45+ day gap is still found', async () => {
		const today = pacificToday();
		const client = sparseClient([3, 5, 120, 300], today); // recent days, then a 100+ day gap, then old data
		await runToCompletion(client, today);
		expect(stored()).toBe(4);
	});

	it('a property with no data at all still finishes (and cheaply)', async () => {
		const today = pacificToday();
		const iterations = await runToCompletion(sparseClient([], today), today);
		expect(stored()).toBe(0);
		expect(getSite(1)!.backfill_done).toBe(1);
		expect(iterations).toBeLessThan(15);
	});
});
