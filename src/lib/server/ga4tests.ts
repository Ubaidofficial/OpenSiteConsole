import { db } from './db';
import { addDays, daysBetween, eachDay, pacificToday, retentionHorizon } from './dates';
import { linksFor } from './links';
import { ga4SourceFor, type Ga4Source } from './channels';
import type { Ga4AiDay, Ga4PageDay } from './ga4';
import { liftTestCalibrated, placebosFrom, scopeMatcher, type LiftResult, type Scope } from '../experiments';

const PLACEBO_MAX = 4;
const CHUNK_DAYS = 45;
const REFRESH_DAYS = 10; // GA4 reprocesses recent days

interface TestWindow { start_date: string; window_days: number }

type Loaded = { pulled: number; error: string | null; skipped: string | null };
interface DailyStore<R> {
	meta: 'ga4_page_meta' | 'ga4_ai_daily_meta';
	table: 'ga4_page_daily' | 'ga4_ai_daily';
	fetch: (src: Ga4Source, property: string, start: string, end: string) => Promise<R[]>;
	insert: string;
	values: (siteId: number, r: R) => unknown[];
}

/**
 * Daily Google-organic sessions and key events per landing page are only worth storing for a site that has an SEO test: they can
 * be large. This loads (and keeps fresh) exactly the range the site's tests need (see ensureDaily).
 */
export function ensureGa4PageDaily(siteId: number, tests: TestWindow[], src?: Ga4Source, today = pacificToday()): Promise<Loaded> {
	return ensureDaily<Ga4PageDay>(siteId, tests, {
		meta: 'ga4_page_meta',
		table: 'ga4_page_daily',
		fetch: (source, p, s, e) => source.organicDaily(p, s, e),
		insert: 'INSERT OR REPLACE INTO ga4_page_daily (site_id, date, page, sessions, key_events) VALUES (?,?,?,?,?)',
		values: (id, r) => [id, r.date, r.page, r.sessions, r.keyEvents]
	}, src, today);
}

/**
 * Daily AI-assistant sessions per landing page and assistant, for LLM tests only (pass just those tests). Every landing page is
 * stored, not only the test pages, because the control is made of the other pages; AI traffic is small, so this stays small.
 */
export function ensureGa4AiDaily(siteId: number, tests: TestWindow[], src?: Ga4Source, today = pacificToday()): Promise<Loaded> {
	return ensureDaily<Ga4AiDay>(siteId, tests, {
		meta: 'ga4_ai_daily_meta',
		table: 'ga4_ai_daily',
		fetch: (source, p, s, e) => {
			if (!source.aiDaily) throw new Error('This GA4 connection cannot read AI-assistant sessions by day.');
			return source.aiDaily(p, s, e);
		},
		insert: 'INSERT OR REPLACE INTO ga4_ai_daily (site_id, date, assistant, page, sessions, key_events) VALUES (?,?,?,?,?,?)',
		values: (id, r) => [id, r.date, r.assistant, r.page, r.sessions, r.keyEvents]
	}, src, today);
}

/** Load the daily GA4 data a site's tests need: organic landing pages for search-click tests, AI-assistant sessions for LLM tests. */
export async function ensureGa4TestData(siteId: number, tests: (TestWindow & { metric?: string })[], src?: Ga4Source, today = pacificToday()): Promise<{ pages: Loaded; ai: Loaded }> {
	const pages = await ensureGa4PageDaily(siteId, tests.filter((t) => t.metric !== 'ai_sessions'), src, today);
	const ai = await ensureGa4AiDaily(siteId, tests.filter((t) => t.metric === 'ai_sessions'), src, today);
	return { pages, ai };
}

/**
 * Load (and keep fresh) the range of daily GA4 data the tests need: back far enough for the noise calibration, and the last few
 * days again each time because GA4 revises them. It never throws; the outcome (or the error) is stored in the meta table.
 */
