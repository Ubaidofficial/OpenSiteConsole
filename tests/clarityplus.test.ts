import { describe, expect, it } from 'vitest';
import { botHeavyPages, clarityDevices, deviceFriction, frictionAroundChanges, inScope, normDevice, twoProportionZ, type PageSnapshot } from '../src/lib/clarityplus';
import { clarityPages, type ClarityPage } from '../src/lib/pageinsights';

const page = (url: string, sessions: number | null, rage: number | null, dead: number | null, bots?: number | null): ClarityPage => ({ url, sessions, rageClicks: rage, deadClicks: dead, botSessions: bots });

describe('twoProportionZ', () => {
	it('is zero when the rates match, positive when the second is higher, and zero when it cannot be told', () => {
		expect(twoProportionZ(10, 100, 10, 100)).toBe(0);
		expect(twoProportionZ(10, 100, 30, 100)).toBeGreaterThan(2);
		expect(twoProportionZ(30, 100, 10, 100)).toBeLessThan(-2);
		expect(twoProportionZ(0, 100, 0, 100)).toBe(0); // no friction at all: no standard error
		expect(twoProportionZ(1, 0, 1, 10)).toBe(0);
	});
});

describe('clarityPages reads the bot count when Clarity gives one', () => {
	it('sums bots per path and leaves the field out when there is none', () => {
		const rows = clarityPages([
			{ metricName: 'Traffic', information: [{ Url: 'https://x.example/a?x=1', totalSessionCount: '100', totalBotSessionCount: '30' }, { Url: 'https://x.example/a', totalSessionCount: '50', totalBotSessionCount: '5' }, { Url: '/b', totalSessionCount: '40' }] }
		]);
		expect(rows.find((r) => r.url === '/a')).toMatchObject({ sessions: 150, botSessions: 35 });
		expect(rows.find((r) => r.url === '/b')?.botSessions).toBeUndefined();
	});
});

describe('botHeavyPages', () => {
	const out = botHeavyPages([page('/scraped', 200, 0, 0, 120), page('/fine', 200, 0, 0, 10), page('/thin', 20, 0, 0, 19), page('/unknown', 300, 0, 0, null), page('/zero', 300, 0, 0, 0), page('/edge', 100, 0, 0, 25), page('/more', 100, 0, 0, 500)]);
	it('lists pages where bots are at least a quarter of sessions, most bot sessions first', () => {
		expect(out.map((r) => r.page)).toEqual(['/scraped', '/more', '/edge']); // /more is capped at its 100 sessions, so 120 bot sessions rank first
		expect(out[0]).toMatchObject({ sessions: 200, botSessions: 120, share: 0.6 });
	});
	it('says nothing without a bot count, with too few sessions, or below the share line', () => {
		for (const bad of ['/fine', '/thin', '/unknown', '/zero']) expect(out.map((r) => r.page)).not.toContain(bad);
	});
	it('never reports more bots than sessions', () => {
		expect(out.find((r) => r.page === '/more')).toMatchObject({ botSessions: 100, share: 1 });
	});
});

describe('clarityDevices and deviceFriction', () => {
	const metrics = (rows: [string, number, number, number][]) => [
		{ metricName: 'Traffic', information: rows.map(([d, s]) => ({ Device: d, totalSessionCount: String(s) })) },
		{ metricName: 'RageClickCount', information: rows.map(([d, , r]) => ({ Device: d, sessionsCount: String(r) })) },
		{ metricName: 'DeadClickCount', information: rows.map(([d, , , x]) => ({ Device: d, sessionsCount: String(x) })) }
	];
	it('maps Clarity device names and uses the larger of rage and dead per device', () => {
		const rows = clarityDevices(metrics([['Mobile', 2000, 30, 120], ['PC', 2600, 30, 52], ['Email client', 50, 0, 0]]));
		expect(rows).toEqual([{ device: 'mobile', sessions: 2000, frictionSessions: 120 }, { device: 'desktop', sessions: 2600, frictionSessions: 52 }]);
		expect(normDevice('DESKTOP')).toBe('desktop');
		expect(normDevice('Car browser')).toBeNull();
	});
	const dev = clarityDevices(metrics([['Mobile', 2000, 30, 120], ['PC', 2600, 30, 52], ['Tablet', 300, 2, 3]]));
	it('flags the device with clearly more friction than the rest, when Google really sends it traffic', () => {
		const out = deviceFriction(dev, { mobile: 600, desktop: 400, tablet: 20 });
		expect(out.map((r) => r.device)).toEqual(['mobile']);
		expect(out[0].rate).toBeCloseTo(0.06);
		expect(out[0].ratio).toBeGreaterThan(2);
		expect(out[0].extraSessions).toBeGreaterThan(50);
		expect(out[0].googleClickShare).toBeCloseTo(600 / 1020);
	});
	it('stays silent when the device is not a meaningful share of Google clicks, or sessions are few', () => {
		expect(deviceFriction(dev, { mobile: 5, desktop: 900, tablet: 20 })).toEqual([]);
		expect(deviceFriction(clarityDevices(metrics([['Mobile', 60, 0, 30], ['PC', 80, 0, 1]])), { mobile: 500, desktop: 500 })).toEqual([]);
	});
	it('stays silent for a gap that could be chance', () => {
		const close = clarityDevices(metrics([['Mobile', 120, 0, 6], ['PC', 120, 0, 3]])); // 5% vs 2.5%: ratio 2 but a handful of sessions
		expect(deviceFriction(close, { mobile: 500, desktop: 500 })).toEqual([]);
	});
});

