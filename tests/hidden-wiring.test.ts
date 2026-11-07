import { beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { autoMatchGa4, connectBingKey, connectClarity } from '../src/lib/server/connect';
import { queueDepth } from '../src/lib/server/jobs';
import { getSite } from '../src/lib/server/clients';
import { periodFor } from '../src/lib/server/queries';
import { addDays } from '../src/lib/server/dates';
import { actionsFor, queueFor, setActionState } from '../src/lib/server/actions';
import { hiddenReport } from '../src/lib/server/hidden';
import { createApiKey } from '../src/lib/server/apikeys';
import { handleMcp, MCP_TOOL_NAMES } from '../src/lib/server/mcp';
import { ACTION_TYPES, NAMES_TARGETS } from '../src/lib/actions';

const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};
let key = '';
const tool = async (name: string, args: object = {}) => {
	const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
	const r = (await res.json()).result;
	return { isError: !!r.isError, data: r.isError ? (r.content[0].text as string) : JSON.parse(r.content[0].text) };
};

const DAYS = 28;
let origin = '';
let now: { start: string; end: string; prevStart: string; prevEnd: string };

/** One Search Console row, on the last day of the window or the last day of the one before. */
const sa = (when: 'now' | 'prev', query: string, page: string, clicks: number, impressions: number, position: number, device = 'MOBILE') =>
	db().prepare('INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (1,?,?,?,?,?,?,?,?)').run(when === 'now' ? now.end : now.prevEnd, query, origin + page, 'usa', device, clicks, impressions, position);
const bing = (kind: 'query' | 'page', term: string, clicks: number, impressions: number, pos: number) =>
	db().prepare('INSERT OR REPLACE INTO bing_terms (site_id, kind, date, term, clicks, impressions, click_pos, impr_pos) VALUES (1,?,?,?,?,?,?,?)').run(kind, now.end, term, clicks, impressions, pos, pos);
const ga = (page: string, sessions: number, engaged: number, keyEvents: number) =>
	db().prepare('INSERT OR REPLACE INTO ga4_landing (site_id, days, page, sessions, engaged_sessions, key_events, pulled_on) VALUES (1,?,?,?,?,?,?)').run(DAYS, page, sessions, engaged, keyEvents, now.end);

/** The same row in both windows: a search that is steady, so only the planted changes count as news. */
const steady = (query: string, page: string, clicks: number, impressions: number, position: number, device = 'MOBILE') => {
	sa('now', query, page, clicks, impressions, position, device);
	sa('prev', query, page, clicks, impressions, position, device);
};

