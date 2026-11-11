import { safeRegex } from '../trends';
import Database from 'better-sqlite3';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
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
	kind TEXT NOT NULL,                 -- bing | ga4 | gtm | clarity | openseo
	integration_id INTEGER REFERENCES integrations(id) ON DELETE CASCADE,
	account_id INTEGER REFERENCES accounts(id) ON DELETE CASCADE,   -- ga4: which Google account
	external_id TEXT NOT NULL,          -- bing site url | properties/123 | accounts/1/containers/2 | clarity label | openseo project id
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
CREATE TABLE IF NOT EXISTS crux_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,                 -- the day we took the snapshot (CrUX is a rolling 28-day window)
	form_factor TEXT NOT NULL,          -- PHONE | DESKTOP
	origin TEXT NOT NULL,               -- the origin CrUX had data for
	lcp REAL, inp REAL, cls REAL, fcp REAL, ttfb REAL,   -- p75
	lcp_good REAL, inp_good REAL, cls_good REAL,         -- share of loads rated good
	PRIMARY KEY (site_id, date, form_factor)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_landing_prev (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,              -- the window length; this is the equally long window just BEFORE the one in ga4_landing
	page TEXT NOT NULL,
	sessions INTEGER NOT NULL,
	engaged_sessions INTEGER NOT NULL,
	key_events REAL NOT NULL,
	pulled_on TEXT NOT NULL,
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
CREATE TABLE IF NOT EXISTS gtm_snapshots (
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	container_path TEXT NOT NULL,       -- accounts/123/containers/456
	public_id TEXT, name TEXT,          -- GTM-XXXXXXX and the container's name
	domains TEXT NOT NULL DEFAULT '[]', -- JSON array: the container's domainName values
	live_version_id TEXT,               -- NULL when the container has never been published
	live_version_name TEXT,
	ga4_measurement_ids TEXT NOT NULL DEFAULT '[]',  -- JSON array: the linked GA4 property's web-stream IDs, for the cross-check
	payload TEXT NOT NULL,              -- JSON {tags, triggers, variables}: compact summaries of the live version
	fetched_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_ai (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,
	assistant TEXT NOT NULL,            -- ChatGPT | Perplexity | Gemini | Claude | Copilot
	page TEXT NOT NULL,                 -- landing path, no query string
	sessions INTEGER NOT NULL,
	engaged_sessions INTEGER NOT NULL,
	key_events REAL NOT NULL,
	pulled_on TEXT NOT NULL,
	PRIMARY KEY (site_id, days, assistant, page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_ai_prev (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,              -- the window length; this is the equally long window just BEFORE the one in ga4_ai
	assistant TEXT NOT NULL,
	page TEXT NOT NULL,
	sessions INTEGER NOT NULL,
	engaged_sessions INTEGER NOT NULL,
	key_events REAL NOT NULL,
	pulled_on TEXT NOT NULL,
	PRIMARY KEY (site_id, days, assistant, page)
) WITHOUT ROWID;
-- One row per URL per channel the app (or an agent) pushed it to. "Accepted" means the channel received it, never that the page is indexed:
-- whether it got indexed is read later from the stored URL Inspection (the submitted URLs are also put on the indexing monitor's watch list).
CREATE TABLE IF NOT EXISTS index_submissions (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	channel TEXT NOT NULL,              -- indexnow | bing | google_indexing_api
	at INTEGER NOT NULL,
	ok INTEGER NOT NULL,
	message TEXT,
	source TEXT NOT NULL,               -- app | mcp
	key_id INTEGER                      -- the API key, for source = mcp
);
-- URLs waiting to be sent to a channel: over today's limit, or deliberately spread over several days ("drip"). release_at is when each may go.
CREATE TABLE IF NOT EXISTS index_queue (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	channel TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	release_at INTEGER NOT NULL,        -- when it may go next (pushed back after a channel failure)
	first_release_at INTEGER NOT NULL,  -- when it was first meant to go: a row is dropped 7 days after this, however a drip spaced it
	source TEXT NOT NULL,
	key_id INTEGER,
	UNIQUE (site_id, url, channel)
);
-- After a URL is accepted somewhere, Google is asked again at day 1, 3 and 5 (step 0, 1, 2) whether it is indexed; the row goes when it is, or after the last step.
CREATE TABLE IF NOT EXISTS index_rechecks (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	submitted_at INTEGER NOT NULL,
	step INTEGER NOT NULL,
	due_at INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_index_submissions_site ON index_submissions (site_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_index_submissions_url ON index_submissions (site_id, url);
-- The "Request indexing" list: pages worth asking Google about by hand (Search Console's button has no API), what the owner did with each.
CREATE TABLE IF NOT EXISTS index_requests (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	status TEXT NOT NULL,               -- pending | requested | dismissed | problem
	tier INTEGER NOT NULL DEFAULT 0,
	reason TEXT NOT NULL,
	state TEXT,                         -- Google's answer when the list was built: indexed | not_indexed | unknown
	coverage TEXT,
	link TEXT,                          -- Search Console's own link for the URL, only if Google gave one and it points at search.google.com
	built_at INTEGER NOT NULL,
	acted_at INTEGER,
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS seo_tests (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	kind TEXT NOT NULL,                 -- split | before_after | switch
	start_date TEXT NOT NULL,           -- the day the change went live
	window_days INTEGER NOT NULL DEFAULT 28,
	treatment TEXT NOT NULL,            -- JSON {prefixes, urls}
	control TEXT NOT NULL,              -- JSON {prefixes, urls}, or {"restOfSite":true}
	meta TEXT NOT NULL DEFAULT '{}',    -- switch: {old, new} scopes
	note TEXT,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
	id_hash TEXT PRIMARY KEY,           -- sha256 of the random session id; the id itself is only in the browser's cookie
	pw_fp TEXT NOT NULL,                -- fingerprint of ADMIN_PASSWORD (and, for a team member, of their password) when it was created
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	user_id INTEGER                     -- NULL = the owner (signed in with ADMIN_PASSWORD); otherwise users.id
) WITHOUT ROWID;
-- Team members invited by the owner or an admin. The owner is not a row: it is whoever knows ADMIN_PASSWORD, so it can never be locked out.
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,         -- lower-cased
	name TEXT NOT NULL,
	password_hash TEXT NOT NULL,        -- scrypt, the same scheme as ADMIN_PASSWORD_HASH (password.ts)
	role TEXT NOT NULL,                 -- admin | editor | viewer
	site_ids TEXT,                      -- JSON array, NULL = all sites (admins always NULL)
	created_at INTEGER NOT NULL,
	last_login_at INTEGER,
	disabled INTEGER NOT NULL DEFAULT 0
);
-- Single-use password reset links, made by an owner or admin for a team member who cannot sign in (there is no email sending, so the link is copied by hand).
CREATE TABLE IF NOT EXISTS password_resets (
	id INTEGER PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	user_id INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	created_by TEXT,
	used_at INTEGER,
	revoked_at INTEGER
);
-- Single-use invite links. Only a hash of the token is kept; the link itself is shown once to whoever made it.
CREATE TABLE IF NOT EXISTS invites (
	id INTEGER PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	email TEXT NOT NULL,
	role TEXT NOT NULL,
	site_ids TEXT,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	created_by TEXT,
	accepted_at INTEGER,
	accepted_user_id INTEGER,
	revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS kv (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS google_updates (
	id TEXT PRIMARY KEY,                -- g:<incident id> from Google's Search Status Dashboard, or m:<n> for a manual entry
	name TEXT NOT NULL,                 -- e.g. "May 2026 core update"
	kind TEXT NOT NULL,                 -- core | spam | discover | other
	begin_date TEXT NOT NULL,           -- YYYY-MM-DD (UTC date of the dashboard timestamp)
	end_date TEXT,                      -- NULL while still rolling out
	source TEXT NOT NULL,               -- google | manual
	updated_at INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS sitemap_urls (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	norm TEXT NOT NULL,                 -- host (no www) + path (no trailing slash), for matching against Search Console pages
	lastmod TEXT,                       -- YYYY-MM-DD if the sitemap gave one
	lastmod_bad INTEGER NOT NULL DEFAULT 0, -- 1: the sitemap had a <lastmod> that is not a valid W3C date
	sitemap TEXT NOT NULL,              -- which sitemap file listed it
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS sitemap_urls_norm ON sitemap_urls(site_id, norm);
CREATE TABLE IF NOT EXISTS sitemap_sync (
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	fetched_at INTEGER NOT NULL,
	sitemaps INTEGER NOT NULL,          -- files read
	urls INTEGER NOT NULL,
	truncated INTEGER NOT NULL DEFAULT 0,
	error TEXT                          -- first problem, if any
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS action_cache (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	days INTEGER NOT NULL,
	cache_key TEXT NOT NULL,
	payload TEXT NOT NULL,              -- JSON ActionItem[], ranked
	computed_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, days)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS action_state (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	state TEXT NOT NULL,                -- done | snoozed
	until INTEGER NOT NULL,             -- ms; the item returns after this if it is still detected
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_page_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	page TEXT NOT NULL,                 -- landing path, no query string
	sessions INTEGER NOT NULL,          -- Google-organic sessions that landed there
	key_events REAL NOT NULL,
	PRIMARY KEY (site_id, date, page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_page_meta (
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	from_date TEXT,                     -- earliest day stored
	through_date TEXT,                  -- latest day stored
	pulled_at INTEGER NOT NULL,
	error TEXT
) WITHOUT ROWID;
-- Daily AI-assistant sessions per landing page, only for sites with an LLM test (an SEO test judged on AI-assistant sessions).
CREATE TABLE IF NOT EXISTS ga4_ai_daily (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	date TEXT NOT NULL,
	assistant TEXT NOT NULL,            -- ChatGPT | Perplexity | Gemini | Claude | Copilot
	page TEXT NOT NULL,                 -- landing path, no query string
	sessions INTEGER NOT NULL,
	key_events REAL NOT NULL,
	PRIMARY KEY (site_id, date, assistant, page)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ga4_ai_daily_meta (
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	from_date TEXT,
	through_date TEXT,
	pulled_at INTEGER NOT NULL,
	error TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS digests (
	id INTEGER PRIMARY KEY,
	kind TEXT NOT NULL,                 -- weekly | monthly | urgent
	week_key TEXT,                      -- the digest day this weekly digest is for, or YYYY-MM for a monthly report; NULL for one made by hand or an urgent alert
	created_at INTEGER NOT NULL,
	payload TEXT NOT NULL,              -- JSON Digest (weekly) or {items} (urgent)
	delivery TEXT NOT NULL DEFAULT 'none',   -- none (no webhook configured) | sent | failed
	delivered_at INTEGER,
	delivery_message TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS digests_week ON digests(kind, week_key) WHERE week_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS alerts_sent (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	sent_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS indexnow_keys (
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	key TEXT NOT NULL,                  -- 8-128 chars of a-z A-Z 0-9 and "-"; must also be hosted as /<key>.txt on each host
	created_at INTEGER NOT NULL,
	auto INTEGER NOT NULL DEFAULT 0     -- submit new and changed sitemap URLs automatically
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS indexnow_hosts (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	host TEXT NOT NULL,
	verified_at INTEGER NOT NULL,
	ok INTEGER NOT NULL,                -- the key file was found on the host and holds the key
	message TEXT,
	PRIMARY KEY (site_id, host)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS indexnow_urls (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	submitted_at INTEGER NOT NULL,      -- last accepted submission, for the per-URL cooldown
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS indexnow_log (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	at INTEGER NOT NULL,
	host TEXT NOT NULL,
	urls INTEGER NOT NULL,
	status INTEGER NOT NULL,            -- HTTP status, 0 if there was no answer
	message TEXT,
	source TEXT NOT NULL                -- manual | auto
);
CREATE INDEX IF NOT EXISTS indexnow_log_site ON indexnow_log(site_id, at);
CREATE TABLE IF NOT EXISTS seo_test_results (
	test_id INTEGER PRIMARY KEY REFERENCES seo_tests(id) ON DELETE CASCADE,
	cache_key TEXT NOT NULL,            -- changes whenever the data, the test or the algorithm changes
	outcome TEXT NOT NULL,              -- JSON TestOutcome
	computed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS index_watch (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	source TEXT,                        -- NULL: pinned by the owner; 'submit': put there by a submission (removed again once its re-checks are done)
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS index_history (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	day TEXT NOT NULL,
	indexed INTEGER NOT NULL, not_indexed INTEGER NOT NULL, unknown INTEGER NOT NULL,
	PRIMARY KEY (site_id, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS index_events (
	id INTEGER PRIMARY KEY,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	at INTEGER NOT NULL,
	kind TEXT NOT NULL,                 -- deindexed | indexed | canonical_changed | blocked | unblocked | fetch_error
	detail TEXT
);
CREATE INDEX IF NOT EXISTS index_events_site ON index_events(site_id, at);
CREATE TABLE IF NOT EXISTS onpage_checks (
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,
	checked_at INTEGER NOT NULL,
	payload TEXT NOT NULL,              -- JSON {status, finalUrl, error?, parsed, queries, issues, score}
	PRIMARY KEY (site_id, url)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS link_pages (             -- the internal-link crawl: one row per fetched page, newest crawl only
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	url TEXT NOT NULL,                  -- as Search Console lists it
	final_url TEXT NOT NULL,            -- after redirects
	status INTEGER NOT NULL,
	error TEXT,
	title TEXT,
	h1 TEXT,
	body TEXT NOT NULL DEFAULT '',      -- main content text, one paragraph per line
	links TEXT NOT NULL DEFAULT '[]',   -- JSON PageLink[]: same-site links with anchor text
	fetched_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, url)
);
CREATE TABLE IF NOT EXISTS link_crawls (            -- the last internal-link crawl per site
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'idle', -- idle | running
	started_at INTEGER,
	finished_at INTEGER,
	pages INTEGER NOT NULL DEFAULT 0,
	ok INTEGER NOT NULL DEFAULT 0,
	failed INTEGER NOT NULL DEFAULT 0,
	error TEXT
);
CREATE TABLE IF NOT EXISTS link_done (              -- internal-link suggestions marked done (source>target, normalised)
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	at INTEGER NOT NULL,
	PRIMARY KEY (site_id, key)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS clarity_scans (          -- is Clarity's script on the site's pages? (newest check only)
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	checked_at INTEGER NOT NULL,
	payload TEXT NOT NULL               -- JSON ScannedPage[]
);
CREATE TABLE IF NOT EXISTS oseo_volumes (           -- search volume from OpenSEO for the site's own queries (lower-cased)
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	keyword TEXT NOT NULL,
	volume INTEGER,                      -- monthly searches; NULL = OpenSEO had no data (usually too low to measure)
	kd INTEGER,                          -- keyword difficulty 0-100
	cpc REAL,
	intent TEXT,
	fetched_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, keyword)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS oseo_tracked (           -- searches sent to an OpenSEO rank tracker from here
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	keyword TEXT NOT NULL,
	tracker_id TEXT NOT NULL,
	added_at INTEGER NOT NULL,
	PRIMARY KEY (site_id, keyword)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS oseo_audits (            -- OpenSEO's latest site audit for the linked project (newest read only)
	site_id INTEGER PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
	fetched_at INTEGER NOT NULL,
	payload TEXT NOT NULL                -- JSON AuditSnapshot (src/lib/server/openseolink.ts)
);
CREATE TABLE IF NOT EXISTS chat_threads (           -- "Ask your data": one conversation, private to the person who started it
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	owner TEXT NOT NULL,                 -- 'owner', or 'user:<users.id>'
	title TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	pending TEXT                         -- JSON: changes the model asked for, waiting for Approve or Decline
);
CREATE INDEX IF NOT EXISTS chat_threads_owner ON chat_threads(owner, updated_at);
CREATE TABLE IF NOT EXISTS chat_messages (          -- the conversation exactly as sent to and received from the API (append-only)
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	thread_id INTEGER NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
	role TEXT NOT NULL,                  -- user | assistant
	content TEXT NOT NULL,               -- JSON content blocks; tool results hold third-party text, shown as data
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages(thread_id, id);
CREATE TABLE IF NOT EXISTS chat_usage (             -- turns started per person per UTC day, for CHAT_MESSAGES_PER_DAY (kept when a conversation is deleted)
	owner TEXT NOT NULL,
	day TEXT NOT NULL,                   -- YYYY-MM-DD, UTC
	n INTEGER NOT NULL DEFAULT 0,
	PRIMARY KEY (owner, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ai_prompts (             -- AI visibility: the questions asked of AI assistants, per site
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	prompt TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS ai_competitors (         -- domains to compare against in AI answers
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	domain TEXT NOT NULL,
	PRIMARY KEY (site_id, domain)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS ai_runs (                -- one answer from one assistant to one prompt
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	prompt_id INTEGER NOT NULL REFERENCES ai_prompts(id) ON DELETE CASCADE,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	engine TEXT NOT NULL,                -- claude | chatgpt | perplexity
	model TEXT,
	ran_at INTEGER NOT NULL,
	status TEXT NOT NULL,                -- ok | error
	error TEXT,
	answer TEXT,                         -- third-party text: shown as data, never followed
	citations TEXT,                      -- JSON {url,title}[]
	sources TEXT,                        -- JSON {url,title}[]
	verdict TEXT,                        -- JSON AnswerVerdict (from src/lib/aivis.ts), as judged when it ran
	searches INTEGER NOT NULL DEFAULT 0,
	via TEXT,                            -- direct | dataforseo-scraper | dataforseo-responses | demo
	cost REAL                            -- USD, when the provider reports it (DataForSEO does)
);
CREATE INDEX IF NOT EXISTS ai_runs_site ON ai_runs (site_id, ran_at);
CREATE INDEX IF NOT EXISTS ai_runs_prompt ON ai_runs (prompt_id, engine, ran_at);
CREATE TABLE IF NOT EXISTS robots_checks (          -- the newest robots.txt read per host of a site
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	origin TEXT NOT NULL,                -- https://www.example.com
	checked_at INTEGER NOT NULL,
	status INTEGER NOT NULL,             -- HTTP status; 0 = no answer
	state TEXT NOT NULL,                 -- ok | missing | error (see src/lib/robots.ts)
	body TEXT,                           -- the file as read (500 KiB cap), when state = ok
	fingerprint TEXT NOT NULL,           -- what the rules mean, not how they are written
	changed_at INTEGER,                  -- when the fingerprint last changed (NULL until a second read differs)
	fail_streak INTEGER NOT NULL DEFAULT 0, -- consecutive reads in the error state
	error TEXT,
	PRIMARY KEY (site_id, origin)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS robots_changes (         -- every change in what a site's robots.txt means
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
	origin TEXT NOT NULL,
	at INTEGER NOT NULL,
	before_state TEXT NOT NULL,
	after_state TEXT NOT NULL,
	added TEXT NOT NULL,                 -- JSON string[] of rule lines
	removed TEXT NOT NULL,               -- JSON string[]
	before_body TEXT                     -- the previous file, so a bad change can be rolled back by hand
);
CREATE INDEX IF NOT EXISTS robots_changes_site ON robots_changes (site_id, at);
CREATE TABLE IF NOT EXISTS api_keys (
	id INTEGER PRIMARY KEY,
	name TEXT NOT NULL, prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE,
	site_ids TEXT,                      -- JSON array, NULL = all sites
	created_at INTEGER NOT NULL, last_used_at INTEGER
);
-- OAuth sign-in for the MCP endpoint (claude.ai "custom connector", ChatGPT). A grant owns one api_keys row: that row's secret IS the
-- access token, rotated on every refresh, so revoking the key on the MCP page revokes the sign-in.
CREATE TABLE IF NOT EXISTS oauth_clients (
	id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (          -- a checked /authorize request waiting for the owner's decision
	id TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
	state TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_codes (             -- one-time authorization codes (only a hash is kept)
	hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL,
	site_ids TEXT, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0, key_id INTEGER
);
CREATE TABLE IF NOT EXISTS oauth_grants (
	id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
	refresh_hash TEXT NOT NULL UNIQUE, prev_refresh_hash TEXT, refresh_expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
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
	if (!cols('sites').includes('crux_pulled_on')) db.exec('ALTER TABLE sites ADD COLUMN crux_pulled_on TEXT');
	if (!cols('sites').includes('index_monitor')) db.exec('ALTER TABLE sites ADD COLUMN index_monitor INTEGER NOT NULL DEFAULT 0');
	if (!cols('sites').includes('index_message')) db.exec('ALTER TABLE sites ADD COLUMN index_message TEXT');
	if (!cols('sites').includes('index_next_at')) db.exec('ALTER TABLE sites ADD COLUMN index_next_at INTEGER');
	if (!cols('sites').includes('ga4_ai_on')) db.exec('ALTER TABLE sites ADD COLUMN ga4_ai_on TEXT');
	if (!cols('sitemap_urls').includes('lastmod_bad')) db.exec('ALTER TABLE sitemap_urls ADD COLUMN lastmod_bad INTEGER NOT NULL DEFAULT 0');
	if (!cols('index_watch').includes('source')) db.exec('ALTER TABLE index_watch ADD COLUMN source TEXT');
	// read | submit | delete. Databases from the on/off "can make changes" switch (can_write) carry it over once, as the submit level.
	if (!cols('api_keys').includes('permission')) {
		db.exec("ALTER TABLE api_keys ADD COLUMN permission TEXT NOT NULL DEFAULT 'read'");
		if (cols('api_keys').includes('can_write')) db.exec("UPDATE api_keys SET permission = 'submit' WHERE can_write = 1");
	}
	if (!cols('oauth_codes').includes('permission')) {
		db.exec("ALTER TABLE oauth_codes ADD COLUMN permission TEXT NOT NULL DEFAULT 'read'");
		if (cols('oauth_codes').includes('can_write')) db.exec("UPDATE oauth_codes SET permission = 'submit' WHERE can_write = 1");
	}
	if (!cols('api_keys').includes('expires_at')) db.exec('ALTER TABLE api_keys ADD COLUMN expires_at INTEGER'); // NULL = never (keys made by hand)
	// Whether a key may use the MCP tools that change things. Off unless the owner ticked it; existing keys stay read-only.
	if (!cols('api_keys').includes('can_write')) db.exec('ALTER TABLE api_keys ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0');
	if (!cols('oauth_codes').includes('can_write')) db.exec('ALTER TABLE oauth_codes ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0');
	if (!cols('sites').includes('index_checked_on')) db.exec('ALTER TABLE sites ADD COLUMN index_checked_on TEXT');
	// Build the Request tab's list by itself once a day (and tell the webhook). Off unless the owner switched it on for the site.
	// Resubmit the site's sitemaps by itself when a sitemap read finds new or changed pages. Off unless the owner switched it on.
	if (!cols('sites').includes('sitemap_auto')) db.exec('ALTER TABLE sites ADD COLUMN sitemap_auto INTEGER NOT NULL DEFAULT 0');
	if (!cols('sites').includes('request_auto')) db.exec('ALTER TABLE sites ADD COLUMN request_auto INTEGER NOT NULL DEFAULT 0');
	if (!cols('ai_runs').includes('via')) db.exec('ALTER TABLE ai_runs ADD COLUMN via TEXT');
	if (!cols('ai_runs').includes('cost')) db.exec('ALTER TABLE ai_runs ADD COLUMN cost REAL');
	// The Google identity (the stable "sub") a team member signs in with, once they have used or linked "Sign in with Google".
	if (!cols('users').includes('google_sub')) db.exec('ALTER TABLE users ADD COLUMN google_sub TEXT');
	db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub ON users(google_sub) WHERE google_sub IS NOT NULL');
	// Which team member a session belongs to (NULL = the owner). Earlier sessions were all the owner's, so they stay valid.
	if (!cols('sessions').includes('user_id')) db.exec('ALTER TABLE sessions ADD COLUMN user_id INTEGER');
	db.exec('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)');
	// v1: earlier versions could mark a property "fully backfilled" after one empty stretch, or never start walking
	// back at all. Re-open every backfill; it resumes from the stored cursor, so nothing already stored is re-downloaded.
	const version = db.pragma('user_version', { simple: true }) as number;
	if (version < 1) {
		db.exec('UPDATE sites SET backfill_done = 0');
		db.pragma('user_version = 1');
	}
}

let regexDeadline = 0;
/**
 * Run a query that uses REGEXP with a time budget: safeRegex keeps each match small, and this stops a query that would still take too
 * long over millions of rows (SQLite calls the function synchronously, so a slow query would hold up every other request).
 */
export function withRegexBudget<T>(ms: number, fn: () => T): T {
	regexDeadline = Date.now() + ms;
	try {
		return fn();
	} finally {
		regexDeadline = 0;
	}
}
/** At most this much of each value is matched: queries and URLs are shorter, and it bounds the work per row. */
const REGEX_VALUE_CAP = 500;

/** `x REGEXP p` in SQL: case-insensitive, compiled once per pattern, and only for patterns safeRegex accepts (no runaway backtracking). */
function registerRegexp(d: Database.Database) {
	const cache = new Map<string, RegExp>();
	d.function('regexp', { deterministic: true }, (pattern: unknown, value: unknown) => {
		const p = String(pattern ?? '');
		let re = cache.get(p);
		if (!re) {
			const r = safeRegex(p);
			if ('error' in r) throw new Error(r.error);
			if (cache.size > 200) cache.clear();
			cache.set(p, (re = r.re));
		}
		if (regexDeadline && Date.now() > regexDeadline) throw new Error('This regular expression takes too long on this much data. Simplify it, or shorten the date range.');
		return value != null && re.test(String(value).slice(0, REGEX_VALUE_CAP)) ? 1 : 0;
	});
}

export function openDb(path: string): Database.Database {
	if (path !== ':memory:') {
		mkdirSync(dirname(path), { recursive: true });
		// The database holds encrypted tokens and the owner's data: create it readable by the owner only (SQLite gives the -wal
		// and -shm files the same mode as the main file). An existing file is tightened too.
		try {
			closeSync(openSync(path, 'a', 0o600));
			chmodSync(path, 0o600);
		} catch {
			/* a read-only mount or a non-POSIX file system: carry on */
		}
	}
	const db = new Database(path);
	db.pragma('journal_mode = WAL');
	db.pragma('foreign_keys = ON');
	db.pragma('synchronous = NORMAL');
	db.exec(SCHEMA);
	migrate(db);
	registerRegexp(db);
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
