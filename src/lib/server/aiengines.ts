/**
 * The AI assistants AI visibility asks, each through its own official API with web search on, so the answer is the kind a person gets
 * when they ask with search. Each adapter returns the answer text, the sources it cites, and every source it consulted.
 *
 * - Claude: the official Anthropic SDK, Messages API with the web search tool (citations come as `web_search_result_location`).
 * - ChatGPT: OpenAI's Responses API with the `web_search` tool (citations as `url_citation` annotations; every source consulted
 *   through `include: ["web_search_call.action.sources"]`).
 * - Perplexity: the Sonar API (`citations` and `search_results`).
 * - DataForSEO, as an alternative (one login instead of a key per assistant): its LLM Scraper runs the prompt in the real ChatGPT and
 *   Gemini interfaces (what people see, for a chosen location; `sources` cited, `search_results` consulted), and its LLM Responses API
 *   asks Claude and Perplexity through their APIs. Which route each assistant takes is decided by routeFor().
 *
 * The request shapes follow each provider's documentation as read on 2026-11-08; none has been run against the live services from
 * here, so expect small fixes on first contact. An API answer is not identical to what the consumer apps show (those add personal
 * context, memory and their own system prompts), so treat the results as a consistent sample, not a copy of what each user sees.
 */
import Anthropic from '@anthropic-ai/sdk';
import { config, env } from './config';
import { hostKey } from './hosts';
import type { AiAnswer, AiEngine } from '../aivis';

export interface EngineResult extends AiAnswer { model: string; searches: number; /** how the answer was obtained */ via?: EngineRoute; /** USD, when the provider reports it (DataForSEO does) */ cost?: number | null }
export class EngineError extends Error {}

const KEY_ENV: Record<AiEngine, string | null> = { claude: 'ANTHROPIC_API_KEY', chatgpt: 'OPENAI_API_KEY', perplexity: 'PERPLEXITY_API_KEY', gemini: null };
/** Models used unless set: Claude's current default model, and the models each provider's web search documentation uses. */
const MODEL_ENV: Record<AiEngine, [string, string]> = {
	claude: ['AI_VIS_CLAUDE_MODEL', 'claude-opus-5-5'],
	chatgpt: ['AI_VIS_OPENAI_MODEL', 'gpt-6-astra'],
	perplexity: ['AI_VIS_PERPLEXITY_MODEL', 'sonar'],
	gemini: ['', '']
};
export const engineKey = (e: AiEngine) => (KEY_ENV[e] ? env(KEY_ENV[e]!).trim() : '');
export const engineModel = (e: AiEngine) => (MODEL_ENV[e][0] ? env(MODEL_ENV[e][0], MODEL_ENV[e][1]).trim() || MODEL_ENV[e][1] : '');
export const KEY_ENV_NAMES = KEY_ENV;

// ── routes: direct API key, or DataForSEO ───────────────────────────────────
export type EngineRoute = 'direct' | 'dataforseo-scraper' | 'dataforseo-responses' | 'demo';
export const ROUTE_LABEL: Record<EngineRoute, string> = { direct: 'own API key', 'dataforseo-scraper': 'DataForSEO, as seen in the app', 'dataforseo-responses': 'DataForSEO, through the API', demo: 'simulated' };
export const dataForSeo = () => {
	const login = env('DATAFORSEO_LOGIN').trim(), password = env('DATAFORSEO_PASSWORD').trim();
	return login && password ? { login, password } : null;
};
const sourcePref = () => { const v = env('AI_VIS_SOURCE', 'auto').trim().toLowerCase(); return v === 'direct' || v === 'dataforseo' ? v : 'auto'; };

/**
 * How an assistant is asked, or null when it cannot be. AI_VIS_SOURCE=auto (default): ChatGPT and Gemini through DataForSEO's scraper
 * when DataForSEO is set (it shows what people see in the app; Gemini has no other route here), Claude and Perplexity through their own
 * key when there is one, else through DataForSEO's LLM Responses. AI_VIS_SOURCE=direct uses only own keys; =dataforseo only DataForSEO.
 */