async function ensureDaily<R>(siteId: number, tests: TestWindow[], store: DailyStore<R>, src: Ga4Source | undefined, today: string): Promise<Loaded> {
	const link = linksFor(siteId).ga4;
	if (!link?.account_id) return { pulled: 0, error: null, skipped: 'GA4 is not linked' };
	if (!tests.length) return { pulled: 0, error: null, skipped: 'no tests' };
	const d = db();
	const horizon = retentionHorizon(today);
	const needFrom = tests.map((t) => addDays(t.start_date, -(PLACEBO_MAX + 1) * t.window_days)).sort()[0];
	const from = needFrom < horizon ? horizon : needFrom;
	const meta = d.prepare(`SELECT from_date, through_date FROM ${store.meta} WHERE site_id = ?`).get(siteId) as { from_date: string | null; through_date: string | null } | undefined;
	const ranges: [string, string][] = [];
	if (!meta?.from_date || !meta.through_date) ranges.push([from, today]);
	else {
		if (from < meta.from_date) ranges.push([from, addDays(meta.from_date, -1)]);
		const refresh = addDays(meta.through_date, -REFRESH_DAYS);
		ranges.push([refresh < meta.from_date ? meta.from_date : refresh, today]);
	}
	let pulled = 0;
	try {
		const source = src ?? ga4SourceFor(link.account_id);
		const del = d.prepare(`DELETE FROM ${store.table} WHERE site_id = ? AND date BETWEEN ? AND ?`);
		const ins = d.prepare(store.insert);
		for (const [s, e] of ranges) {
			for (let cs = s; cs <= e; cs = addDays(cs, CHUNK_DAYS)) {
				const ce = addDays(cs, CHUNK_DAYS - 1) > e ? e : addDays(cs, CHUNK_DAYS - 1);
				const rows = await store.fetch(source, link.external_id, cs, ce);
				d.transaction(() => {
					del.run(siteId, cs, ce);
					for (const r of rows) ins.run(...store.values(siteId, r));
				})();
				pulled += rows.length;
			}
		}
		const lo = meta?.from_date && meta.from_date < from ? meta.from_date : from;
		d.prepare(`INSERT OR REPLACE INTO ${store.meta} (site_id, from_date, through_date, pulled_at, error) VALUES (?,?,?,?,NULL)`).run(siteId, lo, today, Date.now());
		return { pulled, error: null, skipped: null };
	} catch (e) {
		const msg = e instanceof Error ? e.message : 'GA4 could not be read';
		d.prepare(`INSERT INTO ${store.meta} (site_id, from_date, through_date, pulled_at, error) VALUES (?,?,?,?,?) ON CONFLICT(site_id) DO UPDATE SET error = excluded.error, pulled_at = excluded.pulled_at`).run(siteId, meta?.from_date ?? null, meta?.through_date ?? null, Date.now(), msg);
		return { pulled, error: msg, skipped: null };
	}
}

export interface ConversionOutcome {
	status: 'ok' | 'no-ga4' | 'loading' | 'partial' | 'error' | 'unsupported';
	note: string | null;
	keyEvents: LiftResult | null;
	sessions: LiftResult | null;
	/** key events per session on the test pages, before and after (descriptive, not tested) */
	rate: { before: number | null; after: number | null } | null;
	coverage: { from: string; through: string } | null;
}

