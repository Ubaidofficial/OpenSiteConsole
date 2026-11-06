import { db } from './db';
import type { SiteRow } from './clients';
import { addDays, daysBetween, eachDay } from './dates';
import { siteEnd } from './queries';
import { urlSection, spansHosts } from '../groups';
import { emptyScope, indexSeries, isEmptyScope, liftTestCalibrated, matchSections, pickControl, placebosFrom, scopeMatcher, type LiftResult, type Scope } from '../experiments';

/** YYYY-MM-DD that is an actual calendar day (rejects 2026-02-31 and 9999-99-99, which a hand-made request could send). */
export const isRealDate = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

export type TestKind = 'before_after' | 'split' | 'switch';
export interface SeoTest {
	id: number;
	site_id: number;
	name: string;
	kind: TestKind;
	start_date: string;
	window_days: number;
	treatment: Scope;
	control: Scope | { restOfSite: true };
	meta: { old?: Scope; new?: Scope; controlNote?: string; controlMethod?: 'sections' | 'traffic' | 'rest' | 'named' };
	note: string | null;
	created_at: number;
}

interface Raw { id: number; site_id: number; name: string; kind: TestKind; start_date: string; window_days: number; treatment: string; control: string; meta: string; note: string | null; created_at: number }
const hydrate = (r: Raw): SeoTest => ({ ...r, treatment: JSON.parse(r.treatment), control: JSON.parse(r.control), meta: JSON.parse(r.meta) });
const isRest = (c: SeoTest['control']): c is { restOfSite: true } => 'restOfSite' in c;

export const listTests = (siteId: number): SeoTest[] => (db().prepare('SELECT * FROM seo_tests WHERE site_id = ? ORDER BY start_date DESC, id DESC').all(siteId) as Raw[]).map(hydrate);
export const deleteTest = (siteId: number, id: number) => void db().prepare('DELETE FROM seo_tests WHERE id = ? AND site_id = ?').run(id, siteId);

export interface NewTest {
	name: string;
	kind: TestKind;
	startDate: string;
	windowDays?: number;
	treatment: Scope;
	/** split only: the control pages. Omitted = the rest of the site (before/after and switch always use that). */
	control?: Scope;
	/** how the control was chosen, shown on the test */
	controlNote?: string;
	controlMethod?: 'sections' | 'traffic' | 'rest' | 'named';
	/** switch only */
	old?: Scope;
	new?: Scope;
	note?: string;
}