export function routeFor(e: AiEngine): EngineRoute | null {
	if (config.demo) return 'demo';
	const dfs = !!dataForSeo(), key = !!engineKey(e), pref = sourcePref();
	if (pref === 'direct') return key ? 'direct' : null;
	if (e === 'chatgpt' || e === 'gemini') {
		if (dfs) return 'dataforseo-scraper';
		return pref === 'auto' && key ? 'direct' : null;
	}
	if (pref === 'dataforseo') return dfs ? 'dataforseo-responses' : null;
	return key ? 'direct' : dfs ? 'dataforseo-responses' : null;
}

/** The assistants that will be asked: those with a route, or all four as simulations in demo mode. */
export function enabledEngines(): AiEngine[] {
	return (['claude', 'chatgpt', 'gemini', 'perplexity'] as AiEngine[]).filter((e) => routeFor(e) !== null);
}

const MAX_SEARCHES = 5;
const TIMEOUT_MS = 120_000;
const dedupe = (xs: { url: string; title?: string | null }[]) => {
	const seen = new Set<string>();
	return xs.filter((x) => x.url && !seen.has(x.url) && seen.add(x.url));
};

// ── Claude ───────────────────────────────────────────────────────────────────
/**
 * One question to Claude with web search. A long search turn can pause (`pause_turn`): the paused message is sent back unchanged to
 * let it finish, a few times at most. Refusal fallbacks are on (`fallbacks: "default"`), so a declined prompt is answered by the model
 * the API routes it to; the model that answered is recorded.
 */
export async function askClaude(prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	const client = new Anthropic({ apiKey: engineKey('claude'), timeout: TIMEOUT_MS, maxRetries: 2, ...(o.fetchImpl ? { fetch: o.fetchImpl } : {}) });
	const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: prompt }];
	// Only the documented levels; anything else (including a blank line copied from .env.example) means the default.
	const e = env('AI_VIS_CLAUDE_EFFORT').trim().toLowerCase();
	const effort = (['low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? e : 'medium') as 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	let text = '';
	const citations: { url: string; title?: string | null }[] = [];
	const sources: { url: string; title?: string | null }[] = [];
	let searches = 0;
	let model = engineModel('claude');
	for (let round = 0; round < 4; round++) {
		let res: Anthropic.Beta.BetaMessage;
		try {
			res = await client.beta.messages.create({
				model: engineModel('claude'),
				max_tokens: 16000,
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
				output_config: { effort },
				tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: MAX_SEARCHES }],
				messages
			});
		} catch (e) {
			if (e instanceof Anthropic.AuthenticationError) throw new EngineError('Anthropic rejected the API key (ANTHROPIC_API_KEY).');
			if (e instanceof Anthropic.RateLimitError) throw new EngineError('Anthropic rate limit reached; it is tried again on the next run.');
			if (e instanceof Anthropic.BadRequestError) throw new EngineError(`Anthropic refused the request: ${e.message}`);
			if (e instanceof Anthropic.APIError) throw new EngineError(`Anthropic API error ${e.status ?? ''}: ${e.message}`);
			throw new EngineError(e instanceof Error ? e.message : 'Could not reach the Anthropic API.');
		}
		model = res.model;
		searches += res.usage.server_tool_use?.web_search_requests ?? 0;
		for (const b of res.content) {
			if (b.type === 'text') {
				text += b.text;
				for (const c of b.citations ?? []) if (c.type === 'web_search_result_location') citations.push({ url: c.url, title: c.title });
			} else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
				// On an error the content is a single error object, not a list (nothing to record).
				for (const r of b.content) if (r.type === 'web_search_result') sources.push({ url: r.url, title: r.title });
			}
		}
		if (res.stop_reason === 'refusal') throw new EngineError(`Claude declined to answer this prompt${res.stop_details?.category ? ` (${res.stop_details.category})` : ''}.`);
		if (res.stop_reason !== 'pause_turn') break;
		messages.push({ role: 'assistant', content: res.content }); // resume the paused turn exactly as it was
	}
	if (!text.trim()) throw new EngineError('Claude returned no answer text.');
	return { text, citations: dedupe(citations), sources: dedupe([...sources, ...citations]), model, searches };
}

