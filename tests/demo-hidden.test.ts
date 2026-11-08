import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient, plantedQuery } from '../src/lib/server/demo';
import { autoMatchGa4, connectBingKey, connectClarity } from '../src/lib/server/connect';
import { syncClarity } from '../src/lib/server/channels';
import { queueDepth } from '../src/lib/server/jobs';
import { getSite } from '../src/lib/server/clients';
import { hiddenReport } from '../src/lib/server/hidden';

/**
 * The demo exists to show what the app finds, so every kind of hidden opportunity must have at least one row on demo data, from
 * the real sync path (not rows written by hand). The patterns are planted relative to the newest demo day, so this holds on any date.
 */
const drain = async () => {
	const end = Date.now() + 60_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

let report: ReturnType<typeof hiddenReport>;
const TOPIC = 'garden tools'; // site 1 is greenleaf.example

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	// The way the app runs it: recent days first, then one backfill chunk, which here reaches past the previous 28-day window.
	await syncSite(1, { client: new DemoClient('demo-a'), mode: 'auto', backfillChunkDays: 60 });
	await connectBingKey('demo', 'b');
	await autoMatchGa4();
	await connectClarity(1, 'demo');
	await drain();
	await syncClarity(1, { force: true }); // the by-page snapshot the report reads (the connect call stores only the site-wide one)
	report = hiddenReport(getSite(1)!, 28);
}, 180_000);

describe('demo data shows every kind of hidden opportunity', () => {
	it('every source is connected and has data', () => {
		expect(report.sources).toEqual({ previousPeriod: 'ok', bing: 'ok', ga4: 'ok', clarity: 'ok' });
	});
	it('Google over two periods: the planted lost and rising searches', () => {
		expect(report.lost.map((r) => r.query)).toContain(plantedQuery(TOPIC, 'lost'));
		expect(report.rising.map((r) => r.query)).toContain(plantedQuery(TOPIC, 'rising'));
	});
	it('phones against desktop: the planted search ranks much worse on phones', () => {
		const g = report.device.find((r) => r.query === plantedQuery(TOPIC, 'device'));
		expect(g).toBeTruthy();
		expect(g!.mobilePosition - g!.desktopPosition).toBeGreaterThanOrEqual(3);
	});
	it('Bing against Google: a search Bing ranks near the top, and pages Bing shows nothing for', () => {
		const b = report.bingGaps.find((r) => r.query === plantedQuery(TOPIC, 'bing'));
		expect(b).toBeTruthy();
		expect(b!.bingPosition).toBeLessThanOrEqual(5);
		expect(report.notInBing.length).toBeGreaterThan(0);
	});
	it('GA4: pages visitors leave, busy pages that never convert, and hidden gems', () => {
		expect(report.engagement.length).toBeGreaterThan(0);
		expect(report.conversions.length).toBeGreaterThan(0);
		expect(report.gems.length).toBeGreaterThan(0);
	});
	it('Clarity: the planted page where real visitors hit dead clicks', () => {
		expect(report.friction.map((r) => r.page)).toContain('/products/garden-tools-6');
	});
	it('the Google-only sections keep working', () => {
		expect(report.pageEdge.length).toBeGreaterThan(0);
		expect(report.questions.length).toBeGreaterThan(0);
	});
});
