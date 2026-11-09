import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { analyzeAnswer, brandWords, mentions, normalizeDomain, summarizeRuns, type AiEngine } from '../src/lib/aivis';
import { askChatGpt, askClaude, askDataForSeoResponses, askDataForSeoScraper, askEngine, askPerplexity, cleanUrl, demoAnswer, enabledEngines, EngineError, routeFor, type EngineResult } from '../src/lib/server/aiengines';
import { addPrompts, aiVisReport, budgetLeft, deletePrompt, dueRuns, listPrompts, runDue, runPrompt, setCompetitors } from '../src/lib/server/aivis';

describe('judging one answer', () => {
	const a = (text: string, cites: string[] = [], sources: string[] = []) => ({ text, citations: cites.map((url) => ({ url })), sources: sources.map((url) => ({ url })) });
	it('a mention is the brand or the domain as a whole word, any case', () => {
		expect(mentions('Try Greenleaf for tools.', 'greenleaf')).toBe(true);
		expect(mentions('Greenleafy gardens', 'greenleaf')).toBe(false);
		expect(mentions("Greenleaf's range", 'greenleaf')).toBe(true);
		expect(analyzeAnswer(a('See greenleaf.example for more.'), { domain: 'greenleaf.example', brandTerms: ['zzz'] }).mentioned).toBe(true);
		expect(brandWords('abc.com')).toEqual(['abc.com']); // a 3-letter label is not used on its own
		expect(brandWords('greenleaf.example')).toEqual(['greenleaf.example', 'greenleaf']);
	});
	it('a citation is any page on the domain or a subdomain; its rank is among distinct cited domains', () => {
		const v = analyzeAnswer(a('x', ['https://reviews.example/a', 'https://reviews.example/b', 'https://shop.greenleaf.example/p', 'https://www.greenleaf.example/q', 'https://notgreenleaf.example/']), { domain: 'https://www.GreenLeaf.example/' });
		expect(v.cited).toBe(true);
		expect(v.ourCitations).toEqual(['https://shop.greenleaf.example/p', 'https://www.greenleaf.example/q']);
		expect(v.citedDomains).toEqual(['reviews.example', 'shop.greenleaf.example', 'greenleaf.example', 'notgreenleaf.example']);
		expect(v.position).toBe(2);
		const none = analyzeAnswer(a('x', ['https://notgreenleaf.example/'], ['https://greenleaf.example/seen']), { domain: 'greenleaf.example' });
		expect(none.cited).toBe(false);
		expect(none.position).toBeNull();
		expect(none.inSources).toBe(true); // looked at, not cited
	});
	it('competitors: mentioned by name or cited; the site itself is never its own competitor', () => {
		const v = analyzeAnswer(a('Acme and Rival are popular.', ['https://www.rival.com/x']), { domain: 'greenleaf.example', competitors: ['https://acme.com', 'rival.com', 'greenleaf.example', 'other.io'] });
		expect(v.competitorsMentioned).toEqual(['acme.com', 'rival.com']);
		expect(v.competitorsCited).toEqual(['rival.com']);
		expect(normalizeDomain(' HTTPS://WWW.Acme.com/path ')).toBe('acme.com');
	});
	it('summary: rates per assistant, share of voice, most-cited domains', () => {
		const v = (o: Partial<ReturnType<typeof analyzeAnswer>>) => ({ mentioned: false, cited: false, ourCitations: [], citedDomains: [], position: null, inSources: false, competitorsMentioned: [], competitorsCited: [], ...o });
		const runs = [
			{ engine: 'claude' as AiEngine, promptId: 1, verdict: v({ mentioned: true, cited: true, position: 1, citedDomains: ['me.com', 'x.com'] }) },
			{ engine: 'claude' as AiEngine, promptId: 2, verdict: v({ citedDomains: ['x.com'], competitorsCited: ['rival.com'] }) },
			{ engine: 'perplexity' as AiEngine, promptId: 1, verdict: v({ mentioned: true, position: 3, cited: true, citedDomains: ['x.com', 'y.com', 'me.com'] }) }
		];
		const s = summarizeRuns(runs, { domain: 'me.com', competitors: ['rival.com'] });
		expect(s.byEngine).toEqual([
			{ engine: 'claude', runs: 2, mentionRate: 0.5, citationRate: 0.5, avgPosition: 1 },
			{ engine: 'perplexity', runs: 1, mentionRate: 1, citationRate: 1, avgPosition: 3 }
		]);
		expect(s.voice[0]).toEqual({ domain: 'me.com', ours: true, mentionShare: 2 / 3, citationShare: 2 / 3 });
		expect(s.voice[1]).toEqual({ domain: 'rival.com', ours: false, mentionShare: 0, citationShare: 1 / 3 });
		expect(s.topCited[0]).toEqual({ domain: 'x.com', answers: 3, ours: false, competitor: false });
		expect(s.topCited.find((t) => t.domain === 'me.com')?.ours).toBe(true);
	});
});

