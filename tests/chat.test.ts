import { beforeEach, describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { resetRateLimits, resetWriteLimits } from '../src/lib/server/mcp';
import { buildParams, chatTools, displayItems, getThread, listThreads, pendingOf, runTurn, threadMessages, type ModelCall } from '../src/lib/server/chat';
import { OWNER, accessRefusal, requiredRole, type CurrentUser } from '../src/lib/server/roles';
import { toolLabel, validateChart, type ChatEvent } from '../src/lib/chat';
import { renderMarkdown } from '../src/lib/markdown';

type Msg = Anthropic.Beta.BetaMessage;
const msg = (content: unknown[], stop: Msg['stop_reason'] = 'end_turn'): Msg => ({ id: 'm', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage: {} } as unknown as Msg);
const text = (t: string) => ({ type: 'text', text: t, citations: null });
const use = (id: string, name: string, input: Record<string, unknown> = {}) => ({ type: 'tool_use', id, name, input });

/** A scripted model: returns the given messages in turn and records every request. */
function script(...replies: Msg[]) {
	const seen: BetaMessageStreamParams[] = [];
	const call: ModelCall = async (params, o) => {
		seen.push(structuredClone(params));
		const r = replies.shift();
		if (!r) throw new Error('script ran out');
		for (const b of r.content) if (b.type === 'text') o.onText(b.text);
		return r;
	};
	return { call, seen };
}
async function turn(u: CurrentUser, input: Parameters<typeof runTurn>[1], call: ModelCall) {
	const events: ChatEvent[] = [];
	await runTurn(u, input, (e) => events.push(e), { call, now: '2026-11-09' });
	return events;
}
const lastUser = (p: BetaMessageStreamParams) => p.messages[p.messages.length - 1];
const member = (role: 'admin' | 'editor' | 'viewer', siteIds: number[] | null = null): CurrentUser => {
	const id = Number(db().prepare('INSERT INTO users (email, name, password_hash, role, site_ids, created_at, disabled) VALUES (?,?,?,?,?,?,0)').run(`${role}${Math.random()}@x.example`, role, 'x', role, siteIds ? JSON.stringify(siteIds) : null, Date.now()).lastInsertRowid);
	return { id, email: null, name: role, role, siteIds };
};

beforeEach(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	process.env.ANTHROPIC_API_KEY = 'sk-test';
	delete process.env.CHAT_MODEL;
	delete process.env.CHAT_EFFORT;
	delete process.env.CHAT_MESSAGES_PER_DAY;
	delete process.env.READ_ONLY;
	await ensureDemoAccounts();
	resetRateLimits();
	resetWriteLimits();
});

describe('the request sent to Claude', () => {
	it('uses the default model and effort, refusal fallbacks, and caches the tools and the conversation', () => {
		const p = buildParams(OWNER, [{ role: 'user', content: 'hi' }]);
		expect(p.model).toBe('claude-opus-5-5');
		expect(p.output_config).toEqual({ effort: 'medium' });
		expect(p.fallbacks).toBe('default');
		expect(p.betas).toEqual(['server-side-fallback-2026-07-01']);
		expect(p.cache_control).toEqual({ type: 'ephemeral' });
		const tools = p.tools as Anthropic.Beta.BetaTool[];
		expect(tools.filter((t) => t.cache_control).map((t) => t.name)).toEqual(['show_chart']);
		expect(typeof p.system === 'string' && /third-party text/.test(p.system)).toBe(true);
		expect(JSON.stringify(p.system)).not.toMatch(/2026|Today/); // nothing that changes per request, or the cache breaks
		process.env.CHAT_MODEL = 'claude-sonnet-5-5';
		process.env.CHAT_EFFORT = 'bogus';
		expect(buildParams(OWNER, []).model).toBe('claude-sonnet-5-5');
		expect(buildParams(OWNER, []).output_config).toEqual({ effort: 'medium' });
	});

	it('offers each person only the tools their role allows, in a stable order', () => {
		const names = (u: CurrentUser) => chatTools(u).map((t) => t.name);
		expect(names(member('viewer'))).not.toContain('mark_action');
		expect(names(member('viewer'))).toContain('get_quick_wins');
		expect(names(member('editor'))).toContain('mark_action');
		expect(names(member('editor'))).not.toContain('set_brand_terms'); // the app keeps brand terms for admins
		expect(names(member('admin'))).toContain('set_brand_terms');
		expect(names(OWNER)).toEqual(names(OWNER));
	});
});

