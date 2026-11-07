import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { ensureDemoAccounts } from '../src/lib/server/accounts';
import { getSite } from '../src/lib/server/clients';
import { asPermission, authenticate, createApiKey, permits, type Permission } from '../src/lib/server/apikeys';
import { CONFIRM_TTL_MS, MAX_OUTSTANDING, consumeConfirmation, issueConfirmation } from '../src/lib/server/confirm';
import { handleMcp, resetRateLimits } from '../src/lib/server/mcp';
import { submitSitemapTo } from '../src/lib/server/submission';
import { queueStatus } from '../src/lib/server/submission';

const site = () => getSite(1)!;
const U = (p: string) => `https://greenleaf.example${p}`;
const B = (o: Partial<{ keyId: number; tool: string; siteId: number; target: string }> = {}) => ({ keyId: 1, tool: 'delete_sitemap', siteId: 1, target: U('/a.xml'), ...o });
const confirmRows = () => (db().prepare("SELECT COUNT(*) n FROM kv WHERE key LIKE 'confirm:%'").get() as { n: number }).n;

beforeAll(async () => {
	process.env.DEMO_MODE = '1';
	process.env.SCHEDULER = '0';
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	await ensureDemoAccounts();
});
beforeEach(() => {
	db().prepare("DELETE FROM kv WHERE key LIKE 'confirm:%'").run();
	db().prepare('DELETE FROM index_queue').run();
	db().prepare('DELETE FROM audit_log').run();
	delete process.env.READ_ONLY;
});

describe('three permission levels', () => {
	it('each level includes the one before it, and anything unknown is read-only', () => {
		const levels: Permission[] = ['read', 'submit', 'delete'];
		for (const have of levels) for (const need of levels) expect(permits(have, need), `${have} -> ${need}`).toBe(levels.indexOf(have) >= levels.indexOf(need));
		expect(asPermission('delete')).toBe('delete');
		expect(asPermission('submit')).toBe('submit');
		for (const junk of ['root', 'admin', '', null, undefined, 3, 'DELETE']) expect(asPermission(junk), String(junk)).toBe('read');
	});
	it('a key keeps the level it was made with', () => {
		const req = (k: string) => new Request('http://x', { headers: { authorization: `Bearer ${k}` } });
		expect(authenticate(req(createApiKey('d', null, null, 'delete').key))?.permission).toBe('delete');
		expect(authenticate(req(createApiKey('s', null, null, 'submit').key))?.permission).toBe('submit');
		expect(authenticate(req(createApiKey('r', null).key))?.permission).toBe('read');
		expect(authenticate(req(createApiKey('junk', null, null, 'root' as never).key))?.permission).toBe('read');
	});
});