const HOST = 'https://ga4.local';
/** GA4 reports landing PATHS, Search Console reports full URLs: compare on paths, under one made-up host. */
const pathOf = (u: string) => {
	try {
		return new URL(u).pathname || '/';
	} catch {
		return u.startsWith('/') ? u : '/' + u;
	}
};
export function toPathScope(s: Scope): Scope {
	return { urls: s.urls.map((u) => HOST + pathOf(u)), prefixes: s.prefixes.map((p) => (/^https?:\/\//i.test(p) ? HOST + pathOf(p) : p)) };
}

/** Does the scope name a host other than the property's own? GA4 landing pages carry no hostname, so such a test cannot be separated. */
export function scopeHostsOutside(s: Scope, siteUrl: string): string[] {
	const own = (siteUrl.startsWith('sc-domain:') ? siteUrl.slice(10) : (() => { try { return new URL(siteUrl).hostname; } catch { return siteUrl; } })()).toLowerCase().replace(/^www\./, '');
	const out = new Set<string>();
	for (const u of [...s.urls, ...s.prefixes]) {
		if (!/^https?:\/\//i.test(u)) continue;
		try {
			const h = new URL(u).hostname.toLowerCase().replace(/^www\./, '');
			if (h !== own) out.add(h);
		} catch { /* not a URL */ }
	}
	return [...out];
}

/** Which arm a GA4 landing path belongs to: 1 = test pages, 2 = control, 0 = neither. */
export function armOf(path: string, inT: (u: string) => boolean, inC: ((u: string) => boolean) | null): 0 | 1 | 2 {
	// GA4 keeps "/blog" where Search Console has "/blog/": the section's own page belongs to the section.
	const full = HOST + path;
	const slashed = path.length > 1 ? full + '/' : full;
	if (inT(full) || inT(slashed)) return 1;
	return !inC || inC(full) || inC(slashed) ? 2 : 0;
}

export function ga4Fingerprint(siteId: number): string {
	const m = db().prepare('SELECT through_date t, pulled_at p, error e FROM ga4_page_meta WHERE site_id = ?').get(siteId);
	return JSON.stringify(m ?? null);
}

/**
 * The same calibrated comparison as for clicks, on Google-organic sessions and key events from GA4, plus the key-event rate before
 * and after. Key events are rare, so many tests will honestly say there are too few to judge; that is shown, not hidden.
 */
export function conversionsFor(siteId: number, test: { start_date: string; window_days: number; treatment: Scope; control: Scope | { restOfSite: true } }, postEndWanted: string): ConversionOutcome {
	const d = db();
	const none = (status: ConversionOutcome['status'], note: string): ConversionOutcome => ({ status, note, keyEvents: null, sessions: null, rate: null, coverage: null });
	const siteUrl = (d.prepare('SELECT site_url FROM sites WHERE id = ?').get(siteId) as { site_url: string } | undefined)?.site_url ?? '';
	const outside = [...scopeHostsOutside(test.treatment, siteUrl), ...('restOfSite' in test.control ? [] : scopeHostsOutside(test.control, siteUrl))];
	if (outside.length) return none('unsupported', `GA4 reports landing pages without a hostname, so a test on ${[...new Set(outside)].slice(0, 3).join(', ')} cannot be told apart from the rest of the property. Clicks are still judged from Search Console.`);
	if (!linksFor(siteId).ga4) return none('no-ga4', 'Link a GA4 property on the Connect page to judge this test on conversions as well as clicks.');
	const meta = d.prepare('SELECT from_date, through_date, error FROM ga4_page_meta WHERE site_id = ?').get(siteId) as { from_date: string | null; through_date: string | null; error: string | null } | undefined;
	if (!meta?.from_date || !meta.through_date) return meta?.error ? none('error', `GA4 could not be read: ${meta.error}`) : none('loading', 'GA4 data for this test is still loading; it appears after the next sync.');
	const n = test.window_days;
	const start = test.start_date;
	const preStart = addDays(start, -n);
	if (meta.from_date > preStart) return none('partial', `GA4 data only goes back to ${meta.from_date}, which does not cover the ${n} days before the change (from ${preStart}). It fills in as GA4 is read.`);
	const postEnd = [postEndWanted, meta.through_date].sort()[0];
	const postDays = Math.max(0, daysBetween(start, postEnd) + 1);
	const gStart = [addDays(start, -(PLACEBO_MAX + 1) * n), meta.from_date].sort()[1];
	const preDays = eachDay(gStart, addDays(start, -1));
	const days = [...preDays, ...(postDays ? eachDay(start, postEnd) : [])];
	const S = preDays.length;
	const idx = new Map(days.map((x, i) => [x, i]));
	const inT = scopeMatcher(toPathScope(test.treatment));
	const inC = 'restOfSite' in test.control ? null : scopeMatcher(toPathScope(test.control));
	const z = () => days.map(() => 0);
	const tS = z(), tK = z(), cS = z(), cK = z();
	const arm = new Map<string, 0 | 1 | 2>();
	const rows = d.prepare('SELECT date, page, sessions, key_events k FROM ga4_page_daily WHERE site_id = ? AND date BETWEEN ? AND ?').all(siteId, gStart, postDays ? postEnd : addDays(start, -1)) as { date: string; page: string; sessions: number; k: number }[];
	for (const r of rows) {
		const i = idx.get(r.date);
		if (i === undefined) continue;
		let a = arm.get(r.page);
		if (a === undefined) {
			a = armOf(r.page, inT, inC);
			arm.set(r.page, a);
		}
		if (a === 1) { tS[i] += r.sessions; tK[i] += r.k; } else if (a === 2) { cS[i] += r.sessions; cK[i] += r.k; }
	}
	const split = (xs: number[]) => ({ pre: xs.slice(S - n, S), post: xs.slice(S) });
	const lift = (t: number[], c: number[]) => liftTestCalibrated(split(t), split(c), placebosFrom(t, c, S, n, postDays, PLACEBO_MAX));
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const sp = sum(tS.slice(S - n, S)), sq = sum(tS.slice(S));
	return {
		status: 'ok',
		note: postDays < n ? `GA4 is loaded through ${meta.through_date}.` : null,
		keyEvents: lift(tK, cK),
		sessions: lift(tS, cS),
		rate: { before: sp ? sum(tK.slice(S - n, S)) / sp : null, after: sq ? sum(tK.slice(S)) / sq : null },
		coverage: { from: meta.from_date, through: meta.through_date }
	};
}