// ── the three adapters, against fakes shaped like each provider's documented responses ──
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
type Seen = { url: string; headers: Headers; body: any };
const fakeFetch = (replies: Response[], seen: Seen[]) => (async (url: RequestInfo | URL, init?: RequestInit) => {
	seen.push({ url: String(url), headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
	const r = replies.shift();
	if (!r) throw new Error('no more replies');
	return r;
}) as typeof fetch;
process.env.DEMO_MODE = '1'; // the scheduling tests below run in demo mode (all three assistants, no keys)
const env0 = { ...process.env };
afterEach(() => { process.env = { ...env0 }; });

describe('Claude, through the Anthropic SDK', () => {
	const msg = (content: unknown[], stop = 'end_turn', o: object = {}) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } }, ...o });
	const search = { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'garden tools' } };
	const results = { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://reviews.example/best', title: 'Best tools', encrypted_content: 'x', page_age: null }, { type: 'web_search_result', url: 'https://greenleaf.example/seen', title: 'GL', encrypted_content: 'y', page_age: null }] };
	it('sends web search with refusal fallbacks, resumes a paused turn, and collects text, citations and sources', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
		process.env.AI_VIS_CLAUDE_EFFORT = '';
		process.env.AI_VIS_CLAUDE_MODEL = '';
		const seen: Seen[] = [];
		const r = await askClaude('best garden tools?', { fetchImpl: fakeFetch([
			json(msg([search, results], 'pause_turn')),
			json(msg([{ type: 'text', text: 'Greenleaf is a good pick.', citations: [{ type: 'web_search_result_location', url: 'https://reviews.example/best', title: 'Best tools', encrypted_index: 'e', cited_text: 'x' }] }], 'end_turn', { model: 'claude-opus-5-5' }))
		], seen) });
		expect(seen).toHaveLength(2);
		expect(seen[0].url.replace(/\?.*$/, '')).toBe('https://api.anthropic.com/v1/messages');
		expect(seen[0].headers.get('x-api-key') ?? seen[0].headers.get('authorization')).toMatch(/^(Bearer )?sk-ant-test$/); // SDK 1.6 sends it as a bearer token
		expect(seen[0].headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
		expect(seen[0].body.output_config).toEqual({ effort: 'medium' }); // AI_VIS_CLAUDE_EFFORT unset or blank
		expect(seen[0].body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 5 }], messages: [{ role: 'user', content: 'best garden tools?' }] });
		expect(seen[1].body.messages[1]).toEqual({ role: 'assistant', content: [search, results] }); // the paused turn, sent back unchanged
		expect(r.text).toBe('Greenleaf is a good pick.');
		expect(r.citations).toEqual([{ url: 'https://reviews.example/best', title: 'Best tools' }]);
		expect(r.sources.map((s) => s.url)).toEqual(['https://reviews.example/best', 'https://greenleaf.example/seen']);
		expect(r.searches).toBe(2);
	});
	it('a refusal and a rejected key become readable errors', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
		await expect(askClaude('q', { fetchImpl: fakeFetch([json(msg([], 'refusal', { stop_details: { type: 'refusal', category: 'cyber', explanation: null } }))], []) })).rejects.toThrow(/declined to answer this prompt \(cyber\)/);
		await expect(askClaude('q', { fetchImpl: fakeFetch([json({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401)], []) })).rejects.toThrow(/rejected the API key/);
		// a search error comes back as HTTP 200 with an error object instead of a result list: nothing to record, no crash
		const r = await askClaude('q', { fetchImpl: fakeFetch([json(msg([search, { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } }, { type: 'text', text: 'From memory: try Acme.' }]))], []) });
		expect(r.sources).toEqual([]);
	});
});