describe('confirmation tokens', () => {
	it('work once: the second use fails', () => {
		const { token } = issueConfirmation(B());
		expect(token).toMatch(/^cf_[A-Za-z0-9_-]{20,}$/);
		expect(consumeConfirmation(token, B())).toEqual({ ok: true });
		expect(consumeConfirmation(token, B())).toMatchObject({ ok: false, reason: expect.stringMatching(/unknown or was already used/) });
		expect(confirmRows()).toBe(0);
	});
	it('are bound to the key, the tool, the site and the target, and a wrong attempt spends the token', () => {
		const cases: [string, Partial<Parameters<typeof B>[0]>, RegExp][] = [
			['another key', { keyId: 2 }, /different API key/],
			['another tool', { tool: 'cancel_indexing_queue' }, /different action, site or target/],
			['another site', { siteId: 2 }, /different action, site or target/],
			['another target', { target: U('/b.xml') }, /different action, site or target/]
		];
		for (const [label, wrong, re] of cases) {
			const { token } = issueConfirmation(B());
			const bad = consumeConfirmation(token, B(wrong));
			expect(bad.ok, label).toBe(false);
			expect((bad as { reason: string }).reason, label).toMatch(re);
			expect(consumeConfirmation(token, B()).ok, `${label}: the right attempt after a wrong one`).toBe(false); // spent
		}
	});
	it('expire after ten minutes', () => {
		const now = Date.now();
		const a = issueConfirmation(B(), now);
		expect(a.expiresAt).toBe(now + CONFIRM_TTL_MS);
		expect(consumeConfirmation(a.token, B(), now + CONFIRM_TTL_MS - 1)).toEqual({ ok: true });
		const b = issueConfirmation(B(), now);
		expect(consumeConfirmation(b.token, B(), now + CONFIRM_TTL_MS)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
	});
	it('asking again for the same action replaces the earlier token; expired ones are swept; one key cannot pile them up', () => {
		const first = issueConfirmation(B());
		const second = issueConfirmation(B());
		expect(consumeConfirmation(first.token, B()).ok).toBe(false);
		expect(consumeConfirmation(second.token, B()).ok).toBe(true);
		const now = Date.now();
		issueConfirmation(B({ target: U('/old.xml') }), now - 2 * CONFIRM_TTL_MS);
		issueConfirmation(B({ target: U('/new.xml') }), now);
		expect(confirmRows()).toBe(1); // the lapsed one was swept when the next was issued
		db().prepare("DELETE FROM kv WHERE key LIKE 'confirm:%'").run();
		for (let i = 0; i < MAX_OUTSTANDING; i++) issueConfirmation(B({ target: U(`/s${i}.xml`) }), now);
		expect(() => issueConfirmation(B({ target: U('/one-too-many.xml') }), now)).toThrow(/confirmations waiting/);
		expect(() => issueConfirmation(B({ keyId: 99, target: U('/other-key.xml') }), now)).not.toThrow();
	});
});

describe('the MCP gate', () => {
	let readKey = '', submitKey = '', deleteKey = '', deleteKey2 = '';
	const call = async (k: string, name: string, args: object = {}) => {
		resetRateLimits();
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${k}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
		const r = (await res.json()).result;
		const text = r.content[0].text as string;
		return { isError: !!r.isError, data: r.isError ? text : JSON.parse(text) };
	};
	const listed = async () => ((await call(readKey, 'get_sitemaps', { site: '1' })).data.sitemaps as { path: string }[]).map((x) => x.path);
	beforeAll(() => {
		readKey = createApiKey('c-read', null).key;
		submitKey = createApiKey('c-submit', null, null, 'submit').key;
		deleteKey = createApiKey('c-delete', null, null, 'delete').key;
		deleteKey2 = createApiKey('c-delete-2', null, null, 'delete').key;
	});

	it('the two tools that cannot be undone need the delete level; a submit key is refused, and says what it lacks', async () => {
		for (const name of ['delete_sitemap', 'cancel_indexing_queue']) {
			for (const [k, level] of [[readKey, 'read'], [submitKey, 'submit']] as const) {
				const r = await call(k, name, { site: '1', sitemap_url: U('/a.xml') });
				expect(r.isError, `${name} with ${level}`).toBe(true);
				expect(r.data).toMatch(/needs an API key created with the "delete" permission/);
				expect(r.data).toContain(`This key has "${level}"`);
			}
		}
		expect(confirmRows()).toBe(0);
	});
	it('a delete key can do everything a submit key can', async () => {
		const r = await call(deleteKey, 'setup_indexnow', { site: '1', action: 'create_key' });
		expect(r.isError).toBe(false);
		expect(r.data.keyFile.name).toMatch(/\.txt$/);
	});

	it('delete_sitemap: the first call removes nothing and shows what is held; the second, with the token, removes it; the token is then spent', async () => {
		const feed = U('/c-one.xml');
		await submitSitemapTo(site(), feed, 'mcp');
		const first = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed });
		expect(first.isError).toBe(false);
		expect(first.data).toMatchObject({ needsConfirmation: true, willRemove: feed, searchConsoleHolds: expect.objectContaining({ errors: expect.any(Number) }), confirmationToken: expect.stringMatching(/^cf_/) });
		expect(first.data.next).toMatch(/Nothing has been removed/);
		expect(new Date(first.data.expiresAt).getTime()).toBeGreaterThan(Date.now());
		expect(await listed()).toContain(feed);
		const done = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed, confirmation_token: first.data.confirmationToken });
		expect(done.data.removed).toBe(feed);
		expect(await listed()).not.toContain(feed);
		const again = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed, confirmation_token: first.data.confirmationToken });
		expect(again.isError).toBe(true);
		expect(again.data).toMatch(/Nothing was removed\. That confirmation token is unknown or was already used/);
		expect((db().prepare("SELECT detail FROM audit_log WHERE action = 'sitemap.deleted'").get() as { detail: string }).detail).toBe(`${feed} (mcp)`);
	});
	it('delete_sitemap: a token for one sitemap cannot remove another, and neither can another key\'s token', async () => {
		const a = U('/c-a.xml'), b = U('/c-b.xml');
		await submitSitemapTo(site(), a, 'mcp');
		await submitSitemapTo(site(), b, 'mcp');
		const forA = (await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: a })).data.confirmationToken;
		const wrong = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: b, confirmation_token: forA });
		expect(wrong.isError).toBe(true);
		expect(wrong.data).toMatch(/different action, site or target/);
		expect(await listed()).toEqual(expect.arrayContaining([a, b]));
		const forB = (await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: b })).data.confirmationToken;
		const stolen = await call(deleteKey2, 'delete_sitemap', { site: '1', sitemap_url: b, confirmation_token: forB });
		expect(stolen.isError).toBe(true);
		expect(stolen.data).toMatch(/different API key/);
		expect(await listed()).toEqual(expect.arrayContaining([a, b]));
	});
	it('delete_sitemap: an expired token removes nothing, and the old confirm: true flag is just ignored', async () => {
		const feed = U('/c-exp.xml');
		await submitSitemapTo(site(), feed, 'mcp');
		const tok = (await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed })).data.confirmationToken as string;
		const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(`confirm:${tok}`) as { value: string };
		db().prepare('UPDATE kv SET value = ? WHERE key = ?').run(JSON.stringify({ ...JSON.parse(row.value), expires: Date.now() - 1000 }), `confirm:${tok}`);
		const late = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed, confirmation_token: tok });
		expect(late.isError).toBe(true);
		expect(late.data).toMatch(/expired/);
		expect(await listed()).toContain(feed);
		const legacy = await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: feed, confirm: true });
		expect(legacy.data.needsConfirmation).toBe(true); // an agent that just passes confirm: true no longer deletes anything
		expect(await listed()).toContain(feed);
	});
	it('delete_sitemap: an address outside the property or one Search Console does not hold is refused before any token is issued; a read-only server refuses too', async () => {
		const before = confirmRows();
		expect((await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: 'https://other.example/s.xml' })).data).toMatch(/outside the property/);
		expect((await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: 'nonsense' })).data).toMatch(/full sitemap address/);
		expect((await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: U('/never-submitted.xml') })).data).toMatch(/lists no sitemap at/);
		process.env.READ_ONLY = '1';
		expect((await call(deleteKey, 'delete_sitemap', { site: '1', sitemap_url: U('/c-a.xml') })).data).toMatch(/READ_ONLY=1/);
		expect(confirmRows()).toBe(before);
	});

	it('cancel_indexing_queue: nothing queued means nothing to confirm; otherwise a token bound to the channel discards exactly that share', async () => {
		expect((await call(deleteKey, 'cancel_indexing_queue', { site: '1' })).data).toMatchObject({ removed: 0, remaining: 0 });
		expect(confirmRows()).toBe(0);
		const ins = db().prepare("INSERT INTO index_queue (site_id, url, channel, added_at, release_at, first_release_at, source) VALUES (1,?,?,?,?,?, 'app')");
		const t = Date.now() + 86_400_000;
		ins.run(U('/q1'), 'bing', t, t, t); ins.run(U('/q2'), 'bing', t, t, t); ins.run(U('/q3'), 'indexnow', t, t, t);
		const first = await call(deleteKey, 'cancel_indexing_queue', { site: '1', channel: 'bing' });
		expect(first.data).toMatchObject({ needsConfirmation: true, willDiscard: 2, queued: { total: 3 } });
		expect(queueStatus(1).total).toBe(3);
		const wrongScope = await call(deleteKey, 'cancel_indexing_queue', { site: '1', confirmation_token: first.data.confirmationToken }); // the token was for bing only
		expect(wrongScope.isError).toBe(true);
		expect(queueStatus(1).total).toBe(3);
		const again = (await call(deleteKey, 'cancel_indexing_queue', { site: '1', channel: 'bing' })).data.confirmationToken;
		const done = await call(deleteKey, 'cancel_indexing_queue', { site: '1', channel: 'bing', confirmation_token: again });
		expect(done.data).toMatchObject({ removed: 2, remaining: 1 });
		expect(queueStatus(1).byChannel).toMatchObject({ bing: 0, indexnow: 1 });
	});
});

