import { db } from './db';
import { addDays, daysBetween, eachDay } from './dates';
import { linksFor } from './links';
import { armOf, scopeHostsOutside, toPathScope } from './ga4tests';
import { AI_ASSISTANTS, type Assistant } from '../ai';
import { liftTestCalibrated, MIN_CONTROL_PRE, MIN_POST_DAYS, MIN_TREATMENT_PRE, placebosFrom, scopeMatcher, type LiftResult, type Scope, type Verdict } from '../experiments';

/**
 * LLM tests: the same before/after comparison against control pages as an ordinary SEO test, measured on GA4 sessions that arrived
 * from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot) instead of Search Console clicks. AI traffic is usually small,
 * so the answer often has to be "too little AI traffic to tell", with the smallest change the test could have seen; that is said
 * plainly rather than dressed up as "no effect". GA4 only sees assistants that send a referrer; the rest land in Direct.
 */

const PLACEBO_MAX = 4;
/** An inconclusive result whose smallest detectable change is above this is reported as "too little AI traffic to tell". */
export const AI_WEAK_DETECTABLE = 0.5;

export type TestMetric = 'clicks' | 'ai_sessions';
export const TEST_METRICS: TestMetric[] = ['clicks', 'ai_sessions'];
export const METRIC_LABEL: Record<TestMetric, string> = { clicks: 'Search clicks', ai_sessions: 'AI-assistant sessions' };
export const isAssistant = (v: unknown): v is Assistant => typeof v === 'string' && (AI_ASSISTANTS as readonly string[]).includes(v);

export type AiVerdict = Verdict | 'too-little-ai-traffic';

export interface AiTestOutcome {
	status: 'ok' | 'no-ga4' | 'loading' | 'partial' | 'error' | 'unsupported';
	note: string | null;
	/** the one assistant the test is limited to, or null for all of them */
	assistant: Assistant | null;
	sessions: LiftResult | null;
	/** the verdict to show: the lift test's, or 'too-little-ai-traffic' when the counts cannot support one */
	verdict: AiVerdict | null;
	/** the smallest change (fraction, 0.6 = 60%) this test could tell from chance */
	detectable: number | null;
	/** 'calibrated': measured on earlier windows of this site; 'counts': from the session counts alone (a lower bound, drift adds to it) */
	detectableBasis: 'calibrated' | 'counts' | null;
	/** set when the chosen control had too few AI sessions and the rest of the site was used instead */
	controlFallback: string | null;
	treatmentPages: number;
	controlPages: number;
	/** AI sessions a day, 7-day average; control scaled to the test pages' level before the change */
	series: { date: string; treatment: number; control: number }[];
	/** test pages, every assistant (whatever the filter): AI sessions a day before and after the change */
	assistants: { assistant: Assistant; before: number; after: number }[];
	coverage: { from: string; through: string } | null;
}

interface AiTest { start_date: string; window_days: number; treatment: Scope; control: Scope | { restOfSite: true }; meta: { controlMethod?: string }; assistant?: Assistant | null }

export function aiFingerprint(siteId: number): string {
	return JSON.stringify(db().prepare('SELECT through_date t, pulled_at p, error e FROM ga4_ai_daily_meta WHERE site_id = ?').get(siteId) ?? null);
}

/** Smallest detectable change from counts alone: a Poisson-only 95% half-width for a full window, so a lower bound. */
export function countsDetectable(tPre: number, cPre: number): number {
	const se = Math.sqrt(2 / (tPre + 0.5) + (cPre > 0 ? 2 / (cPre + 0.5) : 0));
	return Math.exp(1.96 * se) - 1;
}