export function createTest(siteId: number, t: NewTest): number {
	const name = t.name.trim().slice(0, 120);
	if (!name) throw new Error('Give the test a name.');
	if (!isRealDate(t.startDate)) throw new Error('Enter the date the change went live as a real date (YYYY-MM-DD).');
	const windowDays = Math.min(90, Math.max(7, Math.round(t.windowDays ?? 28)));
	let treatment = t.treatment;
	const meta: SeoTest['meta'] = { controlNote: t.controlNote, controlMethod: t.controlMethod };
	if (t.kind === 'switch') {
		if (!t.old || isEmptyScope(t.old) || !t.new || isEmptyScope(t.new)) throw new Error('A redirect test needs the old URLs and the new URLs.');
		// Old and new are measured together: traffic that moves from one to the other must not count as a loss.
		treatment = { prefixes: [...t.old.prefixes, ...t.new.prefixes], urls: [...t.old.urls, ...t.new.urls] };
		meta.old = t.old;
		meta.new = t.new;
	}
	if (isEmptyScope(treatment)) throw new Error('Say which pages the change affects: a path such as /blog/ or a list of URLs.');
	const control = t.control && !isEmptyScope(t.control) ? t.control : { restOfSite: true };
	return Number(
		db()
			.prepare('INSERT INTO seo_tests (site_id, name, kind, start_date, window_days, treatment, control, meta, note, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
			.run(siteId, name, t.kind, t.startDate, windowDays, JSON.stringify(treatment), JSON.stringify(control), JSON.stringify(meta), t.note?.slice(0, 1000) || null, Date.now()).lastInsertRowid
	);
}

interface DayPage { date: string; page: string; clicks: number; impressions: number; pw: number }

export interface TestOutcome {
	preDays: number;
	postDays: number;
	preRange: [string, string];
	postRange: [string, string] | null;
	clicks: LiftResult;
	impressions: LiftResult;
	treatmentPages: number;
	controlPages: number;
	position: { before: number; after: number } | null;
	/** switch tests: old and new URL clicks before and after */
	parts: { oldPre: number; oldPost: number; newPre: number; newPost: number } | null;
	/** 100 = the pre-change average, 7-day smoothed */
	series: { date: string; treatment: number; control: number }[];
	startDate: string;
}

/** How many earlier windows (beyond the real "before" window) are fetched to calibrate noise. */
const PLACEBO_MAX = 4;

/** Evaluate one test against the stored data. The change day itself counts as "after". */
export function evaluateTest(site: Pick<SiteRow, 'id' | 'synced_through' | 'backfill_done' | 'backfilled_to'>, test: SeoTest): TestOutcome {
	// Date.UTC overflows silently (9999-99-99 becomes a date in the year 10007), so do not rely on an exception to catch a corrupt row.
	if (!isRealDate(test.start_date)) throw new Error(`This test has an invalid change date (${test.start_date}); delete it and create it again.`);
	const end = siteEnd(site);
	const n = test.window_days;
	const preStart = addDays(test.start_date, -n);
	const preEnd = addDays(test.start_date, -1);
	const postEnd = [addDays(test.start_date, n - 1), end].sort()[0];
	const postDays = Math.max(0, daysBetween(test.start_date, postEnd) + 1);
	// Earlier windows for the noise calibration: only as far back as history is actually stored.
	const firstStored = (db().prepare('SELECT MIN(date) d FROM sa_rows WHERE site_id = ?').get(site.id) as { d: string | null }).d ?? preStart;
	const extStart = addDays(test.start_date, -(PLACEBO_MAX + 1) * n) < firstStored ? firstStored : addDays(test.start_date, -(PLACEBO_MAX + 1) * n);
	const rows = db()
		.prepare('SELECT date, page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) pw FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY date, page')
		.all(site.id, extStart, postDays ? postEnd : preEnd) as DayPage[];
	const inT = scopeMatcher(test.treatment);
	const inCRaw = isRest(test.control) ? null : scopeMatcher(test.control);
	const oldM = test.meta.old ? scopeMatcher(test.meta.old) : null;
	const preDaysList = eachDay(extStart, preEnd);
	const days = [...preDaysList, ...(postDays ? eachDay(test.start_date, postEnd) : [])];
	const S = preDaysList.length; // index of the change day
	const idx = new Map(days.map((d, i) => [d, i]));
	const zero = () => days.map(() => 0);
	const tC = zero(), tI = zero(), cC = zero(), cI = zero();
	const tPages = new Set<string>(), cPages = new Set<string>();
	// Each page is classified once: the same page repeats on every day, and URL parsing per row is the slow part.
	const arm = new Map<string, 0 | 1 | 2>(); // 0 = neither, 1 = test, 2 = control
	const armOf = (page: string) => {
		let a = arm.get(page);
		if (a === undefined) (a = inT(page) ? 1 : !inCRaw || inCRaw(page) ? 2 : 0), arm.set(page, a);
		return a;
	};
	let pwPre = 0, impPre = 0, pwPost = 0, impPost = 0;
	const parts = { oldPre: 0, oldPost: 0, newPre: 0, newPost: 0 };
	for (const r of rows) {
		const i = idx.get(r.date);
		if (i === undefined) continue;
		const a = armOf(r.page);
		if (a === 1) {
			tC[i] += r.clicks; tI[i] += r.impressions; tPages.add(r.page);
			const pre = r.date < test.start_date;
			if (r.date >= preStart) {
				if (pre) (pwPre += r.pw, (impPre += r.impressions)); else (pwPost += r.pw, (impPost += r.impressions));
				if (oldM) parts[oldM(r.page) ? (pre ? 'oldPre' : 'oldPost') : pre ? 'newPre' : 'newPost'] += r.clicks;
			}
		} else if (a === 2) {
			cC[i] += r.clicks; cI[i] += r.impressions; cPages.add(r.page);
		}
	}
	const realPre = (xs: number[]) => xs.slice(S - n, S);
	const realPost = (xs: number[]) => xs.slice(S);
	// The "before" window must be fully downloaded: a half-empty "before" would turn any normal traffic into a huge "lift".
	const preCovered = !!site.backfill_done || (!!site.backfilled_to && site.backfilled_to <= preStart);
	const mk = (t: number[], c: number[]): LiftResult => {
		const r = liftTestCalibrated({ pre: realPre(t), post: realPost(t) }, { pre: realPre(c), post: realPost(c) }, placebosFrom(t, c, S, n, postDays, PLACEBO_MAX));
		if (!preCovered) return { ...r, lift: null, ciLow: null, ciHigh: null, p: null, verdict: 'too-little-data', note: `The history before the change is still downloading (stored back to ${site.backfilled_to ?? 'nothing yet'}), so there is no complete "before" to compare with. Try again when the backfill finishes.` };
		if (r.verdict === 'too-little-data' && cPages.size === 0 && postDays >= 7 && r.totals.tPre >= 30) {
			return { ...r, note: isRest(test.control) ? 'There are no pages outside the test pages to use as a control (the test covers the whole site). Use a split test with named control pages, or narrow the test pages.' : 'None of the control pages had any traffic in the window. Check the control URLs.' };
		}
		return r;
	};
	const shown = days.slice(S - n);
	const series = (xs: number[]) => indexSeries(shown.map((d, i) => ({ date: d, value: xs[S - n + i] })), n);
	const st = series(tC), sc = series(cC);
	return {
		preDays: n,
		postDays,
		preRange: [preStart, preEnd],
		postRange: postDays ? [test.start_date, postEnd] : null,
		clicks: mk(tC, cC),
		impressions: mk(tI, cI),
		treatmentPages: tPages.size,
		controlPages: cPages.size,
		position: postDays && impPre && impPost ? { before: pwPre / impPre, after: pwPost / impPost } : null,
		parts: oldM ? parts : null,
		series: st.map((p, i) => ({ date: p.date, treatment: Math.round(p.value * 10) / 10, control: Math.round(sc[i].value * 10) / 10 })),
		startDate: test.start_date
	};
}

/** Bump when the maths in evaluateTest / experiments.ts changes, so stored results are recomputed. */
const ALGORITHM = 'v4-detectable';

type CacheSite = Pick<SiteRow, 'id' | 'synced_through' | 'backfill_done' | 'backfilled_to' | 'last_sync_at'>;

/**
 * evaluateTest scans up to five windows of daily page data, 0.7-0.9 s on a large site, and every Tests-page view and every
 * MCP call needs every test. A test's outcome only changes when the site's data does, so it is stored and reused until a
 * sync (last_sync_at / synced_through move), the stored history changes, the test is edited, or ALGORITHM is bumped.
 * Failures are never stored. Tests are also computed ahead of time after each sync (warmTests).
 */
export function evaluateTestCached(site: CacheSite, test: SeoTest): TestOutcome {
	const key = JSON.stringify([ALGORITHM, site.synced_through, site.last_sync_at, site.backfill_done, site.backfilled_to, test.start_date, test.window_days, test.treatment, test.control, test.meta]);
	const d = db();
	const hit = d.prepare('SELECT cache_key, outcome FROM seo_test_results WHERE test_id = ?').get(test.id) as { cache_key: string; outcome: string } | undefined;
	if (hit && hit.cache_key === key) return JSON.parse(hit.outcome) as TestOutcome;
	const outcome = evaluateTest(site, test);
	d.prepare('INSERT OR REPLACE INTO seo_test_results (test_id, cache_key, outcome, computed_at) VALUES (?,?,?,?)').run(test.id, key, JSON.stringify(outcome), Date.now());
	return outcome;
}

/** Compute (and store) every test of a site; one that cannot be evaluated is skipped, never thrown. */
export function warmTests(siteId: number): number {
	const site = db().prepare('SELECT id, synced_through, backfill_done, backfilled_to, last_sync_at FROM sites WHERE id = ?').get(siteId) as CacheSite | undefined;
	if (!site) return 0;
	let n = 0;
	for (const t of listTests(siteId)) {
		try {
			evaluateTestCached(site, t);
			n++;
		} catch {
			/* surfaced on the Tests page */
		}
	}
	return n;
}

/** Suggest control pages for a split test: pages outside the treatment with a similar amount of traffic before the change. */
export function suggestControl(site: Pick<SiteRow, 'id' | 'synced_through'>, treatment: Scope, startDate: string, windowDays = 28): string[] {
	if (isEmptyScope(treatment)) return [];
	const rows = db()
		.prepare('SELECT page, SUM(clicks) clicks FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page')
		.all(site.id, addDays(startDate, -windowDays), addDays(startDate, -1)) as { page: string; clicks: number }[];
	return pickControl(rows, scopeMatcher(treatment));
}

export interface ControlSuggestion {
	urls: string[];
	method: 'sections' | 'traffic' | 'none';
	/** plain-language description for the test card */
	note: string;
	sections: { key: string; correlation: number }[];
}

const WEEKS_BACK = 26;

/**
 * The control for a test, chosen the way that gives the test the most power: pages in the sections of the site whose weekly
 * clicks moved with the test pages before the change (see matchSections), excluding the test pages themselves. Falls back to
 * traffic-level matching (similar clicks per page), then to nothing, in which case the caller uses the rest of the site.
 * Only data BEFORE the change is read, so the choice cannot be influenced by how the test turned out.
 */
export function suggestControlMatched(site: Pick<SiteRow, 'id' | 'synced_through'>, treatment: Scope, startDate: string, windowDays = 28): ControlSuggestion {
	const none = (note: string): ControlSuggestion => ({ urls: [], method: 'none', note, sections: [] });
	if (isEmptyScope(treatment)) return none('No test pages given.');
	const d = db();
	const first = (d.prepare('SELECT MIN(date) d FROM sa_rows WHERE site_id = ?').get(site.id) as { d: string | null }).d;
	if (!first) return none('No stored data yet.');
	const weeks = Math.min(WEEKS_BACK, Math.floor(daysBetween(first, startDate) / 7));
	const rows = d
		.prepare('SELECT CAST((julianday(?) - julianday(date) - 1) / 7 AS INTEGER) wk, page, SUM(clicks) clicks FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY wk, page')
		.all(startDate, site.id, addDays(startDate, -7 * Math.max(weeks, 1)), addDays(startDate, -1)) as { wk: number; page: string; clicks: number }[];
	const inT = scopeMatcher(treatment);
	const withHost = spansHosts(rows.map((r) => r.page));
	const treat = new Array(Math.max(weeks, 0)).fill(0);
	const sec = new Map<string, { weekly: number[]; clicks: number; pages: Map<string, number> }>();
	for (const r of rows) {
		const i = weeks - 1 - r.wk; // oldest week first
		if (i < 0 || i >= weeks) continue;
		if (inT(r.page)) { treat[i] += r.clicks; continue; }
		const key = urlSection(r.page, 1, withHost);
		const s = sec.get(key) ?? { weekly: new Array(weeks).fill(0), clicks: 0, pages: new Map() };
		s.weekly[i] += r.clicks; s.clicks += r.clicks; s.pages.set(r.page, (s.pages.get(r.page) ?? 0) + r.clicks);
		sec.set(key, s);
	}
	const treatClicks = treat.reduce((a, b) => a + b, 0);
	if (weeks >= 8 && treatClicks > 0) {
		const match = matchSections(treat, [...sec].map(([key, s]) => ({ key, weekly: s.weekly, clicks: s.clicks })), { volume: treatClicks });
		if (match.length) {
			const pages = match.flatMap((m) => [...sec.get(m.key)!.pages]).sort((a, b) => b[1] - a[1]).slice(0, 2000).map(([p]) => p);
			const list = match.map((m) => `${m.key} (r = ${m.correlation.toFixed(2)})`).join(', ');
			const weak = match[0].correlation < 0.6 ? ' This is a weak match, so the control tracks the test pages only loosely: expect a wider range and read the result with extra caution.' : '';
			return { urls: pages, method: 'sections', sections: match, note: `Control = pages in ${list}: sections whose weekly clicks moved with the test pages over the ${weeks} weeks before the change.${weak}` };
		}
	}
	const urls = suggestControl(site, treatment, startDate, windowDays);
	return urls.length ? { urls, method: 'traffic', sections: [], note: `Control = ${urls.length} pages with a similar amount of traffic before the change. No section of the site tracked the test pages closely enough (or there are fewer than 8 weeks of history) to match on.` } : none('No suitable control pages were found.');
}

export { emptyScope };