function plant() {
	const d = db();
	d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
	d.prepare('DELETE FROM bing_terms WHERE site_id = 1').run();
	d.prepare('DELETE FROM ga4_landing WHERE site_id = 1').run();
	d.prepare('DELETE FROM clarity_snapshots WHERE site_id = 1').run();
	d.prepare('DELETE FROM action_cache WHERE site_id = 1').run();
	d.prepare('UPDATE sites SET brand_terms = ?, backfill_done = 1 WHERE id = 1').run('greenleaf');

	// Google: filler that makes a believable curve, plus one planted case of each pattern.
	for (let i = 0; i < 12; i++) steady(`filler ${i}`, `/filler-${i}`, 30, 600, 2 + (i % 9));
	sa('prev', 'lost topic', '/guide', 40, 700, 3); sa('now', 'lost topic', '/guide', 2, 300, 14);
	sa('prev', 'rising topic', '/guide', 1, 20, 14); sa('now', 'rising topic', '/guide', 2, 120, 12);
	sa('prev', 'rising two', '/guide', 0, 10, 22); sa('now', 'rising two', '/guide', 1, 60, 20);
	for (const [q, imp, pos] of [['edge one', 120, 5], ['edge two', 100, 7], ['edge three', 100, 9], ['edge four', 80, 12], ['edge five', 80, 15]] as [string, number, number][]) steady(q, '/edge', Math.round(imp * 0.05), imp, pos); // about 5% click-through, like the rest of the site, so the fitted curve is sane
	for (const page of ['/edge-b', '/edge-c']) for (const [i, pos] of [5, 7, 9, 12].entries()) steady(`${page.slice(1)} query ${i}`, page, 5, 100, pos);
	steady('how to fix plant topic', '/howto', 1, 200, 12);
	steady('bing only topic', '/bingfan', 1, 150, 18);
	steady('phone topic', '/phone', 1, 200, 14, 'MOBILE'); steady('phone topic', '/phone', 4, 80, 5, 'DESKTOP');
	steady('gem topic', '/gem', 6, 400, 9);
	steady('friction topic', '/friction', 20, 300, 4);
	steady('not in bing topic', '/gone-from-bing', 30, 300, 4);

	// Bing: a query it ranks near the top that Google barely shows, and five pages (so "pages Bing lacks" is meaningful) without /gone-from-bing.
	bing('query', 'bing only topic', 5, 60, 2);
	for (const p of ['/', '/guide', '/edge', '/gem', '/friction']) bing('page', origin + p, 3, 100, 4);

	// GA4: the site converts and engages about as expected, apart from three planted pages.
	ga('/', 800, 440, 20); ga('/leaky', 250, 50, 0); ga('/gem', 100, 80, 8); ga('/friction', 50, 30, 1);
	const pg = (u: string, n: string, v: number) => ({ Url: origin + u, [n]: v });
	d.prepare("INSERT INTO clarity_snapshots (site_id, day, dimension, payload, fetched_at) VALUES (1,?,'URL',?,?)").run(now.end, JSON.stringify([
		{ metricName: 'Traffic', information: [pg('/friction', 'totalSessionCount', 100)] },
		{ metricName: 'RageClickCount', information: [pg('/friction', 'sessionsCount', 12)] }
	]), Date.now());
}

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
	await connectBingKey('demo', 'b');
	await autoMatchGa4();
	await connectClarity(1, 'demo');
	await drain();
	key = createApiKey('all', null).key;
	const site = getSite(1)!;
	origin = new URL(site.site_url.startsWith('sc-domain:') ? 'https://' + site.site_url.slice(10) : site.site_url).origin;
	const p = periodFor(site, DAYS);
	now = { start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd };
	plant();
}, 120_000);

/** A real sync moves the site's sync stamps, which invalidates the cached queue; raw edits in these tests have to do the same by hand. */
const fresh = () => void db().prepare('DELETE FROM action_cache').run();
const items = () => actionsFor(getSite(1)!, DAYS);
const byKey = (k: string) => items().find((i) => i.key === k);

describe('the report finds each planted pattern from the right source', () => {
	const h = () => hiddenReport(getSite(1)!, DAYS);
	it('knows which sources are present', () => {
		expect(h().sources).toEqual({ previousPeriod: 'ok', bing: 'ok', ga4: 'ok', clarity: 'ok' });
	});
	it('Google over two periods: a lost search and a rising one', () => {
		expect(h().lost.map((r) => r.query)).toEqual(['lost topic']);
		expect(h().lost[0]).toMatchObject({ prevClicks: 40, clicks: 2, lostClicks: 38 });
		expect(h().rising.map((r) => r.query)).toEqual(['rising topic', 'rising two']);
	});
	it('Google on one page: many searches near the top, and a question', () => {
		expect(h().pageEdge.map((r) => new URL(r.page).pathname)).toEqual(['/edge', '/edge-b', '/edge-c']); // biggest prize first
		expect(h().pageEdge[0]).toMatchObject({ queries: 5, impressions: 480 });
		expect(h().questions.map((r) => r.query)).toEqual(['how to fix plant topic']);
	});
	it('Bing against Google', () => {
		expect(h().bingGaps.map((r) => r.query)).toEqual(['bing only topic']);
		expect(h().bingGaps[0]).toMatchObject({ bingPosition: 2, googlePosition: 18 });
		expect(h().notInBing.map((r) => new URL(r.page).pathname)).toContain('/gone-from-bing');
	});
	it('GA4: a leaking page, a page with no key events, and a gem', () => {
		expect(h().engagement.map((r) => r.page)).toEqual(['/leaky']);
		expect(h().conversions.map((r) => r.page)).toEqual(['/leaky']);
		expect(h().gems.map((r) => r.page)).toEqual(['/gem']);
	});
	it('Clarity: friction on a page Google sends visitors to', () => {
		expect(h().friction.map((r) => r.page)).toEqual(['/friction']);
		expect(h().friction[0]).toMatchObject({ sessions: 100, frictionSessions: 12, rate: 0.12 });
	});
	it('phones against desktop', () => {
		expect(h().device.map((r) => r.query)).toEqual(['phone topic']);
	});
});