// ── ChatGPT (OpenAI Responses API) ──────────────────────────────────────────
async function postJson(url: string, key: string, body: unknown, fetchImpl: typeof fetch, who: string): Promise<any> {
	let res: Response;
	try {
		res = await fetchImpl(url, { method: 'POST', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
	} catch (e) {
		throw new EngineError(e instanceof Error && e.name === 'TimeoutError' ? `${who} did not answer within ${TIMEOUT_MS / 1000} seconds.` : `Could not reach ${who}.`);
	}
	const raw = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(raw);
	} catch {
		/* reported below */
	}
	if (!res.ok) {
		const msg = json?.error?.message ?? json?.detail ?? raw.slice(0, 200);
		throw new EngineError(res.status === 401 || res.status === 403 ? `${who} rejected the API key.` : res.status === 429 ? `${who} rate limit or quota reached; it is tried again on the next run.` : `${who} answered HTTP ${res.status}: ${String(msg).slice(0, 300)}`);
	}
	if (!json) throw new EngineError(`${who} sent something that is not JSON.`);
	return json;
}

export async function askChatGpt(prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	const r = await postJson('https://api.openai.com/v1/responses', engineKey('chatgpt'), { model: engineModel('chatgpt'), input: prompt, tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] }, o.fetchImpl ?? fetch, 'OpenAI');
	let text = '';
	let searches = 0;
	const citations: { url: string; title?: string | null }[] = [];
	const sources: { url: string; title?: string | null }[] = [];
	for (const item of Array.isArray(r.output) ? r.output : []) {
		if (item?.type === 'web_search_call') {
			searches++;
			for (const s of Array.isArray(item.action?.sources) ? item.action.sources : []) if (typeof s?.url === 'string') sources.push({ url: s.url, title: s.title ?? null });
		} else if (item?.type === 'message') {
			for (const c of Array.isArray(item.content) ? item.content : []) {
				if (c?.type !== 'output_text') continue;
				text += String(c.text ?? '');
				for (const a of Array.isArray(c.annotations) ? c.annotations : []) if (a?.type === 'url_citation' && typeof a.url === 'string') citations.push({ url: a.url, title: a.title ?? null });
			}
		}
	}
	if (!text.trim()) throw new EngineError('OpenAI returned no answer text.');
	return { text, citations: dedupe(citations), sources: dedupe([...sources, ...citations]), model: String(r.model ?? engineModel('chatgpt')), searches };
}

// ── Perplexity (Sonar) ──────────────────────────────────────────────────────
export async function askPerplexity(prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	const r = await postJson('https://api.perplexity.ai/v1/sonar', engineKey('perplexity'), { model: engineModel('perplexity'), messages: [{ role: 'user', content: prompt }] }, o.fetchImpl ?? fetch, 'Perplexity');
	const text = String(r.choices?.[0]?.message?.content ?? '');
	if (!text.trim()) throw new EngineError('Perplexity returned no answer text.');
	const citations = (Array.isArray(r.citations) ? r.citations : []).filter((u: unknown) => typeof u === 'string').map((url: string) => ({ url, title: null }));
	const results = (Array.isArray(r.search_results) ? r.search_results : []).filter((s: any) => typeof s?.url === 'string').map((s: any) => ({ url: s.url as string, title: (s.title as string) ?? null }));
	// Its `citations` list is the sources behind the answer; search_results carries their titles.
	const titled = citations.map((c: { url: string }) => ({ url: c.url, title: results.find((x: { url: string }) => x.url === c.url)?.title ?? null }));
	return { text, citations: dedupe(titled), sources: dedupe([...results, ...titled]), model: String(r.model ?? engineModel('perplexity')), searches: 1 };
}

// ── demo ─────────────────────────────────────────────────────────────────────
/**
 * Demo mode: a deterministic, made-up answer per prompt and assistant, so the tab has something to show. It names the site in some
 * answers, cites it in fewer, and cites a few invented review sites and the competitors the user typed.
 */
