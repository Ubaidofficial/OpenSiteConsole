import { db } from './db';
import type { SiteRow } from './clients';
import { addDays, daysBetween, eachDay } from './dates';
import { siteEnd } from './queries';
import { emptyScope, indexSeries, isEmptyScope, liftTest, pickControl, scopeMatcher, type LiftResult, type Scope } from '../experiments';

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
	meta: { old?: Scope; new?: Scope };
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
	/** switch only */
	old?: Scope;
	new?: Scope;
	note?: string;
}

export function createTest(siteId: number, t: NewTest): number {
	const name = t.name.trim().slice(0, 120);
	if (!name) throw new Error('Give the test a name.');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(t.startDate)) throw new Error('Enter the date the change went live (YYYY-MM-DD).');
	const windowDays = Math.min(90, Math.max(7, Math.round(t.windowDays ?? 28)));
	let treatment = t.treatment;
	const meta: SeoTest['meta'] = {};
	if (t.kind === 'switch') {
		if (!t.old || isEmptyScope(t.old) || !t.new || isEmptyScope(t.new)) throw new Error('A redirect test needs the old URLs and the new URLs.');
		// Old and new are measured together: traffic that moves from one to the other must not count as a loss.
		treatment = { prefixes: [...t.old.prefixes, ...t.new.prefixes], urls: [...t.old.urls, ...t.new.urls] };
		meta.old = t.old;
		meta.new = t.new;
	}
	if (isEmptyScope(treatment)) throw new Error('Say which pages the change affects: a path such as /blog/ or a list of URLs.');
	const control = t.kind === 'split' && t.control && !isEmptyScope(t.control) ? t.control : { restOfSite: true };
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

/** Evaluate one test against the stored data. The change day itself counts as "after". */
export function evaluateTest(site: Pick<SiteRow, 'id' | 'synced_through'>, test: SeoTest): TestOutcome {
	const end = siteEnd(site);
	const n = test.window_days;
	const preStart = addDays(test.start_date, -n);
	const preEnd = addDays(test.start_date, -1);
	const postEnd = [addDays(test.start_date, n - 1), end].sort()[0];
	const postDays = Math.max(0, daysBetween(test.start_date, postEnd) + 1);
	const rows = db()
		.prepare('SELECT date, page, SUM(clicks) clicks, SUM(impressions) impressions, SUM(position * impressions) pw FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY date, page')
		.all(site.id, preStart, postDays ? postEnd : preEnd) as DayPage[];
	const inT = scopeMatcher(test.treatment);
	const inC = isRest(test.control) ? (p: string) => !inT(p) : ((m) => (p: string) => !inT(p) && m(p))(scopeMatcher(test.control));
	const oldM = test.meta.old ? scopeMatcher(test.meta.old) : null;
	const days = [...eachDay(preStart, preEnd), ...(postDays ? eachDay(test.start_date, postEnd) : [])];
	const idx = new Map(days.map((d, i) => [d, i]));
	const zero = () => days.map(() => 0);
	const tC = zero(), tI = zero(), cC = zero(), cI = zero();
	const tPages = new Set<string>(), cPages = new Set<string>();
	let pwPre = 0, impPre = 0, pwPost = 0, impPost = 0;
	const parts = { oldPre: 0, oldPost: 0, newPre: 0, newPost: 0 };
	for (const r of rows) {
		const i = idx.get(r.date);
		if (i === undefined) continue;
		const pre = r.date < test.start_date;
		if (inT(r.page)) {
			tC[i] += r.clicks; tI[i] += r.impressions; tPages.add(r.page);
			if (pre) (pwPre += r.pw, (impPre += r.impressions)); else (pwPost += r.pw, (impPost += r.impressions));
			if (oldM) {
				const key = oldM(r.page) ? (pre ? 'oldPre' : 'oldPost') : pre ? 'newPre' : 'newPost';
				parts[key] += r.clicks;
			}
		} else if (inC(r.page)) {
			cC[i] += r.clicks; cI[i] += r.impressions; cPages.add(r.page);
		}
	}
	const split = (xs: number[]) => ({ pre: xs.slice(0, n), post: xs.slice(n) });
	const mk = (t: number[], c: number[]) => liftTest(split(t), split(c));
	const series = (xs: number[]) => indexSeries(days.map((d, i) => ({ date: d, value: xs[i] })), n);
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

/** Suggest control pages for a split test: pages outside the treatment with a similar amount of traffic before the change. */
export function suggestControl(site: Pick<SiteRow, 'id' | 'synced_through'>, treatment: Scope, startDate: string, windowDays = 28): string[] {
	if (isEmptyScope(treatment)) return [];
	const rows = db()
		.prepare('SELECT page, SUM(clicks) clicks FROM sa_rows WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY page')
		.all(site.id, addDays(startDate, -windowDays), addDays(startDate, -1)) as { page: string; clicks: number }[];
	return pickControl(rows, scopeMatcher(treatment));
}

export { emptyScope };