/** The verdict to show and the smallest detectable change, from a lift result on AI sessions. */
export function aiVerdict(r: LiftResult, postDays: number): { verdict: AiVerdict; detectable: number; basis: 'calibrated' | 'counts'; note: string | null } {
	const basis = r.calibration.detectable != null ? 'calibrated' : 'counts';
	const detectable = r.calibration.detectable ?? countsDetectable(r.totals.tPre, r.totals.cPre);
	const pctOf = (x: number) => `${Math.round(x * 100)}%`;
	const floor = basis === 'counts' ? ' (more once normal drift is counted)' : '';
	const tooFew = postDays >= MIN_POST_DAYS && r.verdict === 'too-little-data' && (r.totals.tPre < MIN_TREATMENT_PRE || r.totals.cPre < MIN_CONTROL_PRE);
	if (tooFew) {
		const who = r.totals.tPre < MIN_TREATMENT_PRE ? `the test pages had ${r.totals.tPre} AI-assistant session${r.totals.tPre === 1 ? '' : 's'} before the change (${MIN_TREATMENT_PRE} needed)` : `the control pages had ${r.totals.cPre} AI-assistant sessions before the change (${MIN_CONTROL_PRE} needed)`;
		return { verdict: 'too-little-ai-traffic', detectable, basis, note: `Too little AI traffic to tell: ${who}. With counts this small only a change bigger than about ±${pctOf(detectable)}${floor} could be told from chance. Use a longer window, add more pages, or test the whole site's AI traffic.` };
	}
	if (r.verdict === 'inconclusive' && detectable > AI_WEAK_DETECTABLE) {
		return { verdict: 'too-little-ai-traffic', detectable, basis, note: `Too little AI traffic to tell: this test could only have seen a change bigger than about ±${pctOf(detectable)}, so "no clear effect" would be weak evidence either way. Let it run longer or use a longer window.` };
	}
	return { verdict: r.verdict, detectable, basis, note: null };
}

/** 7-day trailing mean of xs, from index `from` on (the earlier values feed the first means). */
function smooth(xs: number[], from: number, w = 7): number[] {
	const out: number[] = [];
	for (let i = from; i < xs.length; i++) {
		const lo = Math.max(0, i - w + 1);
		let s = 0;
		for (let j = lo; j <= i; j++) s += xs[j];
		out.push(s / (i - lo + 1));
	}
	return out;
}

