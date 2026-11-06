import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { getSite } from '../src/lib/server/clients';
import { createTest, deleteTest, evaluateTest, evaluateTestCached, listTests, suggestControlMatched, warmTests } from '../src/lib/server/seotests';
import { addWatch, indexHistory, indexSummary, monitorSite, removeWatch, watchList } from '../src/lib/server/indexmon';
import { monitorDue } from '../src/lib/server/jobs';
import { GoogleApiError, type GscClient } from '../src/lib/server/google';
import { liftTestCalibrated, matchSections, parseScope, placebosFrom } from '../src/lib/experiments';
import { pacificToday } from '../src/lib/server/dates';

// ── seeded randomness ────────────────────────────────────────────────────────
const rng = (seed: number) => {
	let s = seed;
	const rnd = () => ((s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296);
	const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
	const pois = (lam: number) => { if (lam > 50) return Math.max(0, Math.round(lam + Math.sqrt(lam) * gauss())); const l = Math.exp(-lam); let p = 1, n = 0; do { n++; p *= rnd(); } while (p > l); return n - 1; };
	const ar = (len: number, rho: number, sd: number) => { let x = 0; return Array.from({ length: len }, () => (x = rho * x + Math.sqrt(1 - rho * rho) * sd * gauss())); };
	return { rnd, gauss, pois, ar };
};
const dates = (from: string, to: string) => { const o: string[] = []; for (let d = new Date(from + 'T00:00:00Z'); d <= new Date(to + 'T00:00:00Z'); d = new Date(d.getTime() + 86400000)) o.push(d.toISOString().slice(0, 10)); return o; };

// ── 1. evaluation cache ──────────────────────────────────────────────────────
describe('test result cache', () => {
	const START = '2026-06-01';
	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const { pois } = rng(5);
		const d = db();
		d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
		const ins = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','MOBILE',?,?,5)");
		d.transaction(() => { for (const day of dates('2025-12-01', '2026-06-30')) { for (let i = 0; i < 5; i++) ins.run(day, `q t${i}`, `https://x.example/t/${i}`, pois(8), 160); for (let i = 0; i < 20; i++) ins.run(day, `q c${i}`, `https://x.example/c/${i}`, pois(10), 200); } })();
		d.prepare('UPDATE sites SET synced_through = ?, backfill_done = 1, last_sync_at = 1000 WHERE id = 1').run('2026-06-30');
		createTest(1, { name: 't', kind: 'before_after', startDate: START, treatment: parseScope('/t/') });
	});
	it('stores the outcome, reuses it, and recomputes only when the data or algorithm changes', () => {
		const t = listTests(1)[0];
		const first = evaluateTestCached(getSite(1)!, t);
		expect(first.clicks.calibration.placebos).toBe(4);
		const row = () => db().prepare('SELECT outcome, computed_at, cache_key FROM seo_test_results WHERE test_id = ?').get(t.id) as { outcome: string; computed_at: number; cache_key: string };
		expect(JSON.parse(row().outcome)).toEqual(first);
		// prove a hit really skips the computation: tamper with the stored answer and see it come back
		db().prepare("UPDATE seo_test_results SET outcome = ? WHERE test_id = ?").run(JSON.stringify({ ...first, treatmentPages: 999 }), t.id);
		expect(evaluateTestCached(getSite(1)!, t).treatmentPages).toBe(999);
		// a sync moves last_sync_at: the stored answer is stale and is recomputed
		db().prepare('UPDATE sites SET last_sync_at = 2000 WHERE id = 1').run();
		expect(evaluateTestCached(getSite(1)!, t).treatmentPages).toBe(5);
		// so does newly stored data
		db().prepare("UPDATE seo_test_results SET outcome = ? WHERE test_id = ?").run(JSON.stringify({ ...first, treatmentPages: 999 }), t.id);
		db().prepare("UPDATE sites SET synced_through = '2026-06-29' WHERE id = 1").run();
		expect(evaluateTestCached(getSite(1)!, t).treatmentPages).toBe(5);
		expect(evaluateTestCached(getSite(1)!, t)).toEqual(evaluateTest(getSite(1)!, t));
	});
	it('warming computes every test and skips one that cannot be evaluated', () => {
		createTest(1, { name: 'second', kind: 'before_after', startDate: '2026-05-01', treatment: parseScope('/t/') });
		db().prepare("INSERT INTO seo_tests (site_id,name,kind,start_date,window_days,treatment,control,meta,created_at) VALUES (1,'corrupt','before_after','9999-99-99',28,'{\"prefixes\":[\"/t/\"],\"urls\":[]}','{\"restOfSite\":true}','{}',1)").run();
		expect(warmTests(1)).toBe(2);
		expect((db().prepare('SELECT COUNT(*) n FROM seo_test_results').get() as { n: number }).n).toBe(2); // failures are never stored
		expect(warmTests(999)).toBe(0);
	});
	it('deleting a test removes its stored result', () => {
		const t = listTests(1)[0];
		evaluateTestCached(getSite(1)!, t);
		deleteTest(1, t.id);
		expect((db().prepare('SELECT COUNT(*) n FROM seo_test_results').get() as { n: number }).n).toBe(0);
	});
});

