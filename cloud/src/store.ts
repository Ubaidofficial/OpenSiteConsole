import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Status = 'provisioning' | 'deploying' | 'active' | 'past_due' | 'suspended' | 'canceled' | 'failed' | 'destroyed';

export interface Customer {
	id: number;
	signup_id: string;
	email: string;
	stripe_customer: string;
	stripe_subscription: string;
	checkout_session_id: string;
	slug: string;
	status: Status;
	sub_status: string;
	coolify_uuid: string | null;
	env_progress: number;
	domain_done: number;
	deployed_at: number | null;
	active_at: number | null;
	past_due_since: number | null;
	canceled_at: number | null;
	destroy_after: number | null;
	attempts: number;
	next_try_at: number;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

export interface Signup { id: string; email: string; password_hash: string; created_at: number; checkout_session_id: string | null; consumed: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS signups (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL,
	password_hash TEXT NOT NULL,        -- scrypt hash the customer chose; cleared once their instance has it
	created_at INTEGER NOT NULL,
	checkout_session_id TEXT,
	consumed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS customers (
	id INTEGER PRIMARY KEY,
	signup_id TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL,
	stripe_customer TEXT NOT NULL,
	stripe_subscription TEXT NOT NULL UNIQUE,
	checkout_session_id TEXT NOT NULL UNIQUE,
	slug TEXT NOT NULL UNIQUE,
	status TEXT NOT NULL,
	sub_status TEXT NOT NULL DEFAULT 'active',
	coolify_uuid TEXT,
	env_progress INTEGER NOT NULL DEFAULT 0,   -- how many instance settings are already stored in Coolify (a retry resumes after them)
	domain_done INTEGER NOT NULL DEFAULT 0,
	deployed_at INTEGER,
	active_at INTEGER,
	past_due_since INTEGER,
	canceled_at INTEGER,
	destroy_after INTEGER,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_try_at INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS stripe_events (
	id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	received_at INTEGER NOT NULL,
	processed_at INTEGER
);
`;

export type Store = ReturnType<typeof openStore>;

export function openStore(path: string) {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.exec(SCHEMA);
	const now = () => Date.now();

	return {
		raw: db,
		createSignup(s: { id: string; email: string; passwordHash: string }) {
			db.prepare('INSERT INTO signups (id, email, password_hash, created_at) VALUES (?,?,?,?)').run(s.id, s.email, s.passwordHash, now());
		},
		signup: (id: string) => db.prepare('SELECT * FROM signups WHERE id = ?').get(id) as Signup | undefined,
		attachCheckout(signupId: string, sessionId: string) {
			db.prepare('UPDATE signups SET checkout_session_id = ? WHERE id = ?').run(sessionId, signupId);
		},
		/** The instance has its password hash now: do not keep it. */
		consumeSignup(id: string) {
			db.prepare("UPDATE signups SET password_hash = '', consumed = 1 WHERE id = ?").run(id);
		},
		/** Unpaid sign-ups older than this are removed, so abandoned checkouts do not pile up password hashes. */
		purgeStaleSignups(olderThanMs: number) {
			return db.prepare('DELETE FROM signups WHERE consumed = 0 AND created_at < ?').run(now() - olderThanMs).changes;
		},
		customerBySubscription: (sub: string) => db.prepare('SELECT * FROM customers WHERE stripe_subscription = ?').get(sub) as Customer | undefined,
		customerBySession: (cs: string) => db.prepare('SELECT * FROM customers WHERE checkout_session_id = ?').get(cs) as Customer | undefined,
		customerBySlug: (slug: string) => db.prepare('SELECT * FROM customers WHERE slug = ?').get(slug) as Customer | undefined,
		customer: (id: number) => db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Customer | undefined,
		createCustomer(c: { signupId: string; email: string; stripeCustomer: string; stripeSubscription: string; checkoutSessionId: string; slug: string }): Customer {
			const t = now();
			const r = db
				.prepare("INSERT INTO customers (signup_id, email, stripe_customer, stripe_subscription, checkout_session_id, slug, status, created_at, updated_at) VALUES (?,?,?,?,?,?, 'provisioning', ?, ?)")
				.run(c.signupId, c.email, c.stripeCustomer, c.stripeSubscription, c.checkoutSessionId, c.slug, t, t);
			return db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid)) as Customer;
		},
		update(id: number, patch: Partial<Omit<Customer, 'id'>>) {
			const keys = Object.keys(patch) as (keyof typeof patch)[];
			if (!keys.length) return;
			const sets = keys.map((k) => `${String(k)} = ?`).join(', ');
			db.prepare(`UPDATE customers SET ${sets}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => patch[k] as never), now(), id);
		},
		/** Customers the reconcile loop should look at now. */
		due(nowMs: number): Customer[] {
			return db.prepare("SELECT * FROM customers WHERE status IN ('provisioning','deploying','failed','past_due','canceled') ORDER BY id").all() as Customer[];
		},
		all: () => db.prepare('SELECT * FROM customers ORDER BY id').all() as Customer[],
		/** true if this event was already fully handled. Otherwise it is recorded as received (a crash before processed_at means it is handled again). */
		eventSeen(id: string, type: string): boolean {
			const row = db.prepare('SELECT processed_at FROM stripe_events WHERE id = ?').get(id) as { processed_at: number | null } | undefined;
			if (row) return row.processed_at !== null;
			db.prepare('INSERT INTO stripe_events (id, type, received_at) VALUES (?,?,?)').run(id, type, now());
			return false;
		},
		eventDone(id: string) {
			db.prepare('UPDATE stripe_events SET processed_at = ? WHERE id = ?').run(now(), id);
		},
		close: () => db.close()
	};
}