export function demoAnswer(prompt: string, engine: AiEngine, siteUrl: string, competitors: string[], runNo = 0): EngineResult {
	const domain = hostKey(siteUrl);
	let h = 2166136261;
	for (const ch of `${engine}|${prompt}|${runNo}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	const r = (h % 1000) / 1000;
	const brand = domain.split('.')[0];
	const others = ['reviews.example', 'wikipedia.example', 'forum.example', ...competitors].slice(0, 5);
	const mention = r < (engine === 'perplexity' ? 0.6 : engine === 'claude' ? 0.45 : engine === 'gemini' ? 0.4 : 0.35);
	const cite = mention && r < (engine === 'perplexity' ? 0.45 : 0.25);
	const cited = [...others.slice(0, 2 + (h % 2)).map((d, i) => ({ url: `https://${d}/guide-${(h >> i) % 9}`, title: `${d} guide` })), ...(cite ? [{ url: `https://${domain}/guides/${brand}-overview`, title: `${brand} overview` }] : [])];
	const compNamed = competitors.filter((_, i) => (h >> (i + 3)) % 2 === 0);
	const text = `(Demo answer, not from a real assistant.) For “${prompt}”, the options most often recommended are ${[...(mention ? [brand] : []), ...compNamed.map((c) => c.split('.')[0]), 'a few generic retailers'].join(', ')}. Compare prices and read recent reviews before deciding.`;
	return { text, citations: cited, sources: [...cited, { url: `https://${others[0]}/list`, title: 'list' }], model: `demo-${engine}`, searches: 1 + (h % 3), via: 'demo', cost: null };
}

export async function askEngine(engine: AiEngine, prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	const route = routeFor(engine);
	if (route === 'dataforseo-scraper') return askDataForSeoScraper(engine as 'chatgpt' | 'gemini', prompt, o);
	if (route === 'dataforseo-responses') return askDataForSeoResponses(engine as 'claude' | 'perplexity', prompt, o);
	if (route !== 'direct') throw new EngineError(`No way to ask ${engine}: set its API key or DataForSEO.`);
	const r = engine === 'claude' ? await askClaude(prompt, o) : engine === 'chatgpt' ? await askChatGpt(prompt, o) : engine === 'perplexity' ? await askPerplexity(prompt, o) : null;
	if (!r) throw new EngineError(`${engine} can only be asked through DataForSEO.`);
	return { ...r, via: 'direct', cost: null };
}

// ── DataForSEO ──────────────────────────────────────────────────────────────
const DFS_BASE = 'https://api.dataforseo.com/v3/ai_optimization';
const num = (v: string, d: number) => (Number.isFinite(Number(v)) && v.trim() !== '' ? Number(v) : d);
/** Where the scraper asks from (DataForSEO location and language codes; 2840 = United States) and the country for API web search. */
export const dfsLocation = () => ({ location_code: num(env('AI_VIS_LOCATION_CODE'), 2840), language_code: env('AI_VIS_LANGUAGE_CODE').trim() || 'en', country: (env('AI_VIS_COUNTRY').trim() || 'US').toUpperCase() });
/** DataForSEO's own model names (its /models endpoint lists them). Claude's default is one its documentation shows in a sample answer. */
export const dfsModel = (e: 'claude' | 'perplexity') => (e === 'claude' ? env('AI_VIS_DFS_CLAUDE_MODEL').trim() || 'claude-opus-5' : env('AI_VIS_DFS_PERPLEXITY_MODEL').trim() || 'sonar');
/** ChatGPT tags its links with ?utm_source=chatgpt.com; drop tracking parameters so the same page counts once. */
export function cleanUrl(u: string): string {
	try {
		const x = new URL(u);
		for (const k of [...x.searchParams.keys()]) if (/^utm_/i.test(k)) x.searchParams.delete(k);
		return x.href;
	} catch {
		return u;
	}
}

/** One live DataForSEO task: the body is an array with one task; success is status 20000 at both the top and the task level. */
async function dfsTask(path: string, task: Record<string, unknown>, fetchImpl: typeof fetch): Promise<{ result: any; cost: number | null }> {
	const cred = dataForSeo();
	if (!cred) throw new EngineError('DataForSEO is not set (DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD).');
	let res: Response;
	try {
		res = await fetchImpl(`${DFS_BASE}/${path}`, { method: 'POST', signal: AbortSignal.timeout(150_000), headers: { authorization: `Basic ${Buffer.from(`${cred.login}:${cred.password}`).toString('base64')}`, 'content-type': 'application/json' }, body: JSON.stringify([task]) });
	} catch (e) {
		throw new EngineError(e instanceof Error && e.name === 'TimeoutError' ? 'DataForSEO did not answer within 150 seconds.' : 'Could not reach DataForSEO.');
	}
	let json: any = null;
	try {
		json = await res.json();
	} catch {
		/* reported below */
	}
	if (res.status === 401 || res.status === 403) throw new EngineError('DataForSEO rejected the login (DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD).');
	if (!res.ok || !json) throw new EngineError(`DataForSEO answered HTTP ${res.status}${json?.status_message ? `: ${json.status_message}` : ''}.`);
	if (json.status_code !== 20000) throw new EngineError(`DataForSEO: ${json.status_message ?? `status ${json.status_code}`}.`);
	const t = json.tasks?.[0];
	if (!t || t.status_code !== 20000) throw new EngineError(`DataForSEO: ${t?.status_message ?? 'no task in the answer'}${t?.status_code ? ` (${t.status_code})` : ''}.`);
	const result = t.result?.[0];
	if (!result) throw new EngineError('DataForSEO returned no result for this prompt.');
	return { result, cost: typeof t.cost === 'number' ? t.cost : null };
}

/** ChatGPT or Gemini as people see them in the app, through DataForSEO's LLM Scraper. */
export async function askDataForSeoScraper(engine: 'chatgpt' | 'gemini', prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	const loc = dfsLocation();
	const { result: r, cost } = await dfsTask(`${engine === 'chatgpt' ? 'chat_gpt' : 'gemini'}/llm_scraper/live/advanced`, { keyword: prompt, location_code: loc.location_code, language_code: loc.language_code }, o.fetchImpl ?? fetch);
	const text = String(r.markdown ?? '');
	if (!text.trim()) throw new EngineError(`DataForSEO returned no ${engine === 'chatgpt' ? 'ChatGPT' : 'Gemini'} answer text.`);
	const pick = (xs: unknown) => (Array.isArray(xs) ? xs : []).filter((x: any) => typeof x?.url === 'string').map((x: any) => ({ url: cleanUrl(x.url), title: x.title ?? null }));
	const citations = dedupe(pick(r.sources));
	const searched = pick(r.search_results); // ChatGPT only: everything it looked at, used or not
	return { text, citations, sources: dedupe([...searched, ...citations]), model: String(r.model ?? engine), searches: searched.length ? 1 : 0, via: 'dataforseo-scraper', cost };
}

/** Claude or Perplexity through their APIs, by way of DataForSEO's LLM Responses API (web search on for Claude; Sonar searches by itself). */
export async function askDataForSeoResponses(engine: 'claude' | 'perplexity', prompt: string, o: { fetchImpl?: typeof fetch } = {}): Promise<EngineResult> {
	if (prompt.length > 500) throw new EngineError('DataForSEO takes prompts of up to 500 characters.');
	const loc = dfsLocation();
	const task: Record<string, unknown> = { user_prompt: prompt, model_name: dfsModel(engine), web_search_country_iso_code: loc.country };
	if (engine === 'claude') task.web_search = true;
	const { result: r, cost } = await dfsTask(`${engine}/llm_responses/live`, task, o.fetchImpl ?? fetch);
	let text = '';
	const citations: { url: string; title?: string | null }[] = [];
	for (const item of Array.isArray(r.items) ? r.items : []) {
		if (item?.type !== 'message') continue;
		for (const sec of Array.isArray(item.sections) ? item.sections : []) {
			if (sec?.type !== 'text') continue;
			text += String(sec.text ?? '');
			// annotations is null without web search, and may be empty with it
			for (const a of Array.isArray(sec.annotations) ? sec.annotations : []) if (typeof a?.url === 'string') citations.push({ url: cleanUrl(a.url), title: a.title ?? null });
		}
	}
	if (!text.trim()) throw new EngineError(`DataForSEO returned no ${engine === 'claude' ? 'Claude' : 'Perplexity'} answer text.`);
	const searched = (Array.isArray(r.search_results) ? r.search_results : []).filter((x: any) => typeof x?.url === 'string').map((x: any) => ({ url: cleanUrl(x.url), title: x.title ?? null }));
	return { text, citations: dedupe(citations), sources: dedupe([...searched, ...citations]), model: String(r.model_name ?? dfsModel(engine)), searches: r.web_search ? 1 : 0, via: 'dataforseo-responses', cost };
}
