import { beforeEach, describe, expect, it } from 'vitest';
import { db, openDb } from '../src/lib/server/db';
import { getSite } from '../src/lib/server/clients';
import { STALE_AFTER_MS, actionsFor, buildActions, connectionProblem, queueFor } from '../src/lib/server/actions';
import { runUrgentAlerts } from '../src/lib/server/digest';
import { ACTION_TYPES } from '../src/lib/actions';

/**
 * A Google account that stops working, or syncs that keep failing, used to be visible only on screens: the scheduler skips a
 * revoked account and a failing site just stays old. These checks make it a blocking item, which the urgent-alert webhook sends.
 */
const HOUR = 3600_000;
const DAY = 24 * HOUR;
const siteRow = () => getSite(1)!;
const connection = () => buildActions(siteRow()).filter((a) => a.type === 'connection');

beforeEach(() => {
	process.env.SCHEDULER = '0';
	delete process.env.DEMO_MODE;
	globalThis.__openSiteConsoleDb = openDb(':memory:');
	const d = db();
	d.prepare("INSERT INTO accounts (id, google_sub, email, status, created_at) VALUES (1, 's', 'owner@example.com', 'active', 1)").run();
	d.prepare("INSERT INTO sites (id, account_id, site_url, permission, synced_through, backfill_done, backfilled_to, last_sync_at, created_at) VALUES (1, 1, 'https://example.com/', 'siteOwner', '2026-11-03', 1, '2026-01-01', ?, 1)").run(Date.now() - HOUR);
});

describe('connection problems', () => {
	it('says nothing while the site synced recently', () => {
		expect(connectionProblem(siteRow())).toBeNull();
		expect(connection()).toEqual([]);
	});

	it('flags a site whose last successful sync is older than 48 hours, and names how long', () => {
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(Date.now() - 3 * DAY - HOUR);
		const items = connection();
		expect(items).toHaveLength(1);
		expect(items[0]).toMatchObject({ key: 'connection:stale', blocking: true, href: '/sites/1', impact: null });
		expect(items[0].title).toContain('3 days');
		// It names no account and no error text, which privacy mode could not blur.
		expect(JSON.stringify(items[0])).not.toContain('example.com');
		expect(JSON.stringify(items[0])).not.toContain('owner@');
	});

	it('does not flag just under 48 hours', () => {
		const now = Date.now();
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(now - STALE_AFTER_MS + 5 * 60_000);
		expect(connectionProblem(siteRow(), now)).toBeNull();
		expect(connectionProblem(siteRow(), now + 10 * 60_000)).toMatchObject({ kind: 'stale' });
	});

	it('flags a revoked account with one item, pointing at Accounts, and not also as stale', () => {
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(Date.now() - 5 * DAY);
		const items = connection();
		expect(items.map((a) => a.key)).toEqual(['connection:revoked']);
		expect(items[0]).toMatchObject({ blocking: true, href: '/accounts' });
		expect(items[0].why).toMatch(/Nothing has been downloaded since \d{4}-\d{2}-\d{2}/);
	});

	it('flags a revoked account even when the site synced an hour ago', () => {
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
		expect(connection().map((a) => a.key)).toEqual(['connection:revoked']);
	});

	it('leaves alone sites that are not expected to sync: hidden, removed or unverified, and never-synced ones', () => {
		const old = Date.now() - 9 * DAY;
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(old);
		db().prepare('UPDATE sites SET hidden = 1 WHERE id = 1').run();
		expect(connection()).toEqual([]);
		db().prepare("UPDATE sites SET hidden = 0, permission = 'none' WHERE id = 1").run();
		expect(connection()).toEqual([]);
		db().prepare("UPDATE sites SET permission = 'siteUnverifiedUser' WHERE id = 1").run();
		expect(connection()).toEqual([]);
		db().prepare("UPDATE sites SET permission = 'siteOwner', last_sync_at = NULL WHERE id = 1").run();
		expect(connection()).toEqual([]);
	});

	it('never fires for demo accounts', () => {
		db().prepare('UPDATE accounts SET is_demo = 1 WHERE id = 1').run();
		db().prepare('UPDATE sites SET last_sync_at = ? WHERE id = 1').run(Date.now() - 9 * DAY);
		expect(connection()).toEqual([]);
	});

	it('the cached queue follows the problem in both directions without any sync in between', () => {
		expect(actionsFor(siteRow()).some((a) => a.type === 'connection')).toBe(false);
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
		expect(actionsFor(siteRow()).some((a) => a.key === 'connection:revoked')).toBe(true);
		db().prepare("UPDATE accounts SET status = 'active' WHERE id = 1").run();
		expect(actionsFor(siteRow()).some((a) => a.type === 'connection')).toBe(false);
	});

	it('ranks first, ahead of the other blocking items', () => {
		db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
		const open = queueFor(siteRow()).open;
		expect(open[0].type).toBe('connection');
		expect(ACTION_TYPES[0]).toBe('connection');
	});
});

describe('the alert goes out through the webhook, once', () => {
	it('sends a revoked account to the digest webhook, and does not repeat it on the next run', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example.com/x';
		try {
			db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = 1").run();
			const posted: string[] = [];
			const fakeFetch = (async (_u: string, init: { body: string }) => {
				posted.push(init.body);
				return new Response('ok', { status: 200 });
			}) as unknown as typeof fetch;
			const first = await runUrgentAlerts({ fetchImpl: fakeFetch });
			expect(first).toMatchObject({ alerted: 1, delivery: 'sent' });
			expect(posted.join('')).toContain('Google access was withdrawn');
			const second = await runUrgentAlerts({ fetchImpl: fakeFetch });
			expect(second.alerted).toBe(0);
			expect(posted).toHaveLength(1);
		} finally {
			delete process.env.DIGEST_WEBHOOK_URL;
		}
	});
});