describe('they reach the ranked action queue, in plain language, with honest numbers', () => {
	it('every kind appears once with the key the app uses to remember done and snooze', () => {
		for (const k of ['hidden:lost', 'hidden:rising', 'hidden:questions', 'hidden:bing-gaps', 'hidden:not-in-bing', 'hidden:device', 'hidden:engagement', 'hidden:conversions', 'hidden:friction']) expect(byKey(k), k).toBeTruthy();
		expect(items().filter((i) => i.key.startsWith('hidden:edge:'))).toHaveLength(2); // three pages qualify; only the two best are queued
		expect(items().filter((i) => i.key.startsWith('hidden:gem:'))).toHaveLength(1);
		const keys = items().map((i) => i.key);
		expect(new Set(keys).size).toBe(keys.length);
	});
	it('none of them blocks the site, and each names what to look at', () => {
		for (const i of items().filter((x) => x.key.startsWith('hidden:'))) {
			expect(i.blocking, i.key).toBe(false);
			expect(i.evidence.length, i.key).toBeGreaterThan(0);
			expect(i.how.length, i.key).toBeGreaterThan(40);
			expect(i.href.startsWith('/sites/1/'), i.key).toBe(true);
		}
	});
	it('each item opens the tab where the problem is worked on', () => {
		const href = (k: string) => byKey(k)!.href;
		expect(href('hidden:lost')).toBe('/sites/1/queries');
		expect(href('hidden:rising')).toBe('/sites/1/opportunities');
		expect(href('hidden:questions')).toBe('/sites/1/queries');
		expect(href('hidden:bing-gaps')).toBe('/sites/1/bing');
		expect(href('hidden:not-in-bing')).toBe('/sites/1/indexnow');
		expect(href('hidden:device')).toBe('/sites/1/vitals');
		expect(href('hidden:engagement')).toBe('/sites/1/analytics');
		expect(href('hidden:conversions')).toBe('/sites/1/analytics');
		expect(href('hidden:friction')).toBe('/sites/1/clarity');
		expect(items().find((i) => i.key.startsWith('hidden:edge:'))!.href).toBe('/sites/1/pages');
		expect(items().find((i) => i.key.startsWith('hidden:gem:'))!.href).toBe('/sites/1/analytics');
	});
	it('the lost-search item states the clicks lost, and the evidence names the search and its change', () => {
		const i = byKey('hidden:lost')!;
		expect(i.type).toBe('lost-query');
		expect(i.impact).toBe(38);
		expect(i.evidence[0]).toContain('“lost topic” (40 → 2 clicks');
		expect(i.why).toContain('40 clicks in the previous 28 days and 2 now');
	});
	it('items with no honest click figure say so rather than invent one', () => {
		for (const k of ['hidden:not-in-bing', 'hidden:engagement', 'hidden:conversions', 'hidden:friction']) expect(byKey(k)!.impact, k).toBeNull();
		expect(byKey('hidden:bing-gaps')!.impact).toBeGreaterThan(0); // Google shows the search, so it can be priced
		for (const k of ['hidden:rising', 'hidden:questions', 'hidden:device']) expect(byKey(k)!.impact, k).toBeGreaterThan(0);
	});
	it('claims are labelled with their confidence: the ceiling-type estimates are low, the measured ones medium', () => {
		expect(byKey('hidden:lost')!.confidence).toBe('medium');
		expect(items().find((i) => i.key.startsWith('hidden:edge:'))!.confidence).toBe('low');
		expect(items().find((i) => i.key.startsWith('hidden:gem:'))!.confidence).toBe('medium');
		for (const k of ['hidden:bing-gaps', 'hidden:friction', 'hidden:device', 'hidden:rising']) expect(byKey(k)!.confidence, k).toBe('low');
	});
	it('the gem and the edge page are named in the queue with their own numbers', () => {
		const gem = items().find((i) => i.key.startsWith('hidden:gem:'))!;
		expect(gem.title).toContain('/gem converts better than average but ranks 9.0');
		expect(gem.why).toContain('100 organic sessions, 80% engaged');
		const edge = items().find((i) => i.key.startsWith('hidden:edge:'))!;
		expect(items().filter((i) => i.key.startsWith('hidden:edge:')).map((i) => i.title)).toEqual(['/edge sits just below the top for 5 searches', '/edge-b sits just below the top for 4 searches']);
		expect(edge.title).toBe('/edge sits just below the top for 5 searches');
		expect(edge.evidence).toHaveLength(5);
	});
	it('done and snooze work for the new kinds, because their keys are stable', () => {
		const site = getSite(1)!;
		expect(queueFor(site).open.some((i) => i.key === 'hidden:lost')).toBe(true);
		setActionState(1, 'hidden:lost', 'done');
		expect(queueFor(site).open.some((i) => i.key === 'hidden:lost')).toBe(false);
		setActionState(1, 'hidden:lost', 'open');
		expect(queueFor(site).open.some((i) => i.key === 'hidden:lost')).toBe(true);
	});
	it('every new kind is a registered type whose text may name pages or searches, so privacy mode blurs it', () => {
		for (const t of ['lost-query', 'rising', 'page-edge', 'gem', 'questions', 'bing', 'device', 'engagement', 'friction']) {
			expect(ACTION_TYPES as readonly string[]).toContain(t);
			expect(NAMES_TARGETS.has(t as never), t).toBe(true);
		}
	});
});

