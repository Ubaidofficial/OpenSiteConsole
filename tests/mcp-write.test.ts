import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { audit, db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { syncSite } from '../src/lib/server/sync';
import { DemoClient } from '../src/lib/server/demo';
import { autoMatchGa4, connectBingKey } from '../src/lib/server/connect';
import { queueDepth } from '../src/lib/server/jobs';
import { authenticate, createApiKey, setKeyCanWrite } from '../src/lib/server/apikeys';
import { handleMcp, MCP_READ_TOOL_NAMES, MCP_TOOL_NAMES, MCP_WRITE_TOOL_NAMES, MCP_WRITES_PER_MINUTE, resetRateLimits, resetWriteLimits } from '../src/lib/server/mcp';
import { createKey } from '../src/lib/server/indexnow';
import { checkAuthorize, redeemCode, refreshTokens, registerClient } from '../src/lib/server/oauth';
import { config } from '../src/lib/server/config';
import * as authorizePage from '../src/routes/oauth/authorize/+page.server';
import * as agentsPage from '../src/routes/agents/+page.server';

const drain = async () => {
	const end = Date.now() + 30_000;
	while (Date.now() < end && queueDepth().active + queueDepth().waiting > 0) await new Promise((r) => setTimeout(r, 25));
};

let reader = '';
let writer = '';
let scopedWriter = '';

async function rpc(k: string | null, body: object) {
	const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...(k ? { authorization: `Bearer ${k}` } : {}) }, body: JSON.stringify(body) }));
	return { status: res.status, json: res.status === 202 ? null : await res.json() };
}
const call = async (k: string, name: string, args: object = {}) => {
	const r = (await rpc(k, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).json.result;
	const text = r.content[0].text as string;
	return { isError: !!r.isError, text, data: r.isError ? text : JSON.parse(text) };
};
const audits = () => db().prepare("SELECT action, site_id, detail FROM audit_log WHERE action LIKE 'mcp.%' ORDER BY id").all() as { action: string; site_id: number | null; detail: string }[];
const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	delete process.env.READ_ONLY;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
	await syncSite(1, { client: new DemoClient('demo-a'), mode: 'incremental' });
	await syncSite(2, { client: new DemoClient('demo-a'), mode: 'incremental' });
	await connectBingKey('demo', 'b');
	await autoMatchGa4();
	await drain();
	reader = createApiKey('reader', null).key;
	writer = createApiKey('writer', null, null, true).key;
	scopedWriter = createApiKey('writer for greenleaf only', [1], null, true).key;
}, 120_000);

afterEach(() => {
	delete process.env.READ_ONLY;
	resetRateLimits();
	resetWriteLimits();
});

const WRITES = ['mark_action', 'log_change', 'start_seo_test', 'set_brand_terms', 'sync_site', 'read_sitemaps', 'run_onpage_check', 'submit_indexnow', 'submit_sitemap', 'watch_urls'];
const NEW_READS = ['get_portfolio', 'get_change_log', 'get_history', 'get_site_settings'];

