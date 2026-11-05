import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
	id INTEGER PRIMARY KEY,
	google_sub TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL,
	label TEXT,
	refresh_token_enc TEXT,
	access_token_enc TEXT,
	expires_at INTEGER,
	status TEXT NOT NULL DEFAULT 'active',     -- active | revoked
	is_demo INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
	id INTEGER PRIMARY KEY,
	account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	site_url TEXT NOT NULL,
	permission TEXT NOT NULL,
	hidden INTEGER NOT NULL DEFAULT 0,
	label TEXT,
	tags TEXT NOT NULL DEFAULT '',
	brand_terms TEXT NOT NULL DEFAULT '',
	synced_through TEXT,        -- newest date stored
	backfilled_to TEXT,         -- oldest date stored
	backfill_done INTEGER NOT NULL DEFAULT 0,
	last_sync_at INTEGER,
	sync_status TEXT NOT NULL DEFAULT 'idle',  -- idle | queued | running | error
	sync_message TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE(account_id, site_url)
);
CREATE TABLE IF NOT EXISTS site_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site_id, date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sa_rows (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	query TEXT NOT NULL,
	page TEXT NOT NULL,
	country TEXT NOT NULL,
	device TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site_id, date, query, page, country, device)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sa_rows_query ON sa_rows(site_id, query, date);
CREATE INDEX IF NOT EXISTS sa_rows_page ON sa_rows(site_id, page, date);
CREATE TABLE IF NOT EXISTS sync_runs (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	mode TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	finished_at INTEGER,
	days INTEGER NOT NULL DEFAULT 0,
	rows INTEGER NOT NULL DEFAULT 0,
	truncated_days INTEGER NOT NULL DEFAULT 0,
	error TEXT
);
CREATE TABLE IF NOT EXISTS annotations (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	title TEXT NOT NULL,
	note TEXT,
	kind TEXT NOT NULL DEFAULT 'change',   -- change | experiment | migration | other
	page_prefix TEXT,                      -- scope for before/after measurement
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS url_inspections (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	fetched_at INTEGER NOT NULL,
	result TEXT NOT NULL,
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY,
	at INTEGER NOT NULL,
	action TEXT NOT NULL,
	site_id INTEGER,
	account_id INTEGER,
	detail TEXT
);
CREATE TABLE IF NOT EXISTS integrations (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,                 -- bing | clarity | openseo
	label TEXT NOT NULL,
	secret_enc TEXT,                    -- encrypted JSON: api key / tokens
	meta TEXT NOT NULL DEFAULT '{}',    -- non-secret JSON: auth type, base url, ...
	status TEXT NOT NULL DEFAULT 'active',
	is_demo INTEGER NOT NULL DEFAULT 0,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_links (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,                 -- bing | ga4 | clarity | openseo
	integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE,
	account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,   -- ga4: which Google account
	external_id TEXT NOT NULL,          -- bing site url | properties/123 | clarity label | openseo project id
	label TEXT,
	last_sync_at INTEGER,
	sync_status TEXT NOT NULL DEFAULT 'idle',
	sync_message TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, kind)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bing_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL, clicks INTEGER NOT NULL, impressions INTEGER NOT NULL,
	PRIMARY KEY (site_id, date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS bing_terms (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	kind TEXT NOT NULL,                 -- query | page
	date TEXT NOT NULL, term TEXT NOT NULL,
	clicks INTEGER NOT NULL, impressions INTEGER NOT NULL, click_pos REAL, impr_pos REAL,
	PRIMARY KEY (site_id, kind, date, term)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL, channel TEXT NOT NULL,
	sessions INTEGER NOT NULL, engaged_sessions INTEGER NOT NULL, users INTEGER NOT NULL,
	key_events REAL NOT NULL, pageviews INTEGER NOT NULL,
	PRIMARY KEY (site_id, date, channel)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_period_users (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,              -- window length ending on pulled_on
	channel TEXT NOT NULL,
	users INTEGER NOT NULL,             -- unique users over the whole window (not a sum of daily users)
	pulled_on TEXT NOT NULL,
	PRIMARY KEY (site_id, days, channel)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_landing (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,
	page TEXT NOT NULL,                 -- landing path, no query string
	sessions INTEGER NOT NULL,
	engaged_sessions INTEGER NOT NULL,
	key_events REAL NOT NULL,
	pulled_on TEXT NOT NULL,            -- Google organic only
	PRIMARY KEY (site_id, days, page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS clarity_snapshots (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	day TEXT NOT NULL,                  -- UTC day the call was made (data covers the preceding 24h)
	dimension TEXT NOT NULL,            -- '' | URL | Device ...
	payload TEXT NOT NULL, fetched_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, day, dimension)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS clarity_calls (
	integration_id INTEGER NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
	day TEXT NOT NULL, n INTEGER NOT NULL,
	PRIMARY KEY (integration_id, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS site_daily_type (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	search_type TEXT NOT NULL,          -- image | video | news | discover | googleNews (web lives in site_daily)
	date TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site_id, search_type, date)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS site_appearance (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,              -- window length ending on pulled_on
	appearance TEXT NOT NULL,           -- Google's searchAppearance value, e.g. RICH_RESULT
	pulled_on TEXT NOT NULL,
	clicks INTEGER NOT NULL,
	impressions INTEGER NOT NULL,
	position REAL NOT NULL,
	PRIMARY KEY (site_id, days, appearance)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS api_keys (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
	site_ids TEXT,                      -- JSON array, NULL = all sites
	created_at INTEGER NOT NULL, last_used_at INTEGER
);
`;

declare global {
	// eslint-disable-next-line no-var
	var __openSiteConsoleDb: Database.Database | undefined;
}

/** Additive column migrations for databases created by an earlier version. */
function migrate(db: Database.Database) {
	const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name);
	if (!cols('accounts').includes('scopes')) db.exec("ALTER TABLE accounts ADD COLUMN scopes TEXT NOT NULL DEFAULT ''");
	if (!cols('sites').includes('types_synced_at')) db.exec('ALTER TABLE sites ADD COLUMN types_synced_at INTEGER');
	if (!cols('sites').includes('appearance_pulled_on')) db.exec('ALTER TABLE sites ADD COLUMN appearance_pulled_on TEXT');
	if (!cols('sites').includes('ga4_periods_on')) db.exec('ALTER TABLE sites ADD COLUMN ga4_periods_on TEXT');
	// v1: earlier versions could mark a property "fully backfilled" after one empty stretch, or never start walking
	// back at all. Re-open every backfill; it resumes from the stored cursor, so nothing already stored is re-downloaded.
	const version = db.pragma('user_version', { simple: true }) as number;
	if (version < 1) {
		db.exec('UPDATE sites SET backfill_done = 0');
		db.pragma('user_version = 1');
	}
}

export function openDb(path: string): Database.Database {
	if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.pragma('synchronous = NORMAL');
	db.exec(SCHEMA);
	migrate(db);
	return db;
}

export function db(): Database.Database {
	return (globalThis.__openSiteConsoleDb ??= openDb(config.dbPath));
}

export function audit(action: string, opts: { siteId?: number; accountId?: number; detail?: string } = {}) {
	db()
		.prepare('INSERT INTO audit_log (at, action, site_id, account_id, detail) VALUES (?,?,?,?,?)')
		.run(Date.now(), action, opts.siteId ?? null, opts.accountId ?? null, opts.detail ?? null);
}