describe('guards: a finding needs enough evidence, and a missing source is not read as a finding', () => {
	it('a loss too small to matter is not queued', () => {
		sa('prev', 'lost topic', '/guide', 9, 700, 3);
		db().prepare("DELETE FROM sa_rows WHERE site_id = 1 AND query = 'lost topic' AND date = ?").run(now.end);
		fresh();
		expect(hiddenReport(getSite(1)!, DAYS).lost).toHaveLength(1); // the detector sees it (9 clicks gone)
		expect(byKey('hidden:lost')).toBeUndefined(); // but 9 clicks is under the queue's floor of 10
		plant();
		expect(byKey('hidden:lost')).toBeTruthy();
	});
	it('a page on the edge whose prize is negligible is not queued, even if it qualifies as a finding', () => {
		db().prepare("DELETE FROM sa_rows WHERE site_id = 1 AND (page LIKE '%/edge-b' OR page LIKE '%/edge-c')").run();
		for (const [i, pos] of [5, 5.4, 6, 6.4].entries()) steady(`tiny edge ${i}`, '/edge-d', 1, 25, pos);
		fresh();
		const r = hiddenReport(getSite(1)!, DAYS).pageEdge;
		expect(r.map((e) => new URL(e.page).pathname)).toEqual(['/edge', '/edge-d']);
		expect(r[1].gain).toBeLessThan(3);
		expect(items().filter((i) => i.key.startsWith('hidden:edge:')).map((i) => i.title)).toEqual(['/edge sits just below the top for 5 searches']);
		plant();
		expect(items().filter((i) => i.key.startsWith('hidden:edge:'))).toHaveLength(2);
	});
	it('a Bing gap on a search Google never shows has no click estimate, and is still reported', () => {
		db().prepare("DELETE FROM sa_rows WHERE site_id = 1 AND query = 'bing only topic'").run();
		fresh();
		const i = byKey('hidden:bing-gaps')!;
		expect(i).toBeTruthy();
		expect(i.impact).toBeNull();
		expect(i.why).not.toContain('would be worth about');
		plant();
		expect(byKey('hidden:bing-gaps')!.impact).toBeGreaterThan(0);
	});
	it('"pages Bing lacks" needs Bing to know at least five pages, or it would just mean Bing is not synced', () => {
		db().prepare("DELETE FROM bing_terms WHERE site_id = 1 AND kind = 'page' AND term NOT IN (?, ?, ?)").run(origin + '/', origin + '/guide', origin + '/edge');
		fresh();
		expect(hiddenReport(getSite(1)!, DAYS).notInBing).toEqual([]);
		expect(byKey('hidden:not-in-bing')).toBeUndefined();
		plant();
		expect(byKey('hidden:not-in-bing')).toBeTruthy();
	});
	it('GA4 findings use the pull made for exactly the window asked for', () => {
		expect(hiddenReport(getSite(1)!, 28).sources.ga4).toBe('ok');
		expect(hiddenReport(getSite(1)!, 7).sources.ga4).toBe('no-data'); // only the 28-day pull is stored
		expect(hiddenReport(getSite(1)!, 7).engagement).toEqual([]);
	});
	it('each source reports no-data when connected but empty, and not-connected when unlinked', () => {
		db().prepare('DELETE FROM ga4_landing WHERE site_id = 1').run();
		db().prepare("UPDATE clarity_snapshots SET payload = '[]' WHERE site_id = 1").run();
		const s = hiddenReport(getSite(1)!, DAYS).sources;
		expect(s.ga4).toBe('no-data');
		expect(s.clarity).toBe('no-data');
		plant();
		const saved = db().prepare("SELECT * FROM site_links WHERE site_id = 1 AND kind IN ('bing', 'ga4', 'clarity')").all() as Record<string, unknown>[];
		expect(saved).toHaveLength(3);
		db().prepare("DELETE FROM site_links WHERE site_id = 1 AND kind IN ('bing', 'ga4', 'clarity')").run();
		try {
			expect(hiddenReport(getSite(1)!, DAYS).sources).toEqual({ previousPeriod: 'ok', bing: 'not-connected', ga4: 'not-connected', clarity: 'not-connected' });
			expect(hiddenReport(getSite(1)!, DAYS).bingGaps).toEqual([]); // unlinked sources produce nothing even if their old rows remain
			expect(hiddenReport(getSite(1)!, DAYS).engagement).toEqual([]);
			expect(hiddenReport(getSite(1)!, DAYS).friction).toEqual([]);
		} finally {
			for (const r of saved) db().prepare('INSERT INTO site_links (site_id, kind, integration_id, account_id, external_id, label, last_sync_at, sync_status, sync_message, created_at) VALUES (@site_id, @kind, @integration_id, @account_id, @external_id, @label, @last_sync_at, @sync_status, @sync_message, @created_at)').run(r);
		}
	});
});

