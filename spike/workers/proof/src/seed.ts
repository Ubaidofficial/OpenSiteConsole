import { q, type Stmt } from './db';
import { FIXTURE_SITES } from './fixture';

/** Same rows go into better-sqlite3 (original) and D1 (port). Timestamps are fixed so dumps are comparable. */
export const SEED: Stmt[] = [
	q("INSERT INTO accounts (id, google_sub, email, label, status, is_demo, created_at) VALUES (1, 'fixture-a', 'owner@example.com', 'Fixture', 'active', 0, 1700000000000)"),
	...FIXTURE_SITES.map((url, i) => q("INSERT INTO sites (id, account_id, site_url, permission, created_at) VALUES (?, 1, ?, 'siteOwner', 1700000000000)", i + 1, url))
];

/** Child tables first so the delete order never trips a foreign key. */
export const RESET: Stmt[] = ['sa_rows', 'site_daily', 'site_daily_type', 'site_appearance', 'sync_runs', 'kv', 'sites', 'accounts'].map((t) => q(`DELETE FROM ${t}`));