// ── 2. control matching ──────────────────────────────────────────────────────
describe('matching control pages to the test pages', () => {
	it('ranks sections by co-movement and refuses weak or thin matches', () => {
		const t = [10, 12, 15, 14, 18, 20, 19, 25, 30, 28];
		const sections = [
			{ key: '/tracks/', weekly: t.map((x) => x * 3 + 2), clicks: 500 },
			{ key: '/opposite/', weekly: t.map((x) => 100 - x), clicks: 800 },
			{ key: '/flat/', weekly: t.map(() => 50), clicks: 900 },
			{ key: '/short/', weekly: [1, 2, 3], clicks: 900 }
		];
		const m = matchSections(t, sections, { volume: 300 });
		expect(m.map((x) => x.key)).toEqual(['/tracks/']);
		expect(m[0].correlation).toBeGreaterThan(0.99);
		expect(matchSections(t, sections, { volume: 100_000 })).toEqual([]); // nothing that tracks has enough volume: no pretending
		expect(matchSections(t.slice(0, 5), sections, { volume: 300 })).toEqual([]); // under 8 weeks of history
	});

	function load(postShock = 1) {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		return ensureDemoAccounts().then(() => {
			const { pois, ar } = rng(11);
			const L = dates('2025-10-01', '2026-06-30');
			const common = ar(L.length, 0.95, 0.08);
			const lvl = { guides: ar(L.length, 0.95, 0.3), blog: ar(L.length, 0.95, 0.3), shop: ar(L.length, 0.95, 0.3) };
			const d = db();
			d.prepare('DELETE FROM sa_rows WHERE site_id = 1').run();
			const ins = d.prepare("INSERT OR REPLACE INTO sa_rows VALUES (1,?,?,?,'usa','MOBILE',?,?,5)");
			d.transaction(() => {
				L.forEach((day, t) => {
					for (const sec of ['guides', 'blog', 'shop'] as const) for (let i = 0; i < 20; i++) {
						const shock = day >= '2026-06-01' ? postShock : 1;
						ins.run(day, `q ${sec}${i}`, `https://x.example/${sec}/p${i}`, pois(9 * Math.exp(common[t] + lvl[sec][t]) * shock * (sec === 'blog' ? 3 : 1)), 150);
					}
				});
			})();
			d.prepare("UPDATE sites SET synced_through = '2026-06-30', backfill_done = 1 WHERE id = 1").run();
			return getSite(1)!;
		});
	}
	const treat = { prefixes: [], urls: Array.from({ length: 10 }, (_, i) => `https://x.example/guides/p${i}`) };

	it('picks the untouched pages of the section that moved with the test pages, not unrelated sections', async () => {
		const site = await load();
		const s = suggestControlMatched(site, treat, '2026-06-01');
		expect(s.method).toBe('sections');
		expect(s.sections[0].key).toBe('/guides/');
		expect(s.sections[0].correlation).toBeGreaterThan(0.6);
		expect(s.urls.length).toBeGreaterThan(0);
		expect(s.urls.every((u) => u.includes('/guides/'))).toBe(true);
		expect(s.urls.some((u) => treat.urls.includes(u))).toBe(false); // never the test pages themselves
		expect(s.note).toMatch(/\/guides\/.*r = 0\.\d\d/);
		expect(s.note).not.toMatch(/weak match/); // a strong match carries no caveat
	});
	it('reads only data from before the change, so the result cannot influence the choice', async () => {
		const before = suggestControlMatched(await load(1), treat, '2026-06-01');
		const after = suggestControlMatched(await load(5), treat, '2026-06-01'); // post-change traffic multiplied 5x everywhere
		expect(after.urls).toEqual(before.urls);
		expect(after.sections).toEqual(before.sections);
	});
	it('falls back to traffic matching, then to nothing, when history is too short or there are no candidates', async () => {
		const site = await load();
		expect(suggestControlMatched(site, treat, '2025-10-20').method).toBe('traffic'); // under 8 weeks before the change
		expect(suggestControlMatched(site, { prefixes: ['/'], urls: [] }, '2026-06-01')).toMatchObject({ method: 'none', urls: [] }); // the test covers every page
		expect(suggestControlMatched(site, { prefixes: [], urls: [] }, '2026-06-01').method).toBe('none');
	});
	it('on drifting traffic the matched control detects real changes far more often than the whole site (the point of it)', () => {
		const { pois, gauss, ar } = rng(2024);
		const n = 28, S = 6 * n, L = S + n, PER = 20, SECTIONS = 8;
		let rest = 0, matched = 0, noChangeMatched = 0;
		const N = 110;
		for (let trial = 0; trial < N; trial++) {
			const common = ar(L, 0.95, 0.1);
			const sec = Array.from({ length: SECTIONS }, () => ar(L, 0.95, 0.25));
			const pages = Array.from({ length: SECTIONS * PER }, (_, i) => { const s = Math.floor(i / PER); return { s, mean: Math.exp(1.2 + 0.9 * gauss()), level: Array.from({ length: L }, (_, t) => Math.exp(common[t] + sec[s][t])), i }; });
			for (const eff of [1.5, 1]) {
				const treatP = pages.filter((p) => p.s === 0 && p.i % 2 === 0), restP = pages.filter((p) => !(p.s === 0 && p.i % 2 === 0));
				const sum = (xs: number[][]) => Array.from({ length: L }, (_, t) => xs.reduce((a, x) => a + x[t], 0));
				const T = sum(treatP.map((p) => Array.from({ length: L }, (_, t) => pois(p.mean * p.level[t] * (t >= S && eff !== 1 ? eff : 1)))));
				const draws = restP.map((p) => ({ p, d: Array.from({ length: L }, (_, t) => pois(p.mean * p.level[t])) }));
				const cRest = sum(draws.map((x) => x.d));
				const weeks = Math.floor(S / 7);
				const weekly = (xs: number[]) => Array.from({ length: weeks }, (_, k) => xs.slice(S - 7 * (weeks - k), S - 7 * (weeks - k - 1)).reduce((a, b) => a + b, 0));
				const bySec = new Map<string, number[][]>();
				draws.forEach((x) => bySec.set('s' + x.p.s, [...(bySec.get('s' + x.p.s) ?? []), x.d]));
				const series = [...bySec].map(([key, xs]) => ({ key, weekly: weekly(sum(xs)), clicks: sum(xs).slice(0, S).reduce((a, b) => a + b, 0) }));
				const m = matchSections(weekly(T), series, { volume: T.slice(0, S).reduce((a, b) => a + b, 0) }); // the production rule: ~1x the test volume, within 0.1
				const cMatch = m.length ? sum(m.flatMap((x) => bySec.get(x.key)!)) : cRest;
				const call = (C: number[]) => liftTestCalibrated({ pre: T.slice(S - n, S), post: T.slice(S) }, { pre: C.slice(S - n, S), post: C.slice(S) }, placebosFrom(T, C, S, n, n)).verdict;
				const v = (x: string) => x === 'positive' || x === 'negative';
				if (eff === 1.5) { if (v(call(cRest))) rest++; if (v(call(cMatch))) matched++; } else if (v(call(cMatch))) noChangeMatched++;
			}
		}
		expect(matched / N).toBeGreaterThan(rest / N + 0.25); // measured about 0.90 vs 0.23 over 220 trials
		expect(noChangeMatched / N).toBeLessThan(0.1); // while still not crying wolf (0-1.4% measured)
	}, 120_000);
});

