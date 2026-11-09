import { beforeAll, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { pageTotals, periodFor } from '../src/lib/server/queries';
import { buildActions } from '../src/lib/server/actions';
import { ERROR_STREAK, robotsChanges, robotsCheckDue, robotsHosts, robotsReport, runRobotsCheck, ROBOTS_RECHECK_MS } from '../src/lib/server/robotswatch';
import { diffRobots, isAllowed, parseRobots, patternMatches, robotsFingerprint, robotsState, rulesFor } from '../src/lib/robots';

describe('robots.txt parsing and matching', () => {
	it('Googlebot obeys its own group, merged across groups, and only falls back to *', () => {
		const p = parseRobots('User-agent: *\nDisallow: /private\n\nUser-agent: Googlebot\nDisallow: /a\n\nuser-agent: googlebot\nDisallow: /b\n');
		const g = rulesFor(p);
		expect(g.group).toBe('googlebot');
		expect(g.rules.map((r) => r.pattern).sort()).toEqual(['/a', '/b']);
		expect(isAllowed(g.rules, '/private/x').allowed).toBe(true); // the * group does not apply to Googlebot here
		expect(rulesFor(p, 'bingbot').group).toBe('*');
	});
	it('consecutive user-agent lines share one group; a rule ends the run', () => {
		const p = parseRobots('User-agent: a\nUser-agent: b\nDisallow: /x\nUser-agent: c\nDisallow: /y');
		expect(p.groups.map((g) => g.agents)).toEqual([['a', 'b'], ['c']]);
	});
	it('the longest match wins, allow wins a tie, and an empty disallow blocks nothing', () => {
		const rules = rulesFor(parseRobots('User-agent: *\nDisallow: /shop\nAllow: /shop/help\nDisallow: /tie\nAllow: /tie\nDisallow:\n')).rules;
		expect(isAllowed(rules, 'https://x.com/shop/cart')).toEqual({ allowed: false, rule: 'Disallow: /shop' });
		expect(isAllowed(rules, 'https://x.com/shop/help/faq').allowed).toBe(true);
		expect(isAllowed(rules, '/tie').allowed).toBe(true);
		expect(isAllowed(rules, '/other').allowed).toBe(true);
		expect(isAllowed(rulesFor(parseRobots('User-agent: *\nDisallow: /')).rules, '/robots.txt').allowed).toBe(true);
	});
	it('wildcards, end anchors, query strings and percent-encoding', () => {
		expect(patternMatches('/*.pdf$', '/files/a.pdf')).toBe(true);
		expect(patternMatches('/*.pdf$', '/files/a.pdf?x=1')).toBe(false);
		expect(patternMatches('/*?sort=', '/list?sort=asc')).toBe(true);
		expect(patternMatches('/caf%C3%A9', '/café')).toBe(true);
		expect(patternMatches('/a.b', '/axb')).toBe(false); // dots are literal
		const rules = rulesFor(parseRobots('User-agent: *\nDisallow: /*?sort=')).rules;
		expect(isAllowed(rules, 'https://x.com/list?sort=asc').allowed).toBe(false);
		expect(isAllowed(rules, 'https://x.com/list').allowed).toBe(true);
	});
	it('a disallow-all for one other crawler does not touch Googlebot', () => {
		const rules = rulesFor(parseRobots('User-agent: BadBot\nDisallow: /\n\nUser-agent: *\nDisallow: /cart/')).rules;
		expect(isAllowed(rules, '/blog/post').allowed).toBe(true);
	});
	it('comments, blank lines, case and group order do not count as a change; a real rule does', () => {
		const a = parseRobots('# v1\nUser-agent: *\nDisallow: /a\n\nUser-agent: x\nDisallow: /\nSitemap: https://x.com/s.xml');
		const b = parseRobots('user-agent: x\ndisallow: /   # bots\n\n\nUSER-AGENT: *\nDISALLOW: /a\nsitemap: https://x.com/s.xml');
		expect(robotsFingerprint('ok', a)).toBe(robotsFingerprint('ok', b));
		const c = parseRobots('User-agent: *\nDisallow: /a\nDisallow: /blog/\n\nUser-agent: x\nDisallow: /');
		expect(robotsFingerprint('ok', a)).not.toBe(robotsFingerprint('ok', c));
		expect(diffRobots(a, c)).toEqual({ added: ['user-agent * · Disallow: /blog/'], removed: ['Sitemap: https://x.com/s.xml'] });
	});
	it('status codes: 4xx is "no file", 429 and 5xx and no answer are errors', () => {
		expect(robotsState(200, true)).toBe('ok');
		expect(robotsState(404, false)).toBe('missing');
		expect(robotsState(410, false)).toBe('missing');
		expect(robotsState(429, false)).toBe('error');
		expect(robotsState(503, false)).toBe('error');
		expect(robotsState(0, false)).toBe('error');
	});
});

// ── the daily watch, against the demo site and a fake host ───────────────────
const site = () => getSite(1)!;
let topPath = '';
let origin = '';
let file = { status: 200, body: '' };
const fake = (async (input: RequestInfo | URL) => {
	const u = new URL(String(input));
	if (u.pathname !== '/robots.txt') return new Response('nope', { status: 404 });
	return file.status === 0 ? Promise.reject(new Error('connect ECONNREFUSED')) : new Response(file.body, { status: file.status, headers: { 'content-type': 'text/plain' } });
}) as typeof fetch;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	const client = new DemoClient('demo-a');
	let guard = 0;
	await syncSite(1, { client, backfillChunkDays: 120 });
	while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	const p = periodFor(site(), 28);
	const top = pageTotals(1, p.start, p.end, 1)[0];
	const u = new URL(top.page);
	topPath = u.pathname;
	origin = u.origin;
}, 180_000);