describe('inScope', () => {
	it('matches a folder prefix and the folder page itself, not a sibling that merely starts the same', () => {
		expect(inScope('/blog/post', 'https://x.example/blog/')).toBe(true);
		expect(inScope('/blog', 'https://x.example/blog/')).toBe(true);
		expect(inScope('/blog-news/post', 'https://x.example/blog/')).toBe(false);
		expect(inScope('/guides/a', '/guides')).toBe(true);
		expect(inScope('/anything', null)).toBe(true);
	});
});

describe('frictionAroundChanges', () => {
	const day = (n: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + n * 86_400_000).toISOString().slice(0, 10);
	// 20 daily snapshots, change on day 10. /shop: 4% friction before, 12% after. /blog: steady 3%.
	const snaps: PageSnapshot[] = Array.from({ length: 20 }, (_, i) => ({ day: day(i), pages: [page('/shop/a', 100, 2, 4), page('/shop/b', 100, 1, i > 11 ? 12 : 4), page('/blog/x', 200, 6, 5)] }));
	const change = { id: 1, date: day(10), title: 'New checkout', page_prefix: 'https://x.example/shop/' };

	it('reports a clear rise in friction after a change, over only the pages it covers', () => {
		const [r] = frictionAroundChanges(snaps, [change]);
		expect(r.verdict).toBe('worse');
		expect(r.rateAfter).toBeGreaterThan(r.rateBefore + 0.01);
		expect(r.scope).toBe('https://x.example/shop/');
		// the change day and the day after are set aside, so the "after" side starts two days later
		expect(r.snapshotsBefore).toBe(10);
		expect(r.snapshotsAfter).toBe(8);
	});
	it('reports a fall as better, and a site-wide change over every page', () => {
		const flipped = snaps.map((s, i) => ({ ...s, pages: [page('/shop/a', 100, 8, 12), page('/shop/b', 100, 2, i > 11 ? 3 : 12)] }));
		expect(frictionAroundChanges(flipped, [change])[0].verdict).toBe('better');
		expect(frictionAroundChanges(snaps, [{ ...change, page_prefix: null }])[0].verdict).toBe('worse');
	});
	it('says no clear change for a steady section', () => {
		expect(frictionAroundChanges(snaps, [{ ...change, id: 2, page_prefix: '/blog/' }])[0].verdict).toBe('no clear change');
	});
	it('says too little data rather than guessing: few snapshots, few sessions, or one side empty', () => {
		expect(frictionAroundChanges(snaps, [{ ...change, date: day(18) }]).map((r) => r.verdict)).toEqual([]); // nothing after yet
		expect(frictionAroundChanges(snaps, [{ ...change, date: day(16) }])[0].verdict).toBe('too little data'); // only two snapshots after the change; three are needed
	});
	it('needs enough sessions on both sides', () => {
		const thin = snaps.map((s) => ({ ...s, pages: [page('/shop/a', 5, 0, 1)] }));
		expect(frictionAroundChanges(thin, [change])[0].verdict).toBe('too little data');
	});
	it('lists the newest change first and honours the limit', () => {
		const list = frictionAroundChanges(snaps, [{ ...change, id: 1, date: day(5) }, { ...change, id: 2, date: day(10) }]);
		expect(list.map((r) => r.id)).toEqual([2, 1]);
		expect(frictionAroundChanges(snaps, [{ ...change, id: 1, date: day(5) }, { ...change, id: 2, date: day(10) }], { limit: 1 })).toHaveLength(1);
	});
});