describe('smallest detectable change', () => {
	const { pois, ar } = rng(77);
	const sim = (rho: number, sd: number) => { const S = 5 * 28; const t = Array.from({ length: S + 28 }, () => 0), c = [...t]; const lt = ar(S + 28, rho, sd), lc = ar(S + 28, rho, sd); for (let i = 0; i < S + 28; i++) { t[i] = pois(40 * Math.exp(lt[i])); c[i] = pois(400 * Math.exp(lc[i])); } return liftTestCalibrated({ pre: t.slice(S - 28, S), post: t.slice(S) }, { pre: c.slice(S - 28, S), post: c.slice(S) }, placebosFrom(t, c, S, 28, 28)); };
	it('is reported, grows with drift, and a test that cannot see a 30% change says so', () => {
		const steady = sim(0, 0), drifty = sim(0.97, 0.25);
		expect(steady.calibration.detectable).not.toBeNull();
		expect(steady.calibration.detectable!).toBeLessThan(0.35);
		expect(drifty.calibration.detectable!).toBeGreaterThan(steady.calibration.detectable!);
		// consistency: a change at least as big as the detectable size is what the interval excludes zero for
		expect(drifty.ciHigh! - drifty.ciLow!).toBeGreaterThan(steady.ciHigh! - steady.ciLow!);
	});
	it('is absent when there is no calibration', () => {
		const r = liftTestCalibrated({ pre: Array(28).fill(10), post: Array(28).fill(10) }, { pre: Array(28).fill(100), post: Array(28).fill(100) }, []);
		expect(r.calibration.detectable).toBeNull();
	});
});