describe('the cached queue notices when Bing, GA4 or Clarity data changes', () => {
	it('a new GA4 pull changes the findings without waiting for a Google sync', () => {
		expect(byKey('hidden:engagement')).toBeTruthy();
		db().prepare('DELETE FROM ga4_landing WHERE site_id = 1').run();
		expect(byKey('hidden:engagement')).toBeUndefined();
		expect(byKey('hidden:conversions')).toBeUndefined();
		ga('/', 800, 440, 20); ga('/leaky', 250, 50, 0); ga('/gem', 100, 80, 8); ga('/friction', 50, 30, 1);
		expect(byKey('hidden:engagement')).toBeTruthy();
	});
	it('new Bing rows are picked up', () => {
		expect(byKey('hidden:bing-gaps')).toBeTruthy();
		db().prepare("DELETE FROM bing_terms WHERE site_id = 1 AND kind = 'query'").run();
		expect(byKey('hidden:bing-gaps')).toBeUndefined();
		bing('query', 'bing only topic', 5, 60, 2);
		expect(byKey('hidden:bing-gaps')).toBeTruthy();
	});
	it('a new Clarity snapshot is picked up', () => {
		expect(byKey('hidden:friction')).toBeTruthy();
		db().prepare("UPDATE clarity_snapshots SET payload = '[]', fetched_at = fetched_at + 1 WHERE site_id = 1").run(); // what a re-fetch the same day does
		expect(byKey('hidden:friction')).toBeUndefined();
	});
});

