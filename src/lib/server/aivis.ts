/**
 * AI visibility, the stored half: the prompts you track per site, competitor domains, and every answer the assistants gave.
 *
 * Each prompt is asked of each assistant with an API key every AI_VIS_EVERY_DAYS days (default 7), within a daily cap on runs across
 * all sites (AI_VIS_RUNS_PER_DAY, default 60), because every run costs money on your own API account: tokens, plus the provider's
 * per-search fee where it has one. Nothing runs without a key. In demo mode the answers are simulated and say so.
 */
import { db, audit } from './db';
import { env, config } from './config';
import { getSite, type SiteRow } from './clients';
import { brandTerms } from './queries';
import { hostKey } from './hosts';
import { askEngine, demoAnswer, enabledEngines, EngineError, type EngineResult } from './aiengines';
import { analyzeAnswer, normalizeDomain, summarizeRuns, AI_ENGINES, type AiEngine, type AnswerVerdict } from '../aivis';

export const MAX_PROMPTS = 50;
export const MAX_COMPETITORS = 10;
export const PROMPT_MAX_CHARS = 500;
const DAY = 86_400_000;
const num = (name: string, d: number, lo: number, hi: number) => { const n = Number(env(name, String(d))); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d; };
export const runsPerDay = () => num('AI_VIS_RUNS_PER_DAY', 60, 0, 2000);
export const everyDays = () => num('AI_VIS_EVERY_DAYS', 7, 1, 90);

export interface AiPrompt { id: number; siteId: number; prompt: string; createdAt: number }
export const listPrompts = (siteId: number): AiPrompt[] =>
	(db().prepare('SELECT id, site_id, prompt, created_at FROM ai_prompts WHERE site_id = ? AND active = 1 ORDER BY id').all(siteId) as { id: number; site_id: number; prompt: string; created_at: number }[]).map((r) => ({ id: r.id, siteId: r.site_id, prompt: r.prompt, createdAt: r.created_at }));

/** Add prompts (one per line). Blank lines, duplicates and anything over the limits are skipped, and the reason is returned. */
export function addPrompts(siteId: number, text: string): { added: number; skipped: string[] } {
	const existing = new Set(listPrompts(siteId).map((p) => p.prompt.toLowerCase()));
	const skipped: string[] = [];
	let added = 0;
	const ins = db().prepare('INSERT INTO ai_prompts (site_id, prompt, created_at) VALUES (?,?,?)');
	for (const raw of text.split(/\r?\n/)) {
		const p = raw.replace(/\s+/g, ' ').trim();
		if (!p) continue;
		if (p.length < 3) { skipped.push(`“${p}”: too short`); continue; }
		if (p.length > PROMPT_MAX_CHARS) { skipped.push(`“${p.slice(0, 40)}…”: longer than ${PROMPT_MAX_CHARS} characters`); continue; }
		if (existing.has(p.toLowerCase())) { skipped.push(`“${p.slice(0, 60)}”: already tracked`); continue; }
		if (existing.size >= MAX_PROMPTS) { skipped.push(`“${p.slice(0, 40)}…”: at most ${MAX_PROMPTS} prompts per site`); continue; }
		ins.run(siteId, p, Date.now());
		existing.add(p.toLowerCase());
		added++;
	}
	return { added, skipped };
}

/** Remove a prompt and its answers. */
export const deletePrompt = (siteId: number, id: number) => db().prepare('DELETE FROM ai_prompts WHERE id = ? AND site_id = ?').run(id, siteId).changes === 1;

export const listCompetitors = (siteId: number): string[] => (db().prepare('SELECT domain FROM ai_competitors WHERE site_id = ? ORDER BY domain').all(siteId) as { domain: string }[]).map((r) => r.domain);
/** Replace the competitor list with these domains (comma- or line-separated; the site's own domain is left out). */
export function setCompetitors(site: SiteRow, text: string): string[] {
	const own = hostKey(site.site_url);
	const list = [...new Set(text.split(/[\s,]+/).map(normalizeDomain).filter((d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) && d !== own))].slice(0, MAX_COMPETITORS);
	const d = db();
	d.transaction(() => {
		d.prepare('DELETE FROM ai_competitors WHERE site_id = ?').run(site.id);
		for (const c of list) d.prepare('INSERT INTO ai_competitors (site_id, domain) VALUES (?,?)').run(site.id, c);
	})();
	return list;
}