describe('ChatGPT (Responses API) and Perplexity (Sonar)', () => {
	it('ChatGPT: web_search tool, every source consulted, url_citation annotations', async () => {
		process.env.OPENAI_API_KEY = 'sk-test';
		const seen: Seen[] = [];
		const r = await askChatGpt('best garden tools?', { fetchImpl: fakeFetch([json({ model: 'gpt-6-astra', output: [
			{ type: 'web_search_call', id: 'ws_1', status: 'completed', action: { type: 'search', query: 'garden tools', sources: [{ type: 'url', url: 'https://reviews.example/best' }, { type: 'url', url: 'https://other.example/' }] } },
			{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Try Greenleaf.', annotations: [{ type: 'url_citation', start_index: 4, end_index: 13, url: 'https://greenleaf.example/tools', title: 'Greenleaf' }] }] }
		] })], seen) });
		expect(seen[0].url).toBe('https://api.openai.com/v1/responses');
		expect(seen[0].headers.get('authorization')).toBe('Bearer sk-test');
		expect(seen[0].body).toEqual({ model: 'gpt-6-astra', input: 'best garden tools?', tools: [{ type: 'web_search' }], include: ['web_search_call.action.sources'] });
		expect(r.text).toBe('Try Greenleaf.');
		expect(r.citations).toEqual([{ url: 'https://greenleaf.example/tools', title: 'Greenleaf' }]);
		expect(r.sources.map((s) => s.url)).toEqual(['https://reviews.example/best', 'https://other.example/', 'https://greenleaf.example/tools']);
		await expect(askChatGpt('q', { fetchImpl: fakeFetch([json({ error: { message: 'quota' } }, 429)], []) })).rejects.toThrow(/rate limit or quota/);
	});
	it('Perplexity: citations with titles from search_results', async () => {
		process.env.PERPLEXITY_API_KEY = 'pplx-test';
		const seen: Seen[] = [];
		const r = await askPerplexity('q', { fetchImpl: fakeFetch([json({ model: 'sonar', choices: [{ message: { role: 'assistant', content: 'Acme [1]' } }], citations: ['https://acme.com/a'], search_results: [{ title: 'Acme', url: 'https://acme.com/a', date: '2026-10-01' }, { title: 'Other', url: 'https://o.example/' }] })], seen) });
		expect(seen[0].url).toBe('https://api.perplexity.ai/v1/sonar');
		expect(seen[0].body).toEqual({ model: 'sonar', messages: [{ role: 'user', content: 'q' }] });
		expect(r.citations).toEqual([{ url: 'https://acme.com/a', title: 'Acme' }]);
		expect(r.sources.map((s) => s.url)).toEqual(['https://acme.com/a', 'https://o.example/']);
		await expect(askPerplexity('q', { fetchImpl: fakeFetch([json({}, 401)], []) })).rejects.toBeInstanceOf(EngineError);
	});
});

describe('prompts, the daily cap and the schedule', () => {
	beforeAll(async () => {
		process.env.DEMO_MODE = '1';
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		await ensureDemoAccounts();
	});
	const fakeAsk = (calls: string[], fail = false) => async (engine: AiEngine, prompt: string): Promise<EngineResult> => {
		calls.push(`${engine}:${prompt}`);
		if (fail) throw new EngineError('OpenAI rejected the API key.');
		return { text: 'Greenleaf and Acme are both fine.', citations: [{ url: 'https://acme.com/x' }, { url: 'https://greenleaf.example/y' }], sources: [], model: 'm', searches: 1 };
	};
	it('adds prompts one per line, skipping blanks, duplicates and over-long lines', () => {
		const r = addPrompts(1, 'best garden tools\n\nbest garden tools\nab\n' + 'x'.repeat(600) + '\nis greenleaf good?');
		expect(r.added).toBe(2);
		expect(r.skipped).toHaveLength(3);
		expect(listPrompts(1).map((p) => p.prompt)).toEqual(['best garden tools', 'is greenleaf good?']);
	});
	it('competitors are normalised domains, never the site itself', () => {
		expect(setCompetitors(getSite(1)!, 'https://www.Acme.com/, greenleaf.example\nnot a domain, rival.io')).toEqual(['acme.com', 'rival.io']);
	});
	it('runs each prompt on each assistant, judges and stores the answer, and is not due again until the interval passes', async () => {
		const calls: string[] = [];
		const r = await runDue({ ask: fakeAsk(calls) });
		expect(r.ran).toBe(8); // 2 prompts x 4 assistants (all four in demo mode)
		expect(new Set(calls).size).toBe(8);
		expect(dueRuns()).toEqual([]);
		expect(dueRuns({ now: Date.now() + 8 * 86_400_000 })).toHaveLength(8);
		const rep = aiVisReport(getSite(1)!);
		expect(rep.summary.byEngine.every((e) => e.mentionRate === 1 && e.citationRate === 1 && e.avgPosition === 2)).toBe(true);
		expect(rep.summary.voice.find((v) => v.domain === 'acme.com')).toMatchObject({ mentionShare: 1, citationShare: 1 });
		expect(rep.prompts[0].answers.every((a) => a.ran && a.ok && a.verdict?.cited)).toBe(true);
	});
	it('a failure is stored with its reason and does not stop the rest', async () => {
		const id = listPrompts(1)[0].id;
		expect(await runPrompt(id, 'chatgpt', { ask: fakeAsk([], true) })).toEqual({ ok: false, error: 'OpenAI rejected the API key.' });
		const a = aiVisReport(getSite(1)!).prompts[0].answers.find((x) => x.engine === 'chatgpt')!;
		expect(a.ran && !a.ok && a.error).toBe('OpenAI rejected the API key.');
	});
	it('each answer records how it was obtained and what DataForSEO charged', async () => {
		const id = listPrompts(1)[0].id;
		await runPrompt(id, 'gemini', { ask: async () => ({ text: 'Greenleaf.', citations: [], sources: [], model: 'Fast', searches: 0, via: 'dataforseo-scraper', cost: 0.0042 }) });
		const a = aiVisReport(getSite(1)!).prompts[0].answers.find((x) => x.engine === 'gemini')!;
		expect(a.ran && a.via).toBe('dataforseo-scraper');
		expect(a.ran && a.cost).toBe(0.0042);
		expect(aiVisReport(getSite(1)!).reportedCost).toBeCloseTo(0.0042, 6);
	});

	it('never runs past the daily cap', async () => {
		process.env.AI_VIS_RUNS_PER_DAY = '12';
		expect(budgetLeft()).toBe(2); // 10 runs so far today
		const calls: string[] = [];
		const r = await runDue({ force: true, now: Date.now() + 2 * 3600_000, ask: fakeAsk(calls) } as never);
		expect(r.ran).toBe(2);
		expect(r.leftForLater).toBeGreaterThan(0);
		expect(budgetLeft()).toBe(0);
		expect((await runDue({ force: true, ask: fakeAsk(calls) })).ran).toBe(0);
	});
	it('demo answers are deterministic and say they are not real', () => {
		const a = demoAnswer('best tools', 'claude', 'sc-domain:greenleaf.example', ['acme.com']);
		expect(a).toEqual(demoAnswer('best tools', 'claude', 'sc-domain:greenleaf.example', ['acme.com']));
		expect(a.text).toMatch(/^\(Demo answer, not from a real assistant\.\)/);
	});
	it('removing a prompt removes its answers', () => {
		const id = listPrompts(1)[0].id;
		expect(deletePrompt(1, id)).toBe(true);
		expect((db().prepare('SELECT COUNT(*) n FROM ai_runs WHERE prompt_id = ?').get(id) as { n: number }).n).toBe(0);
		expect(deletePrompt(2, listPrompts(1)[0].id)).toBe(false); // another site's prompt id
	});
});

// ── DataForSEO, against fakes shaped like its documented responses ──
describe('DataForSEO as the alternative route', () => {
	const env1 = () => {
		process.env = { ...env0 };
		delete process.env.DEMO_MODE;
		for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'PERPLEXITY_API_KEY', 'DATAFORSEO_LOGIN', 'DATAFORSEO_PASSWORD', 'AI_VIS_SOURCE']) delete process.env[k];
	};
	const ok = (result: unknown, cost = 0.004) => json({ version: '0.1', status_code: 20000, status_message: 'Ok.', tasks_count: 1, tasks_error: 0, tasks: [{ id: 't1', status_code: 20000, status_message: 'Ok.', cost, result_count: 1, result: [result] }] });

	it('routes: DataForSEO scrapes ChatGPT and Gemini; Claude and Perplexity keep their own key; AI_VIS_SOURCE overrides', () => {
		env1();
		expect(enabledEngines()).toEqual([]);
		process.env.ANTHROPIC_API_KEY = 'k';
		process.env.OPENAI_API_KEY = 'k';
		expect([routeFor('claude'), routeFor('chatgpt'), routeFor('gemini'), routeFor('perplexity')]).toEqual(['direct', 'direct', null, null]);
		process.env.DATAFORSEO_LOGIN = 'me@example.com';
		process.env.DATAFORSEO_PASSWORD = 'pw';
		expect([routeFor('claude'), routeFor('chatgpt'), routeFor('gemini'), routeFor('perplexity')]).toEqual(['direct', 'dataforseo-scraper', 'dataforseo-scraper', 'dataforseo-responses']);
		expect(enabledEngines()).toEqual(['claude', 'chatgpt', 'gemini', 'perplexity']);
		process.env.AI_VIS_SOURCE = 'dataforseo';
		expect(routeFor('claude')).toBe('dataforseo-responses');
		process.env.AI_VIS_SOURCE = 'direct';
		expect([routeFor('claude'), routeFor('chatgpt'), routeFor('gemini'), routeFor('perplexity')]).toEqual(['direct', 'direct', null, null]);
		process.env.DATAFORSEO_PASSWORD = '';
		process.env.AI_VIS_SOURCE = 'auto';
		expect(routeFor('gemini')).toBeNull(); // a login without a password is not set up
	});

	it('the ChatGPT scraper: Basic auth, one task in an array, location; cited sources and every search result; tracking parameters dropped', async () => {
		env1();
		process.env.DATAFORSEO_LOGIN = 'me@example.com';
		process.env.DATAFORSEO_PASSWORD = 'pw';
		const seen: Seen[] = [];
		const r = await askEngine('chatgpt', 'best garden tools?', { fetchImpl: fakeFetch([ok({ keyword: 'best garden tools?', model: 'gpt-4o', markdown: 'Greenleaf is popular.', sources: [{ type: 'chat_gpt_source', title: 'GL', domain: 'greenleaf.example', url: 'https://greenleaf.example/tools?utm_source=chatgpt.com' }], search_results: [{ type: 'chatgpt_search_result', url: 'https://reviews.example/a', domain: 'reviews.example', title: 'R' }], brand_entities: [] })], seen) });
		expect(seen[0].url).toBe('https://api.dataforseo.com/v3/ai_optimization/chat_gpt/llm_scraper/live/advanced');
		expect(seen[0].headers.get('authorization')).toBe('Basic ' + Buffer.from('me@example.com:pw').toString('base64'));
		expect(seen[0].body).toEqual([{ keyword: 'best garden tools?', location_code: 2840, language_code: 'en' }]);
		expect(r).toMatchObject({ text: 'Greenleaf is popular.', model: 'gpt-4o', via: 'dataforseo-scraper', cost: 0.004 });
		expect(r.citations).toEqual([{ url: 'https://greenleaf.example/tools', title: 'GL' }]);
		expect(r.sources.map((x) => x.url)).toEqual(['https://reviews.example/a', 'https://greenleaf.example/tools']);
	});

	it('the Gemini scraper, with the location from the settings', async () => {
		env1();
		process.env.DATAFORSEO_LOGIN = 'a';
		process.env.DATAFORSEO_PASSWORD = 'b';
		process.env.AI_VIS_LOCATION_CODE = '2826';
		process.env.AI_VIS_LANGUAGE_CODE = 'en';
		const seen: Seen[] = [];
		const r = await askDataForSeoScraper('gemini', 'q', { fetchImpl: fakeFetch([ok({ model: 'Fast', markdown: 'Try Acme.', sources: [{ type: 'gemini_source', title: 'Acme', domain: 'acme.com', url: 'https://acme.com/x' }] })], seen) });
		expect(seen[0].url).toBe('https://api.dataforseo.com/v3/ai_optimization/gemini/llm_scraper/live/advanced');
		expect(seen[0].body).toEqual([{ keyword: 'q', location_code: 2826, language_code: 'en' }]);
		expect(r.citations).toEqual([{ url: 'https://acme.com/x', title: 'Acme' }]);
		expect(r.searches).toBe(0); // Gemini reports no search results list
	});

	it('LLM Responses for Claude (web search on) and Perplexity: text and annotations from message sections', async () => {
		env1();
		process.env.DATAFORSEO_LOGIN = 'a';
		process.env.DATAFORSEO_PASSWORD = 'b';
		const result = (model: string) => ({ model_name: model, web_search: true, money_spent: 0.5, items: [{ type: 'reasoning' }, { type: 'message', sections: [{ type: 'text', text: 'Greenleaf ', annotations: [{ title: 'GL', url: 'https://greenleaf.example/a', start_index: null, end_index: null, text: null }] }, { type: 'text', text: 'and Acme.', annotations: null }] }], search_results: [{ title: 'R', url: 'https://reviews.example/r', date: null, snippet: '' }] });
		const seen: Seen[] = [];
		const c = await askDataForSeoResponses('claude', 'q', { fetchImpl: fakeFetch([ok(result('claude-opus-5'), 0.55)], seen) });
		expect(seen[0].url).toBe('https://api.dataforseo.com/v3/ai_optimization/claude/llm_responses/live');
		expect(seen[0].body).toEqual([{ user_prompt: 'q', model_name: 'claude-opus-5', web_search_country_iso_code: 'US', web_search: true }]);
		expect(c).toMatchObject({ text: 'Greenleaf and Acme.', model: 'claude-opus-5', via: 'dataforseo-responses', cost: 0.55, searches: 1 });
		expect(c.citations).toEqual([{ url: 'https://greenleaf.example/a', title: 'GL' }]);
		expect(c.sources.map((x) => x.url)).toEqual(['https://reviews.example/r', 'https://greenleaf.example/a']);
		const p = await askDataForSeoResponses('perplexity', 'q', { fetchImpl: fakeFetch([ok(result('sonar'))], seen) });
		expect(seen[1].url).toBe('https://api.dataforseo.com/v3/ai_optimization/perplexity/llm_responses/live');
		expect(seen[1].body).toEqual([{ user_prompt: 'q', model_name: 'sonar', web_search_country_iso_code: 'US' }]); // no web_search field: Sonar searches by itself
		expect(p.text).toBe('Greenleaf and Acme.');
		await expect(askDataForSeoResponses('claude', 'x'.repeat(501), { fetchImpl: fakeFetch([], []) })).rejects.toThrow(/500 characters/);
	});

	it('errors: bad login, a task-level error inside HTTP 200, no credentials', async () => {
		env1();
		await expect(askDataForSeoScraper('chatgpt', 'q', { fetchImpl: fakeFetch([], []) })).rejects.toThrow(/not set/);
		process.env.DATAFORSEO_LOGIN = 'a';
		process.env.DATAFORSEO_PASSWORD = 'b';
		await expect(askDataForSeoScraper('chatgpt', 'q', { fetchImpl: fakeFetch([json({ status_code: 40100, status_message: 'You are not authorized.' }, 401)], []) })).rejects.toThrow(/rejected the login/);
		await expect(askDataForSeoScraper('chatgpt', 'q', { fetchImpl: fakeFetch([json({ status_code: 20000, status_message: 'Ok.', tasks: [{ status_code: 40501, status_message: 'Invalid Field: keyword.', result: null }] })], []) })).rejects.toThrow(/Invalid Field: keyword\. \(40501\)/);
		await expect(askDataForSeoScraper('chatgpt', 'q', { fetchImpl: fakeFetch([json({ status_code: 40200, status_message: 'Payment Required.' }, 402)], []) })).rejects.toThrow(/HTTP 402: Payment Required/);
		expect(cleanUrl('https://x.com/a?utm_source=chatgpt.com&id=3')).toBe('https://x.com/a?id=3');
	});
});

describe('an AI answers table from before DataForSEO', () => {
	it('gains the route and cost columns when the database is opened', () => {
		const Database = require('better-sqlite3');
		const { mkdtempSync } = require('node:fs');
		const { join } = require('node:path');
		const { tmpdir } = require('node:os');
		const file = join(mkdtempSync(join(tmpdir(), 'aivis-')), 'old.db');
		const old = new Database(file);
		old.exec('CREATE TABLE ai_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt_id INTEGER NOT NULL, site_id INTEGER NOT NULL, engine TEXT NOT NULL, model TEXT, ran_at INTEGER NOT NULL, status TEXT NOT NULL, error TEXT, answer TEXT, citations TEXT, sources TEXT, verdict TEXT, searches INTEGER NOT NULL DEFAULT 0)');
		old.close();
		const d = openDb(file);
		const cols = (d.prepare('PRAGMA table_info(ai_runs)').all() as { name: string }[]).map((c) => c.name);
		expect(cols).toEqual(expect.arrayContaining(['via', 'cost']));
		d.close();
	});
});
