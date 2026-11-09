import { beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { createApiKey } from '../src/lib/server/apikeys';
import { MCP_READ_TOOL_NAMES, MCP_TOOL_NAMES, MCP_WRITE_TOOL_NAMES, resetRateLimits, resetWriteLimits } from '../src/lib/server/mcp';
import { argsFromQuery, handleRest } from '../src/lib/server/rest';

const req = (path: string, o: { method?: string; key?: string; body?: string; type?: string } = {}) => {
	const headers: Record<string, string> = {};
	if (o.key) headers.authorization = `Bearer ${o.key}`;
	if (o.type ?? (o.body ? 'application/json' : '')) headers['content-type'] = o.type ?? 'application/json';
	return handleRest(new Request(`http://x/api/v1/${path}`, { method: o.method ?? 'GET', headers, body: o.body }), path.split('?')[0]);
};

let reader = '', writer = '', scoped = '';
beforeEach(async () => {
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	process.env.DEMO_MODE = '1';
	delete process.env.READ_ONLY;
	await ensureDemoAccounts();
	reader = createApiKey('reader', null).key;
	writer = createApiKey('writer', null, null, 'submit').key;
	scoped = createApiKey('greenleaf only', [1]).key;
	resetRateLimits();
	resetWriteLimits();
});

describe('REST API', () => {
	it('needs a key, and says how to send one', async () => {
		const r = await req('list_sites');
		expect(r.status).toBe(401);
		expect(r.headers.get('www-authenticate')).toBe('Bearer');
		expect((await r.json()).error.message).toMatch(/Authorization: Bearer/);
		expect((await req('list_sites', { key: 'osc_nope' })).status).toBe(401);
	});

	it('the index lists every tool, with the methods and permission each takes; changes are POST only', async () => {
		const r = await req('', { key: reader });
		expect(r.status).toBe(200);
		expect(r.headers.get('cache-control')).toBe('no-store');
		const body = await r.json();
		expect(body.endpoints.map((e: { path: string }) => e.path.replace('/api/v1/', '')).sort()).toEqual([...MCP_TOOL_NAMES].sort());
		for (const e of body.endpoints) expect(e.methods, e.path).toEqual(MCP_WRITE_TOOL_NAMES.includes(e.path.replace('/api/v1/', '')) ? ['POST'] : ['GET', 'POST']);
		expect(body.yourKey).toEqual({ name: 'reader', permission: 'read', limitedToSites: null });
	});

	it('reads with GET, query parameters typed from the schema', async () => {
		const r = await req('get_overview?site=1&days=7', { key: reader });
		expect(r.status).toBe(200);
		const { data } = await r.json();
		expect(data).toBeTruthy();
		expect(JSON.stringify(data)).toMatch(/greenleaf/);
		// the same call as POST with a JSON body gives the same answer
		const p = await req('get_overview', { method: 'POST', key: reader, body: JSON.stringify({ site: '1', days: 7 }) });
		expect((await p.json()).data).toEqual(data);
	});

	it('a typo in a parameter is refused instead of silently ignored; an unknown endpoint is a 404', async () => {
		const r = await req('get_overview?site=1&dayz=7', { key: reader });
		expect(r.status).toBe(400);
		expect((await r.json()).error.message).toMatch(/Unknown parameter "dayz".*days/);
		expect((await req('drop_everything', { key: reader })).status).toBe(404);
	});

	it('a tool error (no such site) is a 400 with the reason', async () => {
		const r = await req('get_overview?site=nope.example', { key: reader });
		expect(r.status).toBe(400);
		expect((await r.json()).error.message).toMatch(/No accessible site/);
	});

	it('a site-limited key sees only its sites', async () => {
		const all = (await (await req('list_sites', { key: reader })).json()).data;
		const mine = (await (await req('list_sites', { key: scoped })).json()).data;
		expect(JSON.stringify(all).length).toBeGreaterThan(JSON.stringify(mine).length);
		expect((await req('get_overview?site=2', { key: scoped })).status).toBe(400);
	});

	it('a change is never made by GET, needs the submit permission, and is refused in READ_ONLY mode', async () => {
		const args = { site: '1', date: '2026-10-01', title: 'New title template' };
		const get = await req('log_change?site=1&date=2026-10-01&title=x', { key: writer });
		expect(get.status).toBe(405);
		expect(get.headers.get('allow')).toBe('POST');
		const denied = await req('log_change', { method: 'POST', key: reader, body: JSON.stringify(args) });
		expect(denied.status).toBe(403);
		expect((await denied.json()).error.code).toBe('permission');
		const ok = await req('log_change', { method: 'POST', key: writer, body: JSON.stringify(args) });
		expect(ok.status).toBe(200);
		expect((await ok.json()).data.id).toBeGreaterThan(0);
		process.env.READ_ONLY = '1';
		const ro = await req('log_change', { method: 'POST', key: writer, body: JSON.stringify(args) });
		expect(ro.status).toBe(403);
		expect((await ro.json()).error.code).toBe('read_only');
	});

	it('a POST body must be a JSON object sent as application/json (a cross-site HTML form cannot send one)', async () => {
		expect((await req('list_sites', { method: 'POST', key: reader, body: 'site=1', type: 'application/x-www-form-urlencoded' })).status).toBe(415);
		expect((await req('list_sites', { method: 'POST', key: reader, body: '[1]' })).status).toBe(400);
		expect((await req('list_sites', { method: 'POST', key: reader, body: '{bad' })).status).toBe(400);
		expect((await req('list_sites', { method: 'POST', key: reader })).status).toBe(200); // no body: no parameters
		expect((await req('list_sites', { method: 'DELETE', key: reader })).status).toBe(405);
	});

	it('shares the per-key rate limit with MCP', async () => {
		let last = 0;
		for (let i = 0; i < 125; i++) last = (await req('list_sites', { key: reader })).status;
		expect(last).toBe(429);
	});

	it('query arguments: numbers, booleans, arrays (repeated or comma-separated) and JSON objects', () => {
		const schema = { n: { type: 'integer' }, b: { type: 'boolean' }, list: { type: 'array', items: { type: 'string' } }, nums: { type: 'array', items: { type: 'integer' } }, o: { type: 'object' }, s: { type: 'string' } };
		expect(argsFromQuery(new URLSearchParams('n=5&b=true&list=a,b&nums=1&nums=2&o={"x":1}&s=007'), schema)).toEqual({ args: { n: 5, b: true, list: ['a', 'b'], nums: [1, 2], o: { x: 1 }, s: '007' } });
		expect(argsFromQuery(new URLSearchParams('n=abc'), schema)).toEqual({ args: { n: 'abc' } }); // left for the tool to explain
		expect(argsFromQuery(new URLSearchParams('o={x'), schema)).toEqual({ error: '"o" must be JSON.' });
		expect(MCP_READ_TOOL_NAMES.length).toBeGreaterThan(30);
	});
});
