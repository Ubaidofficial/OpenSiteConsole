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
	// Split on whitespace only: a comma can legitimately be part of a URL.
	for (const line of text.split(/\s+/).map((x) => x.trim()).filter(Boolean)) {
		// "https://x.com/page" is an exact URL unless it ends with "/" or "*": then it is a prefix (that page and everything below it).
		if (/^https?:\/\//i.test(line) && !line.endsWith('*') && !line.endsWith('/')) out.urls.push(line);
		else {
			const prefix = line.replace(/\*$/, '');
			// "blog/" would never match a path; read it as "/blog/".
			out.prefixes.push(/^https?:\/\//i.test(prefix) || prefix.startsWith('/') ? prefix : '/' + prefix);
		}
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
export type Verdict = 'positive' | 'negative' | 'inconclusive' | 'too-little-data' | 'estimate-only';

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
	/** how the noise level was measured */
	/** placebos: earlier windows used; noiseSd: their log-lift spread; detectable: the smallest change (as a fraction, 0.3 = 30%) this test could tell from noise */
	calibration: { placebos: number; noiseSd: number | null; detectable: number | null };
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
type Internal = LiftResult & { _logLift?: number; _se?: number };
function liftInternal(t: Arm, c: Arm): Internal {
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	const totals = { tPre: sum(t.pre), tPost: sum(t.post), cPre: sum(c.pre), cPost: sum(c.post) };
	const n1 = (x: number) => String(Math.round(x * 10) / 10); // totals can be fractional (key events), and must not print as 46.50000000000001
	const empty = (note: string): LiftResult => ({ lift: null, ciLow: null, ciHigh: null, p: null, verdict: 'too-little-data', totals, note, calibration: { placebos: 0, noiseSd: null, detectable: null } });
	if (t.post.length < MIN_POST_DAYS) return empty(`Only ${t.post.length} day(s) of data since the change; wait for at least ${MIN_POST_DAYS}, ideally 14 or more.`);
	if (totals.tPre < MIN_TREATMENT_PRE) return empty(`The test pages had only ${n1(totals.tPre)} before the change; ${MIN_TREATMENT_PRE} are needed for a result worth reading.`);
	if (totals.cPre < MIN_CONTROL_PRE) return empty(`The control pages had only ${n1(totals.cPre)} before the change; ${MIN_CONTROL_PRE} are needed. Add more control pages.`);
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
		note: t.post.length < 14 ? 'Fewer than 14 days since the change: treat this as early.' : null,
		calibration: { placebos: 0, noiseSd: null, detectable: null },
		// internals for the calibrated version
		...({ _logLift: logLift, _se: se } as object)
	};
}

/** Model-only test (no calibration): fine for independent noise, too confident for drifting traffic. See liftTestCalibrated. */
export function liftTest(t: Arm, c: Arm): LiftResult {
	const { _logLift, _se, ...rest } = liftInternal(t, c);
	return rest;
}

// ── Calibration against the site's own history ───────────────────────────────
/**
 * liftTest alone assumes traffic only wobbles day to day. Real traffic also DRIFTS: a page group's average level moves
 * from one month to the next for reasons unrelated to any change. That drift is not in the Poisson / dispersion error, and in
 * simulation (AR(1) daily levels) liftTest called a change real in 40-60% of tests where nothing had changed.
 *
 * The fix is an empirical one: run the same comparison at "placebo" dates in the earlier history, where nothing happened,
 * and see how large a lift appears by chance on THIS site. The root-mean-square of those placebo log-lifts is the noise
 * level; the test is then judged against it with a Student t on (placebos - 1) degrees of freedom (consecutive windows share
 * data, so the effective count is lower than the number of placebos, hence the -1).
 * With fewer than MIN_PLACEBOS earlier windows there is no way to know how much this site drifts, so the answer is shown as
 * an estimate with no verdict.
 */
export const MIN_PLACEBOS = 3;

const lgamma = (x: number): number => {
	const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
	let y = x, t = x + 5.5;
	t -= (x + 0.5) * Math.log(t);
	let s = 1.000000000190015;
	for (const k of c) s += k / ++y;
	return -t + Math.log((2.5066282746310005 * s) / x);
};
/** Regularised incomplete beta I_x(a, b) by Lentz's continued fraction. */
function betaInc(x: number, a: number, b: number): number {
	if (x <= 0) return 0;
	if (x >= 1) return 1;
	const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x));
	const cf = (x: number, a: number, b: number) => {
		const tiny = 1e-30;
		let c = 1, d = 1 - ((a + b) * x) / (a + 1);
		if (Math.abs(d) < tiny) d = tiny;
		d = 1 / d;
		let h = d;
		for (let m = 1; m <= 200; m++) {
			const m2 = 2 * m;
			let aa = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
			d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
			c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
			d = 1 / d; h *= d * c;
			aa = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
			d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny;
			c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny;
			d = 1 / d;
			const del = d * c;
			h *= del;
			if (Math.abs(del - 1) < 3e-12) break;
		}
		return h;
	};
	return x < (a + 1) / (a + b + 2) ? (bt * cf(x, a, b)) / a : 1 - (bt * cf(1 - x, b, a)) / b;
}
/** Student t CDF. */
export function tCdf(t: number, df: number): number {
	const x = df / (df + t * t);
	const tail = 0.5 * betaInc(x, df / 2, 0.5);
	return t >= 0 ? 1 - tail : tail;
}
/** Smallest t with tCdf(t) >= p (bisection). */
export function tQuantile(p: number, df: number): number {
	let lo = 0, hi = 1000;
	for (let i = 0; i < 80; i++) {
		const mid = (lo + hi) / 2;
		if (tCdf(mid, df) < p) lo = mid; else hi = mid;
	}
	return (lo + hi) / 2;
}