describe('robots.txt watch', () => {
	it('the demo file is read and blocks nothing that earns clicks', async () => {
		const hosts = await runRobotsCheck(1);
		expect(hosts.length).toBeGreaterThan(0);
		expect(hosts.every((h) => h.state === 'ok' && h.group === '*')).toBe(true);
		expect(robotsReport(site()).blocked).toEqual([]);
		expect(buildActions(site()).filter((a) => a.type === 'robots')).toEqual([]);
		expect(robotsCheckDue(1)).toBe(false);
		expect(robotsCheckDue(1, Date.now() + ROBOTS_RECHECK_MS + 1000)).toBe(true);
	});

	it('a new rule that blocks the biggest page is recorded as a change and raised as a blocking item naming the rule', async () => {
		file = { status: 200, body: 'User-agent: *\nDisallow: /cart/\n' };
		await runRobotsCheck(1, { fetchImpl: fake });
		file = { status: 200, body: `# edited\nUser-agent: *\nDisallow: /cart/\nDisallow: ${topPath}\n` };
		await runRobotsCheck(1, { fetchImpl: fake });
		const ch = robotsChanges(1).find((c) => c.origin === origin)!;
		expect(ch.added).toEqual([`user-agent * · Disallow: ${topPath}`]);
		expect(ch.removed).toEqual([]);
		expect(ch.beforeBody).toContain('Disallow: /cart/');
		const items = buildActions(site()).filter((a) => a.type === 'robots');
		const block = items.find((a) => a.key.startsWith('robots:'))!;
		expect(block.blocking).toBe(true);
		expect(block.impact).toBeGreaterThan(0);
		expect(block.evidence[0]).toContain(`Disallow: ${topPath}`);
		expect(items.some((a) => a.key === `robots-changed:${ch.id}` && !a.blocking)).toBe(true);
		// The same page is not counted a second time by the inspection-based "blocked" item.
		expect(buildActions(site()).filter((a) => a.type === 'blocked').every((a) => !a.evidence.some((e) => e.startsWith(topPath + ' ')))).toBe(true);
	});

	it('a comment-only edit is not a change', async () => {
		const before = robotsChanges(1).length;
		file = { status: 200, body: `User-agent: *\nDisallow: /cart/   # cart\nDisallow: ${topPath}\n` };
		await runRobotsCheck(1, { fetchImpl: fake });
		expect(robotsChanges(1).length).toBe(before);
	});

	it('server errors keep the last good copy, are blocking only after a streak, and a change made meanwhile is still caught', async () => {
		file = { status: 503, body: '' };
		await runRobotsCheck(1, { fetchImpl: fake });
		let h = robotsHosts(1).find((x) => x.origin === origin)!;
		expect(h.state).toBe('error');
		expect(h.failStreak).toBe(1);
		expect(h.body).toContain(topPath); // last good copy kept, and still judged
		expect(buildActions(site()).some((a) => a.key === `robots-error:${origin}`)).toBe(false);
		for (let i = 1; i < ERROR_STREAK; i++) await runRobotsCheck(1, { fetchImpl: fake });
		expect(buildActions(site()).find((a) => a.key === `robots-error:${origin}`)?.blocking).toBe(true);
		const before = robotsChanges(1).length;
		file = { status: 200, body: 'User-agent: *\nDisallow: /cart/\n' };
		await runRobotsCheck(1, { fetchImpl: fake });
		h = robotsHosts(1).find((x) => x.origin === origin)!;
		expect(h.failStreak).toBe(0);
		expect(robotsChanges(1).length).toBe(before + 1);
		expect(robotsChanges(1)[0].removed).toEqual([`user-agent * · Disallow: ${topPath}`]);
		expect(buildActions(site()).some((a) => a.key.startsWith('robots:') || a.key.startsWith('robots-error:'))).toBe(false);
	});

	it('a file that disappears (404) is a change to "missing" and blocks nothing', async () => {
		file = { status: 404, body: '' };
		await runRobotsCheck(1, { fetchImpl: fake });
		const ch = robotsChanges(1)[0];
		expect(ch.afterState).toBe('missing');
		expect(ch.removed).toContain('user-agent * · Disallow: /cart/');
		expect(robotsReport(site()).blocked).toEqual([]);
	});
});