describe('Claude can ask for each of them in plain language through the existing tool', () => {
	it('the tool count the website advertises has not changed', () => {
		expect(MCP_TOOL_NAMES).toHaveLength(29);
	});
	it('hidden_overview counts every kind and says which sources are missing', async () => {
		plant();
		const r = await tool('get_opportunities', { site: '1', type: 'hidden_overview' });
		expect(r.isError).toBe(false);
		expect(r.data.sources).toEqual({ previousPeriod: 'ok', bing: 'ok', ga4: 'ok', clarity: 'ok' });
		expect(r.data.found).toEqual({ lost_queries: 1, rising_queries: 2, pages_on_the_edge: 3, question_gaps: 1, bing_gaps: 1, not_in_bing: 15 /* the planted page, the 12 filler pages and the two extra edge pages, none of which Bing lists */, hidden_gems: 1, engagement_leaks: 1, conversion_leaks: 1, friction: 1, mobile_gaps: 1 });
	});
	it('each type returns its rows with the names an assistant needs and no model jargon', async () => {
		const t = async (type: string) => (await tool('get_opportunities', { site: '1', type })).data;
		expect((await t('lost_queries')).rows[0]).toEqual({ query: 'lost topic', clicksBefore: 40, clicksNow: 2, lostClicks: 38, positionBefore: 3, positionNow: 14 });
		expect((await t('rising_queries')).rows.map((r: { query: string }) => r.query)).toEqual(['rising topic', 'rising two']);
		expect((await t('rising_queries')).rows[0]).toMatchObject({ query: 'rising topic', impressions: 120, impressionsBefore: 20, isNew: false });
		expect((await t('pages_on_the_edge')).rows).toHaveLength(3);
		expect((await t('pages_on_the_edge')).rows[0]).toMatchObject({ searchesNearTheTop: 5, impressions: 480 });
		expect((await t('question_gaps')).rows[0]).toMatchObject({ query: 'how to fix plant topic', impressions: 200 });
		expect((await t('bing_gaps')).rows[0]).toMatchObject({ query: 'bing only topic', bingPosition: 2, googlePosition: 18 });
		expect((await t('not_in_bing')).rows.map((r: { page: string }) => new URL(r.page).pathname)).toContain('/gone-from-bing');
		expect((await t('hidden_gems')).rows[0]).toMatchObject({ page: '/gem', organicSessions: 100, engagementRate: '80%', position: 9 });
		expect((await t('engagement_leaks')).rows[0]).toMatchObject({ page: '/leaky', organicSessions: 250, engagementRate: '20%' });
		expect((await t('conversion_leaks')).rows[0]).toMatchObject({ page: '/leaky', keyEvents: 0 });
		expect((await t('friction')).rows[0]).toMatchObject({ page: '/friction', sessionsWithRageOrDeadClicks: 12, share: '12%' });
		expect((await t('mobile_gaps')).rows[0]).toMatchObject({ query: 'phone topic', phonePosition: 14, desktopPosition: 5 });
	});
	it('when a source is missing the tool says how to fix it, in words', async () => {
		db().prepare('DELETE FROM bing_terms WHERE site_id = 1').run();
		const r = await tool('get_opportunities', { site: '1', type: 'hidden_overview' });
		expect(r.data.sources.bing).toBe('Connected but no data stored for this window yet.');
		db().prepare('UPDATE sites SET backfill_done = 0, backfilled_to = NULL WHERE id = 1').run();
		const r2 = await tool('get_opportunities', { site: '1', type: 'lost_queries' });
		expect(r2.data.sources.previousPeriod).toContain('previous period is not downloaded yet');
		expect(r2.data.rows).toEqual([]); // no change is claimed without a previous period
		expect((await tool('get_opportunities', { site: '1', type: 'rising_queries' })).data.rows).toEqual([]); // nor that a search is rising
	});
	it('an unknown type lists the valid ones', async () => {
		const r = await tool('get_opportunities', { site: '1', type: 'nope' });
		expect(r.isError).toBe(true);
		expect(r.data).toContain('hidden_overview');
		expect(r.data).toContain('mobile_gaps');
	});
});