/** Evaluate an LLM test from the stored daily AI-assistant sessions. The change day itself counts as "after". */
export function evaluateAi(siteId: number, test: AiTest): AiTestOutcome {
	const d = db();
	const assistant = test.assistant ?? null;
	const none = (status: AiTestOutcome['status'], note: string): AiTestOutcome => ({ status, note, assistant, sessions: null, verdict: null, detectable: null, detectableBasis: null, controlFallback: null, treatmentPages: 0, controlPages: 0, series: [], assistants: [], coverage: null });
	const siteUrl = (d.prepare('SELECT site_url FROM sites WHERE id = ?').get(siteId) as { site_url: string } | undefined)?.site_url ?? '';
	const outside = [...scopeHostsOutside(test.treatment, siteUrl), ...('restOfSite' in test.control ? [] : scopeHostsOutside(test.control, siteUrl))];
	if (outside.length) return none('unsupported', `GA4 reports landing pages without a hostname, so a test on ${[...new Set(outside)].slice(0, 3).join(', ')} cannot be told apart from the rest of the property.`);
	if (!linksFor(siteId).ga4) return none('no-ga4', 'Link a GA4 property on the Connect page: LLM tests are measured on GA4 sessions from AI assistants.');
	const meta = d.prepare('SELECT from_date, through_date, error FROM ga4_ai_daily_meta WHERE site_id = ?').get(siteId) as { from_date: string | null; through_date: string | null; error: string | null } | undefined;
	if (!meta?.from_date || !meta.through_date) return meta?.error ? none('error', `GA4 could not be read: ${meta.error}`) : none('loading', 'AI-assistant sessions for this test are still loading from GA4; they appear after the next sync.');
	const n = test.window_days;
	const start = test.start_date;
	const preStart = addDays(start, -n);
	if (meta.from_date > preStart) return none('partial', `GA4 AI-assistant data only goes back to ${meta.from_date}, which does not cover the ${n} days before the change (from ${preStart}).`);
	// GA4 is still processing the last two days, and a part-counted day would read as a drop after the change.
	const postEnd = [addDays(start, n - 1), addDays(meta.through_date, -2)].sort()[0];
	const postDays = Math.max(0, daysBetween(start, postEnd) + 1);
	const gStart = [addDays(start, -(PLACEBO_MAX + 1) * n), meta.from_date].sort()[1];
	const preDays = eachDay(gStart, addDays(start, -1));
	const days = [...preDays, ...(postDays ? eachDay(start, postEnd) : [])];
	const S = preDays.length;
	const idx = new Map(days.map((x, i) => [x, i]));
	const rows = d
		.prepare('SELECT date, assistant, page, sessions FROM ga4_ai_daily WHERE site_id = ? AND date BETWEEN ? AND ?')
		.all(siteId, gStart, postDays ? postEnd : addDays(start, -1)) as { date: string; assistant: Assistant; page: string; sessions: number }[];
	const inT = scopeMatcher(toPathScope(test.treatment));
	const named = 'restOfSite' in test.control ? null : scopeMatcher(toPathScope(test.control));
	const z = () => days.map(() => 0);
	// Two controls are counted at once: the chosen one, and the rest of the site to fall back on if the chosen one is too thin.
	const t = z(), cChosen = z(), cRest = z();
	const tPages = new Set<string>(), chosenPages = new Set<string>(), restPages = new Set<string>();
	const per = new Map<Assistant, { pre: number; post: number }>();
	const arm = new Map<string, [0 | 1 | 2, 0 | 1 | 2]>();
	for (const r of rows) {
		const i = idx.get(r.date);
		if (i === undefined) continue;
		let a = arm.get(r.page);
		if (!a) arm.set(r.page, (a = [armOf(r.page, inT, named), armOf(r.page, inT, null)]));
		if (a[0] === 1 && i >= S - n) {
			const p = per.get(r.assistant) ?? { pre: 0, post: 0 };
			if (i < S) p.pre += r.sessions; else p.post += r.sessions;
			per.set(r.assistant, p);
		}
		if (assistant && r.assistant !== assistant) continue;
		if (a[0] === 1) (t[i] += r.sessions), tPages.add(r.page);
		if (a[0] === 2) (cChosen[i] += r.sessions), chosenPages.add(r.page);
		if (a[1] === 2) (cRest[i] += r.sessions), restPages.add(r.page);
	}
	const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
	// A matched control is chosen on search clicks, and may carry almost no AI traffic. Decided on the "before" window only.
	let c = cChosen, cPages = chosenPages, controlFallback: string | null = null;
	const chosenPre = sum(cChosen.slice(S - n, S));
	if (named && test.meta.controlMethod !== 'named' && chosenPre < MIN_CONTROL_PRE && sum(cRest.slice(S - n, S)) > chosenPre) {
		(c = cRest), (cPages = restPages);
		controlFallback = `The matched control pages had only ${chosenPre} AI-assistant sessions in the ${n} days before the change, too few to compare against, so every other page is the control instead.`;
	}
	const sessions = liftTestCalibrated({ pre: t.slice(S - n, S), post: t.slice(S) }, { pre: c.slice(S - n, S), post: c.slice(S) }, placebosFrom(t, c, S, n, postDays, PLACEBO_MAX));
	const v = aiVerdict(sessions, postDays);
	const cPre = sum(c.slice(S - n, S));
	const scale = cPre > 0 ? sum(t.slice(S - n, S)) / cPre : 0;
	const st = smooth(t, S - n), sc = smooth(c, S - n);
	const r1 = (x: number) => Math.round(x * 10) / 10;
	const r2 = (x: number) => Math.round(x * 100) / 100;
	return {
		status: 'ok',
		note: v.note ?? sessions.note,
		assistant,
		sessions,
		verdict: v.verdict,
		detectable: v.detectable,
		detectableBasis: v.basis,
		controlFallback,
		treatmentPages: tPages.size,
		controlPages: cPages.size,
		series: days.slice(S - n).map((date, i) => ({ date, treatment: r2(st[i]), control: r2(sc[i] * scale) })),
		assistants: AI_ASSISTANTS.filter((a) => per.has(a)).map((a) => ({ assistant: a, before: r1(per.get(a)!.pre / n), after: postDays ? r1(per.get(a)!.post / postDays) : 0 })).sort((x, y) => y.before + y.after - (x.before + x.after)),
		coverage: { from: meta.from_date, through: meta.through_date }
	};
}