// ── 3. indexing monitor ──────────────────────────────────────────────────────
describe('indexing monitor', () => {
	const stub = (calls: string[], behave: (url: string) => string = () => 'PASS'): GscClient =>
		({
			inspectUrl: async (_s: string, url: string) => {
				calls.push(url);
				const b = behave(url);
				if (b === 'QUOTA') throw new GoogleApiError('quota', 429, 'RESOURCE_EXHAUSTED');
				if (b === 'AUTH') throw new GoogleApiError('Request had insufficient authentication scopes.', 403, 'PERMISSION_DENIED');
				if (b === 'BOOM') throw new Error('socket hang up');
				const bad = b === 'NEUTRAL' || b === 'FAIL';
				return { indexStatusResult: { verdict: b, coverageState: b === 'NEUTRAL' ? 'Crawled - currently not indexed' : b === 'FAIL' ? 'Discovered - currently not indexed' : 'Indexed', robotsTxtState: 'ALLOWED', pageFetchState: 'SUCCESSFUL', googleCanonical: bad ? undefined : url } };
			}
		}) as never;
	const state = () => db().prepare('SELECT index_checked_on c, index_message m, index_next_at n FROM sites WHERE id = 1').get() as { c: string | null; m: string | null; n: number | null };

	beforeEach(async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		process.env.DEMO_MODE = '1';
		await ensureDemoAccounts();
		const client = new DemoClient('demo-a');
		let guard = 0;
		await syncSite(1, { client, backfillChunkDays: 120 });
		while (!getSite(1)!.backfill_done && guard++ < 12) await syncSite(1, { client, backfillChunkDays: 120 });
	}, 120_000);

	it('checks the watch list first, then pages new this period, then the rest', async () => {
		const site = getSite(1)!;
		const end = site.synced_through!;
		const NEW = 'https://greenleaf.example/brand-new-page';
		db().prepare("INSERT INTO sa_rows VALUES (1,?,'a new query',?, 'usa','MOBILE',3,300,6)").run(end, NEW);
		const PIN = 'https://greenleaf.example/money-page-with-no-clicks';
		addWatch(1, [PIN]);
		const calls: string[] = [];
		const r = await monitorSite(1, { client: stub(calls), limit: 3 });
		expect(calls).toHaveLength(3);
		expect(calls[0]).toBe(PIN); // the pinned page is first even though Search Console has never shown it
		expect(calls[1]).toBe(NEW); // a page that appeared this period is next
		expect(r.candidates).toMatchObject({ pinned: 1, new: 1 });
		expect(r.candidates.top).toBe(1);
		removeWatch(1, PIN);
		expect(watchList(1)).toEqual([]);
	});

	it('priority beats age: a long-unchecked top page does not jump ahead of a pinned or new page that was checked more recently', async () => {
		const site = getSite(1)!;
		const NEW = 'https://greenleaf.example/brand-new-page';
		const PIN = 'https://greenleaf.example/money-page';
		db().prepare("INSERT INTO sa_rows VALUES (1,?,'a new query',?, 'usa','MOBILE',3,300,6)").run(site.synced_through!, NEW);
		addWatch(1, [PIN]);
		await monitorSite(1, { client: stub([]), limit: 500 }); // everything has now been seen once
		const H = 3600_000, now = Date.now();
		const set = db().prepare('UPDATE url_inspections SET fetched_at = ? WHERE site_id = 1 AND url = ?');
		db().prepare('UPDATE url_inspections SET fetched_at = ? WHERE site_id = 1').run(now - 400 * H); // all stale, top pages the stalest
		set.run(now - 21 * H, PIN); // pinned: checked most recently of all, but still past the 20 h cache
		set.run(now - 22 * H, NEW);
		const calls: string[] = [];
		await monitorSite(1, { client: stub(calls), limit: 2 });
		expect(calls).toEqual([PIN, NEW]); // by age alone these two would come last
	});

	it('a finished run clears the message and back-off, and records the indexed share for the trend', async () => {
		const r = await monitorSite(1, { client: stub([], (u) => (u.endsWith('garden-tools-1') ? 'NEUTRAL' : 'PASS')), limit: 200 });
		expect(r.outcome).toBe('done');
		expect(state()).toEqual({ c: pacificToday(), m: null, n: null });
		const h = indexHistory(1);
		expect(h).toHaveLength(1);
		expect(h[0].indexed + h[0].notIndexed).toBe(r.checked);
		expect(h[0].notIndexed).toBe(1);
		const s = indexSummary(1);
		expect(s.reasons).toEqual([{ reason: 'Crawled - currently not indexed', count: 1 }]);
		expect(s.indexedShare).toBeCloseTo((r.checked - 1) / r.checked, 6);
	});

	it('quota: tomorrow, no back-off. Refusal: retry in ~6 h with the reason. Total failure: retry in ~2 h. Never "done for today" unless it was', async () => {
		const q = await monitorSite(1, { client: stub([], () => 'QUOTA'), limit: 50 });
		expect(q.outcome).toBe('quota');
		expect(state().c).toBe(pacificToday()); // the quota resets daily: nothing to gain by retrying now
		expect(state().n).toBeNull();
		expect(state().m).toMatch(/quota.*tomorrow/i);

		const t0 = Date.now();
		const a = await monitorSite(1, { client: stub([], () => 'AUTH'), limit: 50, force: true });
		expect(a.outcome).toBe('auth');
		expect(state().c).toBeNull(); // not marked as done
		expect(state().n!).toBeGreaterThan(t0 + 5.5 * 3600_000);
		expect(state().n!).toBeLessThan(t0 + 6.5 * 3600_000);
		expect(state().m).toMatch(/Reconnect the Google account/);
		expect(state().m).toMatch(/insufficient authentication scopes/);

		const f = await monitorSite(1, { client: stub([], () => 'BOOM'), limit: 50, force: true });
		expect(f.outcome).toBe('failed');
		expect(state().c).toBeNull();
		expect(state().n!).toBeGreaterThan(t0 + 1.5 * 3600_000);
		expect(state().n!).toBeLessThan(t0 + 2.5 * 3600_000);
		expect(state().m).toMatch(/socket hang up/);

		await monitorSite(1, { client: stub([]), limit: 50, force: true });
		expect(state()).toEqual({ c: pacificToday(), m: null, n: null }); // a later success clears all of it
	});

	it('the scheduler honours the back-off', () => {
		const now = 1_000_000;
		const today = '2026-11-06';
		expect(monitorDue({ m: 1, c: null, n: null }, today, now)).toBe(true);
		expect(monitorDue({ m: 1, c: today, n: null }, today, now)).toBe(false); // done today
		expect(monitorDue({ m: 1, c: null, n: now + 1 }, today, now)).toBe(false); // backing off
		expect(monitorDue({ m: 1, c: null, n: now - 1 }, today, now)).toBe(true); // back-off over
		expect(monitorDue({ m: 0, c: null, n: null }, today, now)).toBe(false); // switched off
		expect(monitorDue({ m: 1, c: '2026-11-05', n: null }, today, now)).toBe(true); // yesterday's run does not count
	});
});
