/**
 * SEO tests: did a change move a group of pages, compared with a control group over the same days?
 * Difference-in-differences on click counts with an overdispersion-aware standard error. Pure functions, unit-tested.
 *
 * What this can and cannot tell you: the control absorbs shared shocks (seasonality, a Google update, a site-wide dip),
 * but pages are not randomly assigned, so a "significant" lift means "unlikely to be noise given the control", not proof
 * that the change caused it. Anything else that touched only the treatment pages at the same time is invisible here.
 */
import { normalizeUrl } from './analytics';

// ── Scopes: which pages an arm covers ────────────────────────────────────────
export interface Scope {
	/** "/blog/" (path prefix) or "https://example.com/blog/" (URL prefix) */
	prefixes: string[];
	/** exact URLs; trailing slash, www and query string are ignored when matching */
	urls: string[];
}
export const emptyScope = (): Scope => ({ prefixes: [], urls: [] });
export const isEmptyScope = (s: Scope) => !s.prefixes.length && !s.urls.length;

export function parseScope(text: string): Scope {
	const out = emptyScope();
	for (const line of text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)) {
		// "https://x.com/page" is an exact URL unless it ends with "/" or "*": then it is a prefix.
		if (/^https?:\/\//i.test(line) && !line.endsWith('*') && !line.endsWith('/')) out.urls.push(line);
		else out.prefixes.push(line.replace(/\*$/, ''));
	}
	return out;
}

export function scopeMatcher(s: Scope): (page: string) => boolean {
	const urls = new Set(s.urls.map(normalizeUrl));
	return (page) => {
		if (urls.size && urls.has(normalizeUrl(page))) return true;
		if (!s.prefixes.length) return false;
		let path = page;
		try {
			path = new URL(page).pathname;
		} catch {
			/* keep as is */
		}
		return s.prefixes.some((p) => (p.startsWith('/') ? path.startsWith(p) : page.startsWith(p)));
	};
}

// ── Statistics ───────────────────────────────────────────────────────────────
/** Standard normal CDF (Abramowitz & Stegun 7.1.26, error below 1.5e-7). */
export function normalCdf(z: number): number {
	const t = 1 / (1 + 0.3275911 * (Math.abs(z) / Math.SQRT2));
	const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
	return z >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

/** Index of dispersion of daily counts (variance / mean), never below 1: Poisson noise is the floor, real days vary more. */
export function dispersion(daily: number[]): number {
	const n = daily.length;
	if (n < 5) return 1;
	const mean = daily.reduce((a, b) => a + b, 0) / n;
	if (mean <= 0) return 1;
	const v = daily.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
	return Math.max(1, v / mean);
}

export interface Arm { pre: number[]; post: number[] }
export type Verdict = 'positive' | 'negative' | 'inconclusive' | 'too-little-data';

export interface LiftResult {
	/** treatment's change relative to the control's change, e.g. 0.12 = +12% */
	lift: number | null;
	ciLow: number | null;
	ciHigh: number | null;
	p: number | null;
	verdict: Verdict;
	totals: { tPre: number; tPost: number; cPre: number; cPost: number };
	/** why there is no verdict, or a caution */
	note: string | null;
}

export const MIN_TREATMENT_PRE = 30;
export const MIN_CONTROL_PRE = 100;
export const MIN_POST_DAYS = 7;

/**
 * lift = (T_post / T_pre) / (C_post / C_pre) - 1. Log-scale standard error by the delta method, with each arm's
 * variance scaled by its pre-period dispersion. Treatment and control are likely positively correlated, which would
 * shrink the true error, so ignoring that is the conservative choice. 0.5 is added to each count so a group that
 * went to zero still gives a finite answer.
 */
export function liftTest(t: Arm, c: Arm): LiftResult {
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const totals = { tPre: sum(t.pre), tPost: sum(t.post), cPre: sum(c.pre), cPost: sum(c.post) };
	const empty = (note: string): LiftResult => ({ lift: null, ciLow: null, ciHigh: null, p: null, verdict: 'too-little-data', totals, note });
	if (t.post.length < MIN_POST_DAYS) return empty(`Only ${t.post.length} day(s) of data since the change; wait for at least ${MIN_POST_DAYS}, ideally 14 or more.`);
	if (totals.tPre < MIN_TREATMENT_PRE) return empty(`The test pages had only ${totals.tPre} before the change; ${MIN_TREATMENT_PRE} are needed for a result worth reading.`);
	if (totals.cPre < MIN_CONTROL_PRE) return empty(`The control pages had only ${totals.cPre} before the change; ${MIN_CONTROL_PRE} are needed. Add more control pages.`);
	const h = 0.5;
	const logLift = Math.log((totals.tPost + h) / (totals.tPre + h)) - Math.log((totals.cPost + h) / (totals.cPre + h));
	const se = Math.sqrt(dispersion(t.pre) * (1 / (totals.tPre + h) + 1 / (totals.tPost + h)) + dispersion(c.pre) * (1 / (totals.cPre + h) + 1 / (totals.cPost + h)));
	const p = 2 * (1 - normalCdf(Math.abs(logLift / se)));
	const verdict: Verdict = p < 0.05 ? (logLift > 0 ? 'positive' : 'negative') : 'inconclusive';
	return {
		lift: Math.exp(logLift) - 1,
		ciLow: Math.exp(logLift - 1.96 * se) - 1,
		ciHigh: Math.exp(logLift + 1.96 * se) - 1,
		p,
		verdict,
		totals,
		note: t.post.length < 14 ? 'Fewer than 14 days since the change: treat this as early.' : null
	};
}

/**
 * Pick control pages that look like the test pages: same traffic level, outside the test group. Matching on traffic
 * level (not content) keeps the choice explainable. Up to 3x as many control pages as test pages, at least `min`.
 */
export function pickControl(pages: { page: string; clicks: number }[], inTreatment: (page: string) => boolean, o: { min?: number; cap?: number } = {}): string[] {
	const { min = 5, cap = 2000 } = o;
	const treat = pages.filter((p) => inTreatment(p.page));
	const cands = pages.filter((p) => !inTreatment(p.page) && p.clicks > 0);
	if (!treat.length || !cands.length) return [];
	const logs = treat.map((p) => Math.log1p(p.clicks)).sort((a, b) => a - b);
	const target = logs[logs.length >> 1];
	const want = Math.min(cap, Math.max(min, treat.length * 3));
	return cands
		.map((p) => ({ page: p.page, d: Math.abs(Math.log1p(p.clicks) - target) }))
		.sort((a, b) => a.d - b.d || a.page.localeCompare(b.page))
		.slice(0, want)
		.map((p) => p.page);
}

/** Daily rate relative to the pre-period mean (=100), smoothed over `smooth` days, for plotting treatment against control. */
export function indexSeries(days: { date: string; value: number }[], preDays: number, smooth = 7): { date: string; value: number }[] {
	const pre = days.slice(0, preDays);
	const base = pre.length ? pre.reduce((a, b) => a + b.value, 0) / pre.length : 0;
	return days.map((d, i) => {
		const w = days.slice(Math.max(0, i - smooth + 1), i + 1);
		const m = w.reduce((a, b) => a + b.value, 0) / w.length;
		return { date: d.date, value: base > 0 ? (m / base) * 100 : 0 };
	});
}