const utcDayStart = (now: number) => now - (now % DAY);
export const runsToday = (now = Date.now()) => (db().prepare('SELECT COUNT(*) n FROM ai_runs WHERE ran_at >= ?').get(utcDayStart(now)) as { n: number }).n;
export const budgetLeft = (now = Date.now()) => Math.max(0, runsPerDay() - runsToday(now));

/** Ask one assistant one prompt now, judge the answer and store it. Never throws: a failure is stored as an error run. */
export async function runPrompt(promptId: number, engine: AiEngine, o: { fetchImpl?: typeof fetch; now?: number; ask?: (engine: AiEngine, prompt: string) => Promise<EngineResult> } = {}): Promise<{ ok: boolean; error?: string }> {
	const p = db().prepare('SELECT id, site_id, prompt FROM ai_prompts WHERE id = ? AND active = 1').get(promptId) as { id: number; site_id: number; prompt: string } | undefined;
	if (!p) return { ok: false, error: 'No such prompt.' };
	const site = getSite(p.site_id);
	if (!site) return { ok: false, error: 'Unknown site.' };
	const competitors = listCompetitors(site.id);
	const now = o.now ?? Date.now();
	const ins = db().prepare('INSERT INTO ai_runs (prompt_id, site_id, engine, model, ran_at, status, error, answer, citations, sources, verdict, searches) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
	try {
		const done = (db().prepare('SELECT COUNT(*) n FROM ai_runs WHERE prompt_id = ? AND engine = ?').get(p.id, engine) as { n: number }).n;
		const ask = o.ask ?? (config.demo ? async (e: AiEngine, q: string) => demoAnswer(q, e, site.site_url, competitors, done) : (e: AiEngine, q: string) => askEngine(e, q, { fetchImpl: o.fetchImpl }));
		const r = await ask(engine, p.prompt);
		const verdict = analyzeAnswer(r, { domain: hostKey(site.site_url), brandTerms: brandTerms(site), competitors });
		ins.run(p.id, site.id, engine, r.model, now, 'ok', null, r.text.slice(0, 20_000), JSON.stringify(r.citations.slice(0, 100)), JSON.stringify(r.sources.slice(0, 200)), JSON.stringify(verdict), r.searches);
		return { ok: true };
	} catch (e) {
		const msg = e instanceof EngineError ? e.message : e instanceof Error ? `Unexpected error: ${e.message}` : 'Unexpected error.';
		ins.run(p.id, site.id, engine, null, now, 'error', msg.slice(0, 500), null, null, null, null, 0);
		return { ok: false, error: msg };
	}
}

/** The (prompt, assistant) pairs whose last run is older than the interval, oldest first, for one site or all. */
export function dueRuns(o: { siteId?: number; now?: number; force?: boolean } = {}): { promptId: number; engine: AiEngine; siteId: number }[] {
	const engines = enabledEngines();
	if (!engines.length) return [];
	const now = o.now ?? Date.now();
	const cutoff = o.force ? now - 3600_000 : now - everyDays() * DAY + 3600_000; // an hour's slack, so a weekly run does not drift a tick later each week
	const prompts = db().prepare(`SELECT p.id, p.site_id FROM ai_prompts p JOIN sites s ON s.id = p.site_id WHERE p.active = 1 AND s.hidden = 0${o.siteId ? ' AND p.site_id = ?' : ''} ORDER BY p.id`).all(...(o.siteId ? [o.siteId] : [])) as { id: number; site_id: number }[];
	const last = db().prepare('SELECT MAX(ran_at) t FROM ai_runs WHERE prompt_id = ? AND engine = ?');
	const out: { promptId: number; engine: AiEngine; siteId: number; t: number }[] = [];
	for (const p of prompts) for (const e of engines) {
		const t = (last.get(p.id, e) as { t: number | null }).t ?? 0;
		if (t < cutoff) out.push({ promptId: p.id, engine: e, siteId: p.site_id, t });
	}
	return out.sort((a, b) => a.t - b.t).map(({ promptId, engine, siteId }) => ({ promptId, engine, siteId }));
}

/**
 * Run what is due, up to what is left of today's cap. `force` (the Run now button) re-asks everything not asked in the last hour.
 * Runs one at a time: these calls are slow (a search turn can take a minute) and are billed, so there is no hurry worth paying for.
 */
export async function runDue(o: { siteId?: number; force?: boolean; fetchImpl?: typeof fetch; ask?: (engine: AiEngine, prompt: string) => Promise<EngineResult> } = {}): Promise<{ ran: number; failed: number; leftForLater: number }> {
	const due = dueRuns(o);
	const allowed = Math.min(due.length, budgetLeft());
	let failed = 0;
	for (const d of due.slice(0, allowed)) if (!(await runPrompt(d.promptId, d.engine, o)).ok) failed++;
	if (allowed) audit('aivis.ran', { siteId: o.siteId, detail: `${allowed} run${allowed === 1 ? '' : 's'}${failed ? `, ${failed} failed` : ''}${due.length > allowed ? `; ${due.length - allowed} over today's cap` : ''}` });
	return { ran: allowed, failed, leftForLater: due.length - allowed };
}

export const aiVisDue = () => !!dueRuns().length && budgetLeft() > 0;

type RunRow = { id: number; prompt_id: number; engine: AiEngine; model: string | null; ran_at: number; status: string; error: string | null; answer: string | null; citations: string | null; verdict: string | null; searches: number };

/** Everything the AI visibility tab shows: the latest answer per prompt and assistant, the rates over the window, and the cited domains. */
export function aiVisReport(site: SiteRow, days = 30, now = Date.now()) {
	const prompts = listPrompts(site.id);
	const competitors = listCompetitors(site.id);
	const rows = db().prepare('SELECT id, prompt_id, engine, model, ran_at, status, error, answer, citations, verdict, searches FROM ai_runs WHERE site_id = ? AND ran_at >= ? ORDER BY ran_at DESC, id DESC').all(site.id, now - days * DAY) as RunRow[];
	const ok = rows.filter((r) => r.status === 'ok' && r.verdict);
	const lite = ok.map((r) => ({ engine: r.engine, promptId: r.prompt_id, verdict: JSON.parse(r.verdict!) as AnswerVerdict }));
	const latest = new Map<string, RunRow>();
	for (const r of db().prepare('SELECT id, prompt_id, engine, model, ran_at, status, error, answer, citations, verdict, searches FROM ai_runs WHERE site_id = ? ORDER BY ran_at DESC, id DESC').all(site.id) as RunRow[]) {
		const k = `${r.prompt_id}|${r.engine}`;
		if (!latest.has(k)) latest.set(k, r);
	}
	const engines = enabledEngines();
	return {
		days,
		engines,
		demo: config.demo,
		domain: hostKey(site.site_url),
		competitors,
		limits: { runsPerDay: runsPerDay(), runsToday: runsToday(now), everyDays: everyDays(), maxPrompts: MAX_PROMPTS },
		summary: summarizeRuns(lite, { domain: hostKey(site.site_url), competitors }),
		errors: rows.filter((r) => r.status === 'error').length,
		prompts: prompts.map((p) => ({
			...p,
			answers: AI_ENGINES.filter((e) => engines.includes(e) || latest.has(`${p.id}|${e}`)).map((e) => {
				const r = latest.get(`${p.id}|${e}`);
				if (!r) return { engine: e, ran: false as const };
				return { engine: e, ran: true as const, at: r.ran_at, ok: r.status === 'ok', error: r.error, model: r.model, answer: r.answer, verdict: r.verdict ? (JSON.parse(r.verdict) as AnswerVerdict) : null, citations: r.citations ? (JSON.parse(r.citations) as { url: string; title?: string | null }[]) : [] };
			})
		}))
	};
}
