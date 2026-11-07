import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { autoMatchGa4, connectBingKey, connectClarity, connectOpenSeo } from '../src/lib/server/connect';
import { createApiKey, deleteApiKey } from '../src/lib/server/apikeys';
import { handleMcp } from '../src/lib/server/mcp';
import { queueDepth } from '../src/lib/server/jobs';
import { db } from '../src/lib/server/db';

const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

let key = '';
let scoped = '';

async function call(k: string | null, body: object) {
	const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) }));
	return { status: res.status, json: res.status === 202 ? null : await res.json() };
}
const tool = async (k: string, name: string, args: object = {}) => {
	const r = await call(k, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
	const res = r.json.result;
	const text = res.content[0].text as string;
	// Errors are plain-text messages (isError: true); successes are JSON.
	return { isError: !!res.isError, data: res.isError ? text : JSON.parse(text) };
};

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
	await syncSite(2, { client: new DemoClient('demo-a'), mode: 'incremental' });
	await connectBingKey('demo', 'b');
	await autoMatchGa4();
	await connectClarity(1, 'demo');
	await connectOpenSeo('https://openseo.example', 'demo');
	await drain();
	key = createApiKey('all', null).key;
	scoped = createApiKey('only greenleaf', [1]).key;
}, 120_000);

beforeEach(() => void 0);

describe('MCP server', () => {
	it('rejects missing/invalid keys with 401 and a JSON-RPC error', async () => {
		expect((await call(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
		expect((await call('osc_nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
	});

	it('speaks the MCP handshake and advertises every tool as read-only except the submitting ones', async () => {
		const init = await call(key, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
		expect(init.json.result.serverInfo.name).toBe('seoconsole');
		expect(init.json.result.capabilities.tools).toBeDefined();
		expect((await call(key, { jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
		const list = await call(key, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
		const names = list.json.result.tools.map((t: { name: string }) => t.name);
		expect(names).toEqual(expect.arrayContaining(['list_sites', 'get_overview', 'get_search_types', 'get_opportunities', 'get_bing_performance', 'get_ga4_summary', 'get_clarity_snapshot', 'get_openseo_project']));
		const notReadOnly = list.json.result.tools.filter((t: { annotations: { readOnlyHint: boolean } }) => !t.annotations.readOnlyHint).map((t: { name: string }) => t.name).sort();
		expect(notReadOnly).toEqual(['build_request_indexing_queue', 'cancel_indexing_queue', 'delete_sitemap', 'get_site_verification_token', 'inspect_and_submit_urls', 'mark_indexing_requested', 'run_indexing_check', 'setup_indexnow', 'submit_sitemap', 'submit_urls_for_indexing', 'verify_site_ownership']); // and those need a key with the submit permission
		expect((await call(key, { jsonrpc: '2.0', id: 3, method: 'nope' })).json.error.code).toBe(-32601);
	});

	it('list_sites reports connections and the OpenSEO project id', async () => {
		const { data } = await tool(key, 'list_sites');
		expect(data).toHaveLength(6);
		const g = data.find((s: { name: string }) => s.name === 'greenleaf.example');
		expect(g.connected).toMatchObject({ bing: true, ga4: true, clarity: true });
		expect(g.connected.openseo.projectId).toBe('demo-proj-greenleaf');
	});

	it('a site-scoped key cannot see or query other sites', async () => {
		expect((await tool(scoped, 'list_sites')).data).toHaveLength(1);
		const other = await tool(scoped, 'get_overview', { site: '2' });
		expect(other.isError).toBe(true);
		expect(other.data).toMatch(/No accessible site/);
		expect((await tool(scoped, 'get_overview', { site: 'greenleaf.example' })).isError).toBe(false);
	});

	it('get_overview combines Google, Bing and GA4 organic', async () => {
		const { data } = await tool(key, 'get_overview', { site: 'greenleaf.example', days: 28 });
		expect(data.google.clicks).toBeGreaterThan(1000);
		expect(data.bing.clicks).toBeGreaterThan(0);
		expect(data.ga4OrganicSearch.sessions).toBeGreaterThan(0);
		expect(data.period.end).toBeTruthy();
	});

	it('get_opportunities supports every type and rejects unknown ones', async () => {
		for (const type of ['striking', 'ctr_gaps', 'cannibalization', 'decay', 'anomalies']) {
			const r = await tool(key, 'get_opportunities', { site: '1', type });
			expect(r.isError, type).toBe(false);
		}
		const striking = (await tool(key, 'get_opportunities', { site: '1', type: 'striking', limit: 5 })).data;
		expect(striking.rows.length).toBeLessThanOrEqual(5);
		expect(striking.rows[0].estimatedExtraClicksAtPos3).toBeGreaterThan(0);
		expect((await tool(key, 'get_opportunities', { site: '1', type: 'bogus' })).isError).toBe(true);
	});

	it('channel tools return data when connected and a hint when not', async () => {
		expect((await tool(key, 'get_bing_performance', { site: '1' })).data.topQueries.length).toBeGreaterThan(0);
		const ga4 = (await tool(key, 'get_ga4_summary', { site: '1' })).data;
		expect(ga4.channels.some((r: { channel: string }) => r.channel === 'Organic Search')).toBe(true);
		expect(Array.isArray(ga4.topGoogleOrganicLandingPages)).toBe(true);
		const clarity = (await tool(key, 'get_clarity_snapshot', { site: '1' })).data;
		expect(clarity.metrics[0].metricName).toBe('Traffic');
		expect((await tool(key, 'get_clarity_snapshot', { site: '2' })).data.connected).toBe(false);
		expect((await tool(key, 'get_openseo_project', { site: '2' })).data.linked).toBe(false);
	});

	it('stores only a hash of the key and supports revocation', async () => {
		const k = createApiKey('temp', null);
		const raw = db().prepare('SELECT hash, prefix FROM api_keys WHERE id = ?').get(k.id) as { hash: string; prefix: string };
		expect(raw.hash).not.toContain(k.key);
		expect(raw.prefix).toBe(k.key.slice(0, 8));
		expect((await call(k.key, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(200);
		deleteApiKey(k.id);
		expect((await call(k.key, { jsonrpc: '2.0', id: 1, method: 'ping' })).status).toBe(401);
	});
});