describe('a turn', () => {
	it('streams the answer, starts a conversation, and stores it with the date as context the page does not show', async () => {
		const s = script(msg([text('Hello! **3** sites.')]));
		const ev = await turn(OWNER, { threadId: null, text: 'How many sites?' }, s.call);
		expect(ev[0]).toMatchObject({ type: 'thread', title: 'How many sites?' });
		expect(ev.filter((e) => e.type === 'text').map((e) => (e as { text: string }).text).join('')).toBe('Hello! **3** sites.');
		expect(ev[ev.length - 1]).toEqual({ type: 'done' });
		expect(JSON.stringify(lastUser(s.seen[0]).content)).toMatch(/Today is 2026-11-09/);
		const id = (ev[0] as { id: number }).id;
		expect(displayItems(threadMessages(id))).toEqual([{ kind: 'user', text: 'How many sites?' }, { kind: 'text', text: 'Hello! **3** sites.' }]);
		expect(listThreads(OWNER).map((t) => t.id)).toEqual([id]);
	});

	it('runs read tools through the MCP tool layer and sends the results back, in call order', async () => {
		const s = script(msg([use('a', 'list_sites'), use('b', 'get_connections')], 'tool_use'), msg([text('You have 3 sites.')]));
		const ev = await turn(OWNER, { threadId: null, text: 'What do I have?' }, s.call);
		const tools = ev.filter((e) => e.type === 'tool').map((e) => (e as { tool: { id: string; status: string } }).tool);
		expect(tools.filter((t) => t.status === 'done').map((t) => t.id).sort()).toEqual(['a', 'b']);
		const results = lastUser(s.seen[1]).content as Anthropic.Beta.BetaToolResultBlockParam[];
		expect(results.map((r) => r.tool_use_id)).toEqual(['a', 'b']);
		expect(String(results[0].content)).toMatch(/greenleaf/);
	});

	it('only ever reaches the sites of a person limited to some sites', async () => {
		const u = member('viewer', [1]);
		const s = script(msg([use('a', 'list_sites')], 'tool_use'), msg([text('ok')]));
		await turn(u, { threadId: null, text: 'sites?' }, s.call);
		const sites = JSON.parse(String((lastUser(s.seen[1]).content as Anthropic.Beta.BetaToolResultBlockParam[])[0].content)) as { id: number }[];
		expect(sites.map((x) => x.id)).toEqual([1]);
		expect(accessRefusal(u, 'POST', new URL('http://x/chat/stream'))).toBeNull();
		expect(accessRefusal(u, 'GET', new URL('http://x/chat'))).toBeNull();
		expect(requiredRole('POST', new URL('http://x/chat/stream'))).toBe('viewer');
	});

	it('stops before any change and runs it only when approved; a declined change is reported back', async () => {
		const u = member('editor');
		const s = script(
			msg([text('I will log it.'), use('w1', 'log_change', { site: 1, date: '2026-11-01', title: 'New titles' }), use('w2', 'log_change', { site: 1, date: '2026-11-02', title: 'Second' })], 'tool_use'),
			msg([text('Logged the first one.')])
		);
		const ev = await turn(u, { threadId: null, text: 'Log my title change' }, s.call);
		const approval = ev.find((e) => e.type === 'approval') as { items: { id: string; name: string }[] };
		expect(approval.items.map((i) => i.id)).toEqual(['w1', 'w2']);
		const id = (ev[0] as { id: number }).id;
		expect(pendingOf(getThread(u, id)!)?.awaiting.length).toBe(2);
		expect(db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'mcp.log_change'").get()).toEqual({ n: 0 });

		const ev2 = await turn(u, { threadId: id, decisions: { w1: true, w2: false } }, s.call);
		expect(ev2.filter((e) => e.type === 'tool').map((e) => (e as { tool: { id: string; status: string } }).tool).filter((t) => t.status !== 'running')).toEqual([
			expect.objectContaining({ id: 'w1', status: 'done' }),
			expect.objectContaining({ id: 'w2', status: 'declined' })
		]);
		expect(pendingOf(getThread(u, id)!)).toBeNull();
		expect((db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'mcp.log_change'").get() as { n: number }).n).toBe(1);
		const results = lastUser(s.seen[1]).content as Anthropic.Beta.BetaToolResultBlockParam[];
		expect(results.map((r) => [r.tool_use_id, !!r.is_error])).toEqual([['w1', false], ['w2', true]]);
		expect(displayItems(threadMessages(id)).filter((i) => i.kind === 'tool').map((i) => (i.kind === 'tool' ? i.tool.status : ''))).toEqual(['done', 'declined']);
	});

	it('a viewer cannot change anything, even if the model asks', async () => {
		const u = member('viewer');
		const s = script(msg([use('w', 'log_change', { site: 1, date: '2026-11-01', title: 'x' })], 'tool_use'), msg([text('I cannot.')]));
		const ev = await turn(u, { threadId: null, text: 'log it' }, s.call);
		expect(ev.some((e) => e.type === 'approval')).toBe(false);
		const r = (lastUser(s.seen[1]).content as Anthropic.Beta.BetaToolResultBlockParam[])[0];
		expect(r.is_error).toBe(true);
		expect(String(r.content)).toMatch(/not available/);
	});

	it('a new message instead of an answer declines what was waiting, in the same request', async () => {
		const s = script(msg([use('w', 'log_change', { site: 1, date: '2026-11-01', title: 'x' })], 'tool_use'), msg([text('ok')]));
		const ev = await turn(OWNER, { threadId: null, text: 'log it' }, s.call);
		const id = (ev[0] as { id: number }).id;
		await turn(OWNER, { threadId: id, text: 'actually, never mind' }, s.call);
		const content = lastUser(s.seen[1]).content as { type: string; tool_use_id?: string; is_error?: boolean }[];
		expect(content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'w', is_error: true });
		expect(content[1]).toMatchObject({ type: 'text', text: 'actually, never mind' });
	});

	it('draws a valid chart and tells the model why an invalid one was refused', async () => {
		const good = { type: 'line', title: 'Clicks', labels: ['Sep', 'Oct'], series: [{ name: 'clicks', values: [10, 12] }] };
		const s = script(msg([use('c1', 'show_chart', good), use('c2', 'show_chart', { type: 'pie', title: 'x', labels: [], series: [] })], 'tool_use'), msg([text('Here it is.')]));
		const ev = await turn(OWNER, { threadId: null, text: 'chart it' }, s.call);
		expect(ev.filter((e) => e.type === 'chart')).toHaveLength(1);
		const results = lastUser(s.seen[1]).content as Anthropic.Beta.BetaToolResultBlockParam[];
		expect(results[1]).toMatchObject({ is_error: true });
		const id = (ev[0] as { id: number }).id;
		expect(displayItems(threadMessages(id)).filter((i) => i.kind === 'chart')).toHaveLength(1);
	});

	it('answers dangling tool calls as stopped before the next message, so the API accepts the conversation', async () => {
		const ev = await turn(OWNER, { threadId: null, text: 'first' }, script(msg([text('hi')])).call);
		const id = (ev[0] as { id: number }).id;
		db().prepare("INSERT INTO chat_messages (thread_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)").run(id, JSON.stringify([use('x', 'list_sites')]), Date.now());
		const s = script(msg([text('ok')]));
		await turn(OWNER, { threadId: id, text: 'again' }, s.call);
		const m = s.seen[0].messages;
		expect(m[m.length - 2]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', is_error: true }] });
	});

	it('enforces the daily limit, needs a key, and keeps conversations private', async () => {
		process.env.CHAT_MESSAGES_PER_DAY = '1';
		const ev = await turn(OWNER, { threadId: null, text: 'one' }, script(msg([text('a')])).call);
		const again = await turn(OWNER, { threadId: null, text: 'two' }, script(msg([text('b')])).call);
		expect(again.find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/daily limit/) });
		const other = member('admin');
		expect(getThread(other, (ev[0] as { id: number }).id)).toBeNull();
		expect((await turn(other, { threadId: (ev[0] as { id: number }).id, text: 'peek' }, script().call)).find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/not found/) });
		process.env.ANTHROPIC_API_KEY = '';
		expect((await turn(OWNER, { threadId: null, text: 'x' }, script().call)).find((e) => e.type === 'error')).toMatchObject({ message: expect.stringMatching(/ANTHROPIC_API_KEY/) });
	});

	it('reports an API failure as a readable error and still ends with done', async () => {
		const ev = await turn(OWNER, { threadId: null, text: 'x' }, async () => { throw new Error('boom'); });
		expect(ev.slice(-2)).toEqual([{ type: 'error', message: 'boom' }, { type: 'done' }]);
	});
});