describe('the Agents page and the tool list', () => {
	it('creates a key at the level chosen, defaults to read-only, ignores anything else, and a read-only server grants only read', async () => {
		const mod = await import('../src/routes/agents/+page.server');
		const make = async (fields: Record<string, string>) => {
			const body = new FormData();
			body.set('name', 'agent');
			for (const [k, v] of Object.entries(fields)) body.set(k, v);
			const r = (await (mod.actions as unknown as Record<string, (e: never) => Promise<{ newKey: string; newKeyPermission: Permission }>>).create({ request: new Request('http://x', { method: 'POST', body }) } as never));
			expect(authenticate(new Request('http://x', { headers: { authorization: `Bearer ${r.newKey}` } }))?.permission).toBe(r.newKeyPermission);
			return r.newKeyPermission;
		};
		expect(await make({})).toBe('read');
		expect(await make({ permission: 'submit' })).toBe('submit');
		expect(await make({ permission: 'delete' })).toBe('delete');
		expect(await make({ permission: 'god' })).toBe('read');
		expect((db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action IN ('apikey.created_submit','apikey.created_delete')").get() as { n: number }).n).toBe(2);
		process.env.READ_ONLY = '1';
		expect(await make({ permission: 'delete' })).toBe('read');
	});

	it('the tool definitions stay small, and every tool that changes something says which permission it needs', async () => {
		const key = createApiKey('size', null).key;
		const res = await handleMcp(new Request('http://x/api/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) }));
		const text = await res.text();
		const tools = JSON.parse(text).result.tools as { name: string; description: string; annotations: { readOnlyHint: boolean; destructiveHint?: boolean } }[];
		// Every client pays for these definitions at the start of every session. They were 38 KB; this keeps them from creeping back.
		expect(text.length, `tools/list is ${text.length} bytes`).toBeLessThan(33_500);
		for (const t of tools) {
			expect(JSON.stringify(t).length, `${t.name} definition`).toBeLessThan(1_600);
			expect(t.description.length, `${t.name} description`).toBeLessThan(600);
		}
		for (const t of tools.filter((x) => !x.annotations.readOnlyHint)) expect(t.description, t.name).toMatch(/(submit|delete) permission/);
		for (const n of ['delete_sitemap', 'cancel_indexing_queue']) {
			const t = tools.find((x) => x.name === n)!;
			expect(t.description).toMatch(/confirmation_token/);
			expect(t.description).toMatch(/Two calls/);
			expect(t.annotations.destructiveHint).toBe(true);
		}
		expect(tools.find((t) => t.name === 'get_page_insights')!.description).toMatch(/`notes`/); // the caveats moved into the answer
	});
});