export interface Placebo { t: Arm; c: Arm }

/**
 * Placebo comparisons from daily series that run back before the change at index `S`: window j has its "before" at
 * [S-(j+2)n, S-(j+1)n) and its "after" at the first `m` days from S-(j+1)n, the same lengths as the real test.
 * Only windows that fit inside the series (the stored history) are returned.
 */
export function placebosFrom(t: number[], c: number[], S: number, n: number, m: number, max = 4): Placebo[] {
	const out: Placebo[] = [];
	for (let j = 0; j < max; j++) {
		const preStart = S - (j + 2) * n;
		if (preStart < 0) break;
		const postStart = S - (j + 1) * n;
		out.push({ t: { pre: t.slice(preStart, postStart), post: t.slice(postStart, postStart + m) }, c: { pre: c.slice(preStart, postStart), post: c.slice(postStart, postStart + m) } });
	}
	return out;
}

const logLiftOf = (t: Arm, c: Arm) => {
	const s = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	return Math.log((s(t.post) + 0.5) / (s(t.pre) + 0.5)) - Math.log((s(c.post) + 0.5) / (s(c.pre) + 0.5));
};

export function liftTestCalibrated(t: Arm, c: Arm, placebos: Placebo[]): LiftResult {
	const { _logLift, _se, ...rest } = liftInternal(t, c);
	if (rest.verdict === 'too-little-data' || _logLift === undefined || _se === undefined) return rest;
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	// A placebo needs enough clicks to be informative; a near-empty window would understate the noise.
	const usable = placebos.filter((p) => sum(p.t.pre) >= 10 && sum(p.c.pre) >= 30 && p.t.post.length >= MIN_POST_DAYS);
	if (usable.length < MIN_PLACEBOS) {
		return {
			...rest,
			p: null,
			ciLow: null,
			ciHigh: null,
			verdict: 'estimate-only',
			calibration: { placebos: usable.length, noiseSd: null, detectable: null },
			note: `Estimate only. To tell a real change from normal drift, the test needs at least ${MIN_PLACEBOS} earlier windows of the same length with no change (${usable.length} available); the stored history is too short. The figure above is not a verdict.`
		};
	}
	const noise = Math.sqrt(usable.reduce((a, p) => a + logLiftOf(p.t, p.c) ** 2, 0) / usable.length);
	const se = Math.max(_se, noise);
	const df = usable.length - 1;
	const tcrit = tQuantile(0.975, df);
	const p = 2 * (1 - tCdf(Math.abs(_logLift / se), df));
	return {
		...rest,
		lift: Math.exp(_logLift) - 1,
		ciLow: Math.exp(_logLift - tcrit * se) - 1,
		ciHigh: Math.exp(_logLift + tcrit * se) - 1,
		p,
		verdict: p < 0.05 ? (_logLift > 0 ? 'positive' : 'negative') : 'inconclusive',
		// Half the width of the 95% range on the log scale: a true change smaller than this cannot be told from drift.
		calibration: { placebos: usable.length, noiseSd: noise, detectable: Math.exp(tcrit * se) - 1 }
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

// ── Control selection by co-movement ─────────────────────────────────────────
/**
 * What makes a test powerful on drifting traffic is a control that DRIFTS WITH the test pages. Pages in the same section of a
 * site usually do (same template, same topic, same links, same seasonality), and a section the test pages do not belong to
 * usually does not. So rank candidate sections by how closely their weekly clicks tracked the test pages' weekly clicks before
 * the change (Pearson correlation of log(1 + weekly clicks)), and use the best-tracking ones as the control.
 */
export interface SectionSeries { key: string; weekly: number[]; clicks: number }
export interface SectionMatch { key: string; correlation: number }

const pearson = (a: number[], b: number[]) => {
	const n = a.length;
	if (n < 3) return null;
	const ma = a.reduce((x, y) => x + y, 0) / n, mb = b.reduce((x, y) => x + y, 0) / n;
	let sab = 0, saa = 0, sbb = 0;
	for (let i = 0; i < n; i++) { sab += (a[i] - ma) * (b[i] - mb); saa += (a[i] - ma) ** 2; sbb += (b[i] - mb) ** 2; }
	return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : null;
};

/**
 * Best-tracking sections first, until their combined clicks reach `volume` (the control needs enough clicks of its own that its
 * noise does not dominate). Further sections are only added while they track nearly as well as the best (`within`, 0.1 by
 * default): padding the control with weaker matches DILUTES it. Measured on simulated sites whose sections drift together, at
 * a real +50% change, rest-of-site detected it 23% / 53% of the time (strong / moderate section drift), a control padded to 2x
 * the test volume 55% / 75%, and this tighter rule (about 1x the volume, within 0.1) 90% / 95%, with false verdicts on
 * unchanged pages at 0-1.4%. Sections that track the test pages with a correlation below `minCorrelation`, or with fewer than
 * `minWeeks` weeks, are never used: if none qualify the caller falls back to traffic matching or the rest of the site.
 */
export function matchSections(treatmentWeekly: number[], sections: SectionSeries[], o: { volume: number; minCorrelation?: number; minWeeks?: number; within?: number }): SectionMatch[] {
	const { volume, minCorrelation = 0.4, minWeeks = 8, within = 0.1 } = o;
	if (treatmentWeekly.length < minWeeks) return [];
	const t = treatmentWeekly.map((x) => Math.log1p(x));
	const ranked = sections
		.filter((s) => s.weekly.length === treatmentWeekly.length)
		.map((s) => ({ key: s.key, clicks: s.clicks, correlation: pearson(t, s.weekly.map((x) => Math.log1p(x))) }))
		.filter((s): s is { key: string; clicks: number; correlation: number } => s.correlation !== null && s.correlation >= minCorrelation)
		.sort((a, b) => b.correlation - a.correlation || b.clicks - a.clicks);
	const out: SectionMatch[] = [];
	let total = 0;
	for (const s of ranked) {
		if (out.length && s.correlation < ranked[0].correlation - within) break; // a much weaker match would dilute the control
		out.push({ key: s.key, correlation: s.correlation });
		total += s.clicks;
		if (total >= volume) break;
	}
	return total >= volume * 0.5 ? out : []; // too little volume even from everything that tracks: do not pretend
}