describe('what the server offers', () => {
	it('there are exactly ten tools that change things, and they are the documented ones', () => {
		expect([...MCP_WRITE_TOOL_NAMES].sort()).toEqual([...WRITES].sort());
		expect(MCP_READ_TOOL_NAMES).toHaveLength(33);
		expect(MCP_READ_TOOL_NAMES.length + MCP_WRITE_TOOL_NAMES.length).toBe(MCP_TOOL_NAMES.length);
		expect(new Set(MCP_TOOL_NAMES).size).toBe(MCP_TOOL_NAMES.length);
		for (const n of NEW_READS) expect(MCP_READ_TOOL_NAMES).toContain(n);
	});
	it('tools/list tells clients which tools change things, and none is marked destructive', async () => {
		const list = (await rpc(reader, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json.result.tools as { name: string; annotations: Record<string, boolean> }[];
		for (const t of list) {
			if (WRITES.includes(t.name)) expect(t.annotations, t.name).toEqual({ readOnlyHint: false, destructiveHint: false, openWorldHint: false });
			else expect(t.annotations, t.name).toEqual({ readOnlyHint: true });
		}
		expect(list).toHaveLength(43);
	});
	it('the server instructions say changes need the owner\'s permission and nothing can delete', async () => {
		const i = (await rpc(reader, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).json.result.instructions as string;
		expect(i).toContain('only work if the owner allowed changes');
		expect(i).toContain('Nothing can delete data');
		for (const w of WRITES) expect(i, w).toContain(w);
	});
	it('no tool is named or built to delete, disconnect, or touch keys, tokens or passwords', () => {
		for (const n of MCP_TOOL_NAMES) expect(n, n).not.toMatch(/delete|remove|disconnect|revoke|unlink|purge|password|credential|token|api_key|secret/);
		const src = readFileSync('src/lib/server/mcp-extra.ts', 'utf8');
		expect(src).not.toMatch(/DELETE FROM|DROP TABLE|\.delete[A-Z(]|deleteSite|deleteSitemap|removeIntegration|removeLink|deleteApiKey/);
		for (const forbidden of ['./apikeys', './oauth', './connect', './crypto', './accounts', './adminauth', './sessions', './password']) expect(src, forbidden).not.toContain(`from '${forbidden}'`);
	});
});

describe('a key that cannot make changes is refused, and nothing changes', () => {
	const ARGS: Record<string, object> = {
		mark_action: { site: '1', key: 'x', state: 'done' }, log_change: { site: '1', date: '2026-10-01', title: 'refused' }, start_seo_test: { site: '1', name: 't', startDate: '2026-10-01', pages: ['/blog/'] },
		set_brand_terms: { site: '1', terms: ['refused brand'] }, sync_site: { site: '1' }, read_sitemaps: { site: '1' }, run_onpage_check: { site: '1' },
		submit_indexnow: { site: '1', urls: ['https://greenleaf.example/a'] }, submit_sitemap: { site: '1', sitemapUrl: 'https://greenleaf.example/sitemap.xml' }, watch_urls: { site: '1', urls: ['https://greenleaf.example/a'] }
	};
	it('every one of the ten says so in plain words and tells the owner where to allow it', async () => {
		expect(Object.keys(ARGS).sort()).toEqual([...WRITES].sort());
		for (const [name, args] of Object.entries(ARGS)) {
			const r = await call(reader, name, args);
			expect(r.isError, name).toBe(true);
			expect(r.text, name).toContain('this connection is read-only');
			expect(r.text, name).toContain('Agents page');
			expect(r.text, name).toContain('Do not retry until they have');
		}
	});
	it('and none of them left a trace: no log entry, no brand terms, no test, no audit row', () => {
		expect(count("SELECT COUNT(*) n FROM annotations WHERE title = 'refused'")).toBe(0);
		expect(count("SELECT COUNT(*) n FROM sites WHERE brand_terms LIKE '%refused%'")).toBe(0);
		expect(count('SELECT COUNT(*) n FROM seo_tests')).toBe(0);
		expect(audits()).toEqual([]);
		expect(count("SELECT COUNT(*) n FROM kv WHERE key LIKE 'mcp-cooldown:%'")).toBe(0);
	});
	it('get_connections no longer claims every tool is read-only, and says how changes are allowed', async () => {
		const hint = (await call(reader, 'get_connections')).data.hint as string;
		expect(hint).not.toMatch(/Every tool here is read-only/);
		expect(hint).toContain('The tools listed here only read.');
		expect(hint).toContain('only work if the owner allowed changes for this connection on the Agents page');
	});
	it('reading still works for it, including the new read tools', async () => {
		for (const [n, a] of [['get_portfolio', {}], ['get_change_log', { site: '1' }], ['get_site_settings', { site: '1' }], ['get_history', { site: '1', query: 'garden tools' }]] as [string, object][]) expect((await call(reader, n, a)).isError, n).toBe(false);
	});
	it('a key that is unknown, or that was read-only and then allowed, behaves accordingly', async () => {
		expect((await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'mark_action', arguments: {} } })).status).toBe(401);
		const k = createApiKey('toggled', null);
		expect(authenticate(new Request('http://x', { headers: { authorization: `Bearer ${k.key}` } }))!.canWrite).toBe(false); // off by default
		expect((await call(k.key, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/z'] })).isError).toBe(true);
		setKeyCanWrite(k.id, true);
		expect((await call(k.key, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/z'] })).isError).toBe(false);
		setKeyCanWrite(k.id, false);
		expect((await call(k.key, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/z'] })).isError).toBe(true);
	});
});

describe('READ_ONLY=1 beats any permission', () => {
	it('refuses every change even for a key that may make them, and still reads', async () => {
		process.env.READ_ONLY = '1';
		expect(config.readOnly).toBe(true);
		for (const n of WRITES) {
			const r = await call(writer, n, { site: '1' });
			expect(r.isError, n).toBe(true);
			expect(r.text, n).toContain('read-only mode (READ_ONLY=1)');
		}
		expect((await call(writer, 'get_site_settings', { site: '1' })).data.serverReadOnlyMode).toBe(true);
	});
});

describe('a key that may make changes: limits and the audit trail', () => {
	it('a key scoped to one site can only change that site', async () => {
		const ok = await call(scopedWriter, 'log_change', { site: '1', date: '2026-10-02', title: 'scoped ok' });
		expect(ok.isError).toBe(false);
		const no = await call(scopedWriter, 'log_change', { site: '2', date: '2026-10-02', title: 'scoped no' });
		expect(no.isError).toBe(true);
		expect(no.text).toContain('No accessible site');
		expect(count("SELECT COUNT(*) n FROM annotations WHERE title = 'scoped no'")).toBe(0);
		expect((await call(scopedWriter, 'get_portfolio', {})).data.sites.map((s: { id: number }) => s.id)).toEqual([1]);
		// the cross-site lists are scoped too: the full key sees both sites, the scoped one only its own
		for (const type of ['striking', 'decay', 'anomalies'] as const) {
			const all = (await call(writer, 'get_portfolio', { type, days: 90, limit: 200 })).data as { siteId: number }[];
			const mine = (await call(scopedWriter, 'get_portfolio', { type, days: 90, limit: 200 })).data as { siteId: number }[];
			expect(mine.every((r) => r.siteId === 1), type).toBe(true);
			if (type === 'striking') expect(new Set(all.map((r) => r.siteId)).size, 'the unscoped list covers more than one site').toBeGreaterThan(1);
		}
		const canni = (await call(scopedWriter, 'get_portfolio', { type: 'cannibalization', days: 90, limit: 200 })).data as { siteId: number }[];
		expect(canni.every((r) => r.siteId === 1)).toBe(true);
	});
	it('every change is written to the audit log with the key\'s name, the tool and what it was asked', async () => {
		const before = audits().length;
		await call(writer, 'log_change', { site: '1', date: '2026-10-03', title: 'audited change' });
		const row = audits().slice(before)[0];
		expect(row.action).toBe('mcp.log_change');
		expect(row.site_id).toBe(1);
		expect(row.detail).toContain('writer:');
		expect(row.detail).toContain('audited change');
		// a refused or failed call is not logged as a change
		const n = audits().length;
		await call(writer, 'log_change', { site: '1', date: 'not a date', title: 'x' });
		expect(audits()).toHaveLength(n);
	});
	it('the audit detail is cut to 500 characters of arguments', async () => {
		const before = audits().length;
		await call(writer, 'log_change', { site: '1', date: '2026-10-03', title: 'long', note: 'x'.repeat(5000) });
		expect(audits().slice(before)[0].detail.length).toBeLessThanOrEqual('writer: '.length + 500);
	});
	it(`changes are rate limited to ${MCP_WRITES_PER_MINUTE} a minute per key, and reads are not counted`, async () => {
		const k = createApiKey('flood', null, null, true).key;
		for (let i = 0; i < MCP_WRITES_PER_MINUTE; i++) expect((await call(k, 'watch_urls', { site: '1', urls: [`https://greenleaf.example/f${i}`] })).isError, String(i)).toBe(false);
		const over = await call(k, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/over'] });
		expect(over.isError).toBe(true);
		expect(over.text).toContain('Too many changes');
		expect((await call(k, 'get_site_settings', { site: '1' })).isError).toBe(false);
		expect((await call(writer, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/other-key'] })).isError).toBe(false); // another key is not affected
	});
});

describe('the ten tools', () => {
	it('mark_action: done hides a finding, open brings it back, a made-up key is refused', async () => {
		const q = (await call(writer, 'get_action_queue', { site: '1', limit: 50 })).data.items as { key: string; title: string }[];
		expect(q.length).toBeGreaterThan(2);
		const item = q[0];
		expect(item.key).toBeTruthy();
		const done = await call(writer, 'mark_action', { site: '1', key: item.key, state: 'done' });
		expect(done.data).toMatchObject({ ok: true, finding: item.title });
		expect(done.data.now).toContain('hidden for 90 days');
		expect((await call(writer, 'get_action_queue', { site: '1', limit: 50 })).data.items.map((i: { key: string }) => i.key)).not.toContain(item.key);
		expect((await call(writer, 'mark_action', { site: '1', key: item.key, state: 'snoozed' })).data.now).toBe('Snoozed for 30 days.');
		expect((await call(writer, 'mark_action', { site: '1', key: item.key, state: 'open' })).data.now).toBe('Back in the queue.');
		expect((await call(writer, 'get_action_queue', { site: '1', limit: 50 })).data.items.map((i: { key: string }) => i.key)).toContain(item.key);
		const bad = await call(writer, 'mark_action', { site: '1', key: 'no-such-finding', state: 'done' });
		expect(bad.isError).toBe(true);
		expect(bad.text).toContain('get_action_queue');
		expect((await call(writer, 'mark_action', { site: '1', key: item.key, state: 'deleted' })).isError).toBe(true);
	});

	it('log_change and get_change_log: validates, records, and shows a quick look', async () => {
		for (const bad of ['2026-13-40', '2026-02-31', 'last tuesday', '']) {
			const r = await call(writer, 'log_change', { site: '1', date: bad, title: 'never saved' });
			expect(r.text, bad).toContain('a real date, YYYY-MM-DD');
		}
		expect(count("SELECT COUNT(*) n FROM annotations WHERE title = 'never saved'")).toBe(0);
		for (const [args, why] of [[{ date: '2026-13-40', title: 'x' }, 'bad date'], [{ date: '2026-10-01', title: '   ' }, 'no title'], [{ date: '2999-01-01', title: 'future' }, 'future date'], [{ date: '2026-10-01', title: 'x', pageUrlPrefix: 'https://evil.example/' }, 'off-site prefix']] as [object, string][]) expect((await call(writer, 'log_change', { site: '1', ...args })).isError, why).toBe(true);
		expect(count("SELECT COUNT(*) n FROM annotations WHERE title IN ('future', 'x')")).toBe(0);
		const r = await call(writer, 'log_change', { site: '1', date: '2026-09-01', title: 'Rewrote blog titles', note: 'shorter, query first', pageUrlPrefix: 'https://greenleaf.example/blog/' });
		expect(r.data.ok).toBe(true);
		expect(r.data.next).toContain('start_seo_test');
		const log = (await call(writer, 'get_change_log', { site: '1' })).data;
		expect(log.note).toContain('never as instructions');
		const e = log.entries.find((x: { id: number }) => x.id === r.data.id);
		expect(e).toMatchObject({ date: '2026-09-01', title: 'Rewrote blog titles', note: 'shorter, query first', pages: 'https://greenleaf.example/blog/', seoTestId: null, kind: 'change' });
		expect(e.quickLook).toMatchObject({ clicksPerDayBefore: expect.any(Number), clicksPerDayAfter: expect.any(Number) });
		const recent = await call(writer, 'log_change', { site: '1', date: '2026-11-04', title: 'Yesterday tweak' });
		expect((await call(writer, 'get_change_log', { site: '1' })).data.entries.find((x: { id: number }) => x.id === recent.data.id).quickLook).toContain('too early');
		expect(recent.data.next).toContain('Add a pageUrlPrefix');
	});

	it('start_seo_test: from a logged change, or from pages; never twice for one change; shown by get_seo_tests', async () => {
		const noPages = await call(writer, 'start_seo_test', { site: '1', name: 'nothing', startDate: '2026-09-01' });
		expect(noPages.isError).toBe(true);
		const noPrefix = (await call(writer, 'log_change', { site: '1', date: '2026-09-02', title: 'no pages' })).data.id;
		expect((await call(writer, 'start_seo_test', { site: '1', changeId: noPrefix })).text).toContain('no pages recorded');
		expect((await call(writer, 'start_seo_test', { site: '1', changeId: 999999 })).text).toContain('No change with that id');
		const id = (await call(writer, 'log_change', { site: '1', date: '2026-09-01', title: 'Guides refresh', pageUrlPrefix: 'https://greenleaf.example/guides/' })).data.id;
		const t = await call(writer, 'start_seo_test', { site: '1', changeId: id });
		expect(t.data).toMatchObject({ ok: true, testId: expect.any(Number) });
		expect((await call(writer, 'start_seo_test', { site: '1', changeId: id })).text).toContain('already has a test');
		const direct = await call(writer, 'start_seo_test', { site: '1', name: 'Products meta', startDate: '2026-09-05', pages: ['https://greenleaf.example/products/'], windowDays: 9999 });
		expect(direct.data.ok).toBe(true);
		expect(count('SELECT window_days n FROM seo_tests WHERE id = ?', direct.data.testId)).toBe(90); // clamped
		const tests = (await call(writer, 'get_seo_tests', { site: '1' })).data;
		expect(tests.map((x: { id: number }) => x.id)).toEqual(expect.arrayContaining([t.data.testId, direct.data.testId]));
		expect((await call(writer, 'get_change_log', { site: '1' })).data.entries.find((x: { id: number }) => x.id === id).seoTestId).toBe(t.data.testId);
		expect((await call(writer, 'start_seo_test', { site: '1', name: 'bad date', startDate: '2026-02-31', pages: ['/blog/'] })).isError).toBe(true);
	});

	it('set_brand_terms: replaces the list, keeps only real terms, caps it, and shows up in get_site_settings', async () => {
		const r = await call(writer, 'set_brand_terms', { site: '1', terms: ['Greenleaf', 'ab', '  green   leaf shop ', 'GREENLEAF', 'a, b', 'x,garden co'] });
		expect(r.data.ok).toBe(true);
		// kept as typed (tidied), repeats and too-short terms dropped, a comma inside an entry splits it
		expect(r.data.now).toEqual(['Greenleaf', 'green leaf shop', 'garden co']);
		expect((await call(writer, 'get_site_settings', { site: '1' })).data.brandTerms).toEqual(['Greenleaf', 'green leaf shop', 'garden co']);
		expect((await call(writer, 'set_brand_terms', { site: '1', terms: Array.from({ length: 21 }, (_, i) => `brand term ${i}`) })).text).toContain('At most 20');
		expect((await call(writer, 'get_site_settings', { site: '1' })).data.brandTerms).toHaveLength(3); // the refused call changed nothing
		expect((await call(writer, 'set_brand_terms', { site: '1', terms: 'one brand, two brand' })).data.now).toEqual(['one brand', 'two brand']); // a plain comma-separated string works too
		const cleared = await call(writer, 'set_brand_terms', { site: '1', terms: [] });
		expect(cleared.data.before).toEqual(['one brand', 'two brand']);
		expect(cleared.data.now).toEqual([]);
		expect((await call(writer, 'get_site_settings', { site: '2' })).data.brandTerms).toEqual([]); // another site untouched
	});

	it('sync_site: starts one, and refuses another for the same site within five minutes', async () => {
		const first = await call(writer, 'sync_site', { site: '2' });
		expect(first.data.ok).toBe(true);
		const again = await call(writer, 'sync_site', { site: '2' });
		expect(again.isError).toBe(true);
		expect(again.text).toMatch(/less than 5 minutes ago\. Try again in about [1-5] minutes?/);
		expect((await call(writer, 'sync_site', { site: '1' })).data.ok).toBe(true); // another site is not held up by it
		await drain();
	});

	it('read_sitemaps: reads them, and refuses a second read within two minutes', async () => {
		const r = await call(writer, 'read_sitemaps', { site: '1' });
		expect(r.isError).toBe(false);
		expect(r.data).toMatchObject({ sitemapFiles: expect.any(Number), urls: expect.any(Number), sentToIndexNow: 0 });
		expect(r.data.urls).toBeGreaterThan(0);
		const again = await call(writer, 'read_sitemaps', { site: '1' });
		expect(again.isError).toBe(true);
		expect(again.text).toContain('less than 2 minutes ago');
	});

	it('run_onpage_check: only this site\'s pages, a daily budget, and the results are readable afterwards', async () => {
		expect((await call(writer, 'run_onpage_check', { site: '1', urls: ['https://evil.example/x', 'http://169.254.169.254/latest'] })).text).toBe('None of those URLs are on this site.');
		const r = await call(writer, 'run_onpage_check', { site: '1', urls: ['https://greenleaf.example/blog/garden-tools-1', 'https://evil.example/x'] });
		expect(r.data).toMatchObject({ checked: 1, couldNotBeFetched: 0, skippedNotOnThisSite: ['https://evil.example/x'] });
		expect((await call(writer, 'get_onpage_check', { site: '1', url: 'https://greenleaf.example/blog/garden-tools-1' })).data.pages).toHaveLength(1);
		const top = await call(writer, 'run_onpage_check', { site: '1' });
		expect(top.data.checked).toBeGreaterThan(1); // no urls: the pages with the most clicks
		const k = createApiKey('budget', null, null, true);
		const day = new Date().toISOString().slice(0, 10);
		db().prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(`mcp-onpage:${k.id}:${day}`, '199');
		const over = await call(k.key, 'run_onpage_check', { site: '1', urls: ['https://greenleaf.example/a', 'https://greenleaf.example/b'] });
		expect(over.text).toBe('This key has used its 200 page checks for today.');
		expect((await call(k.key, 'run_onpage_check', { site: '1', urls: ['https://greenleaf.example/a'] })).isError).toBe(false); // the 200th still fits
	});

	it('submit_indexnow: this site only, and the app\'s own safeguards still decide what goes out', async () => {
		expect((await call(writer, 'submit_indexnow', { site: '1', urls: ['https://evil.example/x'] })).text).toBe('Give full URLs that belong to this site.');
		const noKey = await call(writer, 'submit_indexnow', { site: '1', urls: ['https://greenleaf.example/a', 'https://evil.example/x'] });
		expect(noKey.data).toMatchObject({ accepted: 0, problem: 'Create a key first.', notOnThisSite: ['https://evil.example/x'] });
		createKey(1);
		const unverified = await call(writer, 'submit_indexnow', { site: '1', urls: ['https://greenleaf.example/a'] });
		expect(unverified.data.accepted).toBe(0); // the key file has not been verified on the host, so nothing is sent
		expect(unverified.data.note).toContain('not that the pages are indexed');
		expect(count('SELECT COUNT(*) n FROM indexnow_log WHERE site_id = 1')).toBe(0);
	});

	it('submit_indexnow: once the host is verified a URL goes out once, and only an explicit force resends it within 24 hours', async () => {
		db().prepare('INSERT OR REPLACE INTO indexnow_hosts (site_id, host, verified_at, ok, message) VALUES (1, ?, ?, 1, ?)').run('greenleaf.example', Date.now(), 'ok');
		const fetched: string[] = [];
		vi.stubGlobal('fetch', async (u: unknown) => (fetched.push(String(u)), new Response(null, { status: 200 })));
		try {
			const url = 'https://greenleaf.example/indexnow-once';
			expect((await call(writer, 'submit_indexnow', { site: '1', urls: [url, url] })).data).toMatchObject({ accepted: 1, skipped: [], problem: null }); // twice in the list, sent once
			expect(fetched).toHaveLength(1);
			const again = await call(writer, 'submit_indexnow', { site: '1', urls: [url] });
			expect(again.data.accepted).toBe(0);
			expect(again.data.skipped).toEqual(['1 already sent in the last 24 hours']);
			expect((await call(writer, 'submit_indexnow', { site: '1', urls: [url], force: 'yes' })).data.accepted).toBe(0); // only the boolean true forces
			expect((await call(writer, 'submit_indexnow', { site: '1', urls: [url], force: 1 })).data.accepted).toBe(0);
			expect(fetched).toHaveLength(1);
			expect((await call(writer, 'submit_indexnow', { site: '1', urls: [url], force: true })).data.accepted).toBe(1);
			expect(fetched).toHaveLength(2);
			expect(count('SELECT COUNT(*) n FROM indexnow_log WHERE site_id = 1')).toBe(2);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it('submit_sitemap: a sitemap on this site only', async () => {
		expect((await call(writer, 'submit_sitemap', { site: '1', sitemapUrl: 'https://evil.example/sitemap.xml' })).text).toContain('must be a full URL on this site');
		expect((await call(writer, 'submit_sitemap', { site: '1', sitemapUrl: 'javascript:alert(1)' })).isError).toBe(true);
		const ok = await call(writer, 'submit_sitemap', { site: '1', sitemapUrl: 'https://greenleaf.example/sitemap-extra.xml' });
		expect(ok.data).toMatchObject({ ok: true, submitted: 'https://greenleaf.example/sitemap-extra.xml' });
		expect(audits().some((a) => a.action === 'mcp.submit_sitemap' && a.detail.includes('sitemap-extra.xml'))).toBe(true);
	});

	it('watch_urls: adds this site\'s URLs to the watch list and leaves others out', async () => {
		expect((await call(writer, 'watch_urls', { site: '1', urls: ['https://evil.example/x'] })).isError).toBe(true);
		const r = await call(writer, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/watch-me', 'https://evil.example/y', 'not a url'] });
		expect(r.data).toMatchObject({ ok: true, watching: 1, notOnThisSite: ['https://evil.example/y', 'not a url'] });
		expect((await call(writer, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/dup', 'https://greenleaf.example/dup', 'https://greenleaf.example/dup'] })).data.watching).toBe(1); // a repeated URL counts once
		expect((await call(writer, 'get_indexing_status', { site: '1' })).data.watchList.map((w: string | { url: string }) => (typeof w === 'string' ? w : w.url))).toContain('https://greenleaf.example/watch-me');
	});
});

describe('the four new ways to read', () => {
	it('get_portfolio: a summary with totals, and each cross-site list', async () => {
		const s = (await call(reader, 'get_portfolio', {})).data;
		expect(s.totals.sites).toBeGreaterThan(1);
		expect(s.sites[0]).toMatchObject({ id: expect.any(Number), name: expect.any(String), clicks: expect.any(Number), ctr: expect.stringMatching(/%$/) });
		for (const type of ['striking', 'cannibalization', 'decay', 'anomalies']) expect(Array.isArray((await call(reader, 'get_portfolio', { type })).data), type).toBe(true);
		expect((await call(reader, 'get_portfolio', { type: 'striking', limit: 3 })).data.length).toBeLessThanOrEqual(3);
		expect((await call(reader, 'get_portfolio', { type: 'nope' })).text).toContain('must be one of');
		expect((await call(reader, 'get_portfolio', { type: 'striking' })).data[0]).toMatchObject({ siteId: expect.any(Number), query: expect.any(String), estimatedExtraClicksAtPos3: expect.any(Number) });
	});
	it('get_history: one query or one page, day by day, and exactly one of them', async () => {
		expect((await call(reader, 'get_history', { site: '1' })).text).toContain('exactly one of');
		expect((await call(reader, 'get_history', { site: '1', query: 'a', page: 'b' })).text).toContain('exactly one of');
		const h = (await call(reader, 'get_history', { site: '1', query: 'garden tools reviews', days: 28 })).data;
		expect(h.query).toBe('garden tools reviews');
		expect(h.days).toHaveLength(28);
		expect(h.days[0]).toMatchObject({ date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), clicks: expect.any(Number) });
		expect(h.days.some((d: { impressions: number }) => d.impressions > 0)).toBe(true);
		const none = (await call(reader, 'get_history', { site: '1', page: 'https://greenleaf.example/no-such-page', days: 7 })).data;
		expect(none.days).toHaveLength(7);
		expect(none.days.every((d: { impressions: number; position: number | null }) => d.impressions === 0 && d.position === null)).toBe(true);
	});
	it('get_site_settings: set-up, sync state and linked sources in one place', async () => {
		const s = (await call(reader, 'get_site_settings', { site: '1' })).data;
		expect(s).toMatchObject({ id: 1, serverReadOnlyMode: false, data: { syncedThrough: expect.any(String), fullHistoryDownloaded: expect.any(Boolean) }, sources: { bing: { linked: true }, clarity: { linked: false } } });
		expect(s.indexingMonitor).toEqual({ on: false, message: null });
	});
});

describe('the owner decides, on the sign-in page and on the Agents page', () => {
	const CLAUDE = 'https://claude.ai/api/mcp/auth_callback';
	const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
	const CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
	const allow = async (f: Record<string, string>) => {
		const c = registerClient('Claude', [CLAUDE])!;
		const chk = checkAuthorize('?' + new URLSearchParams({ response_type: 'code', client_id: c.id, redirect_uri: CLAUDE, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 's' }).toString(), config.origin);
		if (chk.kind !== 'consent') throw new Error('expected consent');
		const body = new FormData();
		body.set('request_id', chk.requestId);
		body.set('scope', 'all');
		for (const [k, v] of Object.entries(f)) body.set(k, v);
		const r = await (authorizePage.actions.allow as unknown as (e: never) => Promise<{ redirect: string }>)({ request: new Request('http://localhost/oauth/authorize', { method: 'POST', body }) } as never);
		const code = new URL(r.redirect).searchParams.get('code')!;
		const t = redeemCode({ code, clientId: c.id, redirectUri: CLAUDE, verifier: VERIFIER });
		if (!t.ok) throw new Error(t.description);
		return { client: c, ...t.body };
	};
	const canWrite = (token: string) => authenticate(new Request('http://x', { headers: { authorization: `Bearer ${token}` } }))?.canWrite;

	it('signing in without ticking the box gives a read-only connection, and it stays so when the token renews', async () => {
		const t = await allow({});
		expect(canWrite(t.access_token)).toBe(false);
		expect((await call(t.access_token, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/o1'] })).isError).toBe(true);
		const r = refreshTokens({ refreshToken: t.refresh_token, clientId: t.client.id });
		if (!r.ok) throw new Error(r.description);
		expect(canWrite(r.body.access_token)).toBe(false);
	});
	it('ticking "Also let it make changes" gives a connection that can, and it keeps that when the token renews', async () => {
		const t = await allow({ changes: 'on' });
		expect(canWrite(t.access_token)).toBe(true);
		expect((await call(t.access_token, 'watch_urls', { site: '1', urls: ['https://greenleaf.example/o2'] })).isError).toBe(false);
		const r = refreshTokens({ refreshToken: t.refresh_token, clientId: t.client.id });
		if (!r.ok) throw new Error(r.description);
		expect(canWrite(r.body.access_token)).toBe(true);
		expect(db().prepare("SELECT detail FROM audit_log WHERE action = 'oauth.approve' ORDER BY id DESC LIMIT 1").get()).toEqual({ detail: 'Claude (changes allowed)' });
	});
	it('only the exact value "on" counts; anything else on the consent form is read-only', async () => {
		for (const v of ['1', 'true', 'yes', 'off', '']) expect(canWrite((await allow({ changes: v })).access_token), v).toBe(false);
	});
	it('the owner can turn changes on or off later from the Agents page, and a new key starts read-only', async () => {
		const mk = async (f: Record<string, string>) => {
			const body = new FormData();
			body.set('name', 'agents page key');
			for (const [k, v] of Object.entries(f)) body.set(k, v);
			return (agentsPage.actions.create as unknown as (e: never) => Promise<{ newKey: string }>)({ request: new Request('http://x', { method: 'POST', body }) } as never);
		};
		const off = await mk({});
		expect(canWrite(off.newKey)).toBe(false);
		const on = await mk({ changes: 'on' });
		expect(canWrite(on.newKey)).toBe(true);
		const id = (db().prepare('SELECT id FROM api_keys WHERE prefix = ?').get(off.newKey.slice(0, 8)) as { id: number }).id;
		const toggle = (on: string) => {
			const body = new FormData();
			body.set('id', String(id));
			body.set('on', on);
			return (agentsPage.actions.changes as unknown as (e: never) => Promise<unknown>)({ request: new Request('http://x', { method: 'POST', body }) } as never);
		};
		await toggle('1');
		expect(canWrite(off.newKey)).toBe(true);
		await toggle('0');
		expect(canWrite(off.newKey)).toBe(false);
		const log = db().prepare("SELECT detail FROM audit_log WHERE action IN ('apikey.created', 'apikey.changes') ORDER BY id").all() as { detail: string }[];
		expect(log.map((l) => l.detail)).toEqual(expect.arrayContaining(['agents page key (read-only)', 'agents page key (changes allowed)', `key ${id}: changes allowed`, `key ${id}: read-only`]));
	});
	it('the Agents page shows what agents changed and who allowed what, newest first, and nothing else from the audit log', async () => {
		const k = createApiKey('activity key', null, null, true).key;
		await call(k, 'log_change', { site: '1', date: '2026-10-05', title: 'visible in the activity table' });
		audit('site.reset', { siteId: 1, detail: 'unrelated audit row' }); // another kind of audit entry
		db().prepare('INSERT INTO audit_log (at, action, site_id, account_id, detail) VALUES (?,?,?,?,?)').run(Date.now(), 'mcp.old_one', 1, null, 'x'); // the cap is by newest, not oldest
		const rows = (agentsPage.load as unknown as () => { activity: { at: number; action: string; siteId: number | null; detail: string | null }[] })().activity;
		expect(rows.length).toBeGreaterThan(5);
		expect(rows.length).toBeLessThanOrEqual(40);
		expect(rows.every((r) => r.action.startsWith('mcp.') || ['apikey.created', 'apikey.changes', 'oauth.approve'].includes(r.action))).toBe(true);
		const mine = rows.find((r) => r.detail?.includes('visible in the activity table'))!;
		expect(mine).toMatchObject({ action: 'mcp.log_change', siteId: 1 });
		expect(mine.detail).toContain('activity key:');
		expect(rows.map((r) => r.detail)).not.toContain('unrelated audit row');
		expect(rows.some((r) => r.action === 'oauth.approve')).toBe(true);
		expect(rows.some((r) => r.action === 'apikey.created')).toBe(true);
		for (let i = 1; i < rows.length; i++) expect(rows[i - 1].at).toBeGreaterThanOrEqual(rows[i].at);
		for (let i = 0; i < 45; i++) db().prepare('INSERT INTO audit_log (at, action, site_id, account_id, detail) VALUES (?,?,?,?,?)').run(Date.now() + i, 'mcp.filler', 1, null, `filler ${i}`);
		const capped = (agentsPage.load as unknown as () => { activity: { detail: string }[] })().activity;
		expect(capped).toHaveLength(40);
		expect(capped[0].detail).toBe('filler 44'); // the newest are kept
	});
	it('the consent page and the Agents page both say plainly what changes mean, and that deleting is never allowed', () => {
		const consent = readFileSync('src/routes/oauth/authorize/+page.svelte', 'utf8');
		expect(consent).toContain('name="changes"');
		expect(consent).not.toMatch(/name="changes"[^>]*checked/); // never pre-ticked
		expect(consent).toContain('(optional, off by default)');
		expect(consent).toContain('It can never delete anything, connect or disconnect accounts, or touch keys and passwords');
		const agents = readFileSync('src/routes/agents/+page.svelte', 'utf8');
		expect(agents).toContain('name="changes"');
		expect(agents).not.toMatch(/name="changes"[^>]*checked/);
		expect(agents).toContain('(off by default)');
		expect(agents).toContain('It can never delete or connect anything');
	});
});