describe('charts, labels and Markdown', () => {
	it('validates charts', () => {
		expect('chart' in validateChart({ type: 'bar', title: 't', labels: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] })).toBe(true);
		expect(validateChart({ type: 'bar', title: 't', labels: ['a', 'b'], series: [{ name: 's', values: [1] }] })).toMatchObject({ error: expect.stringMatching(/one value per label/) });
		expect(validateChart({ type: 'line', title: 't', labels: Array.from({ length: 200 }, (_, i) => String(i)), series: [{ name: 's', values: [] }] })).toMatchObject({ error: expect.stringMatching(/At most/) });
		expect(validateChart({ type: 'line', title: 't', labels: ['a', 'b'], series: [{ name: 's', values: [1, 'x'] }] })).toMatchObject({ error: expect.stringMatching(/not a number/) });
	});
	it('labels tool calls for people', () => {
		expect(toolLabel('get_quick_wins', { site: 1 }, () => 'greenleaf.example')).toBe('Found quick wins · greenleaf.example');
		expect(toolLabel('get_trends', { view: 'query_count' })).toBe('Checked trends · query count');
		expect(toolLabel('mark_action', {})).toBe('Mark action');
	});
	it('renders Markdown safely', () => {
		expect(renderMarkdown('<script>alert(1)</script> **bold** `<b>`')).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt; <strong>bold</strong> <code>&lt;b&gt;</code></p>');
		expect(renderMarkdown('[x](javascript:alert(1)) [ok](https://example.com/a?b=1&c=2)')).toBe('<p>[x](javascript:alert(1)) <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">ok</a></p>');
		expect(renderMarkdown('| Page | Clicks |\n|---|---:|\n| /a | 1,200 |')).toBe('<div class="md-table" tabindex="0"><table><thead><tr><th>Page</th><th>Clicks</th></tr></thead><tbody><tr><td>/a</td><td class="num">1,200</td></tr></tbody></table></div>');
		expect(renderMarkdown('## Top\n- one\n- *two*\n\n1. a\n2. b')).toBe('<h4>Top</h4><ul><li>one</li><li><em>two</em></li></ul><ol><li>a</li><li>b</li></ol>');
		expect(renderMarkdown('```\n<x> **no**\n```')).toBe('<pre tabindex="0"><code>&lt;x&gt; **no**</code></pre>');
	});
});

describe('stopping', () => {
	it('keeps the part of the answer that was already shown when a turn is stopped', async () => {
		const ac = new AbortController();
		const call: ModelCall = async (_p, o) => {
			o.onText('Half an ans');
			ac.abort();
			throw new Error('aborted');
		};
		const events: ChatEvent[] = [];
		await runTurn(OWNER, { threadId: null, text: 'q' }, (e) => events.push(e), { call, signal: ac.signal });
		const id = (events[0] as { id: number }).id;
		expect(displayItems(threadMessages(id)).at(-1)).toEqual({ kind: 'text', text: 'Half an ans …\n\n*(stopped)*' });
		expect(events.some((e) => e.type === 'error')).toBe(false);
	});
});
