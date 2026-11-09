# Configuration

Every environment variable.

[Back to the README](../README.md)

## Environment variables

All are optional except where noted; copy `.env.example` to `.env`. On Cloudflare they are Worker secrets or variables instead.

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (not needed in demo mode). |
| `ORIGIN` | Public address of the app; builds the OAuth redirect URI. |
| `APP_SECRET` | 32+ random characters; encrypts OAuth tokens at rest. If unset, a key is generated next to the database. **Required on Cloudflare**, where the disk is wiped. |
| `ADMIN_PASSWORD` | The owner's password (the owner can do everything; team members are invited from the Team page and have their own). Required before any non-local access, and before anyone can be invited. Changing it signs everyone out, team members included. |
| `ADMIN_PASSWORD_HASH` | Instead of `ADMIN_PASSWORD`: a scrypt hash (`pnpm hash-password`), so the password itself is never stored. Wins if both are set. |
| `OAUTH_REDIRECT_URI` | Hosted plan only: the one shared Google redirect address (the control app's `/oauth/callback`). Leave empty for a normal install. |
| `DEMO_MODE=1` | Synthetic data, no Google credentials. |
| `DB_PATH` | SQLite file (default `./data/opensiteconsole.db`). |
| `GOOGLE_INCLUDE_GA4`, `GOOGLE_INCLUDE_GTM` | Ask for GA4 / read-only Tag Manager access in the same consent (default 1). |
| `BING_CLIENT_ID`, `BING_CLIENT_SECRET` | One-click Bing sign-in; otherwise paste a Bing API key. |
| `INDEX_MONITOR_URLS` | URLs the indexing monitor inspects per run (default 40, max 200). |
| `ONPAGE_ALLOW_PRIVATE=1` | Let on-page checks reach private addresses (only if your site lives on your own network). |
| `LINK_CRAWL_PAGES` | Pages the internal-link crawl fetches per site (default 60, max 500): the ones with the most impressions in the last 90 days. |
| `READ_ONLY=1` | Read-only Google scope and write actions disabled. |
| `MAX_ROWS_PER_DAY` | Per-day row cap in the warehouse (default 100,000). |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` | AI answers: the assistants to ask (each optional; none set, nothing runs). Billed to your accounts. `ANTHROPIC_API_KEY` also switches on the *Ask* chat. |
| `CHAT_MODEL`, `CHAT_EFFORT`, `CHAT_MESSAGES_PER_DAY` | The *Ask* chat: the Claude model (default `claude-opus-5-5`), its effort (`low` to `max`, default `medium`) and the messages each person may send a day (default 50; `0` turns chat off for everyone). |
| `DATAFORSEO_LOGIN`, `DATAFORSEO_PASSWORD` | AI answers through DataForSEO instead of (or besides) the keys above: ChatGPT and Gemini as seen in their apps, Claude and Perplexity when you have no key for them. `AI_VIS_SOURCE` = `auto` (default), `direct` or `dataforseo`. |
| `AI_VIS_LOCATION_CODE`, `AI_VIS_LANGUAGE_CODE`, `AI_VIS_COUNTRY`, `AI_VIS_DFS_CLAUDE_MODEL`, `AI_VIS_DFS_PERPLEXITY_MODEL` | DataForSEO settings: where the apps are asked from (default 2840 = United States, `en`), the country for API web search (default `US`), and its model names (defaults `claude-opus-5`, `sonar`). |
| `AI_VIS_RUNS_PER_DAY`, `AI_VIS_EVERY_DAYS` | AI answers: runs a day across all sites (default 60, max 2000) and days between re-asking a prompt (default 7). |
| `AI_VIS_CLAUDE_MODEL`, `AI_VIS_CLAUDE_EFFORT`, `AI_VIS_OPENAI_MODEL`, `AI_VIS_PERPLEXITY_MODEL` | AI answers: the models used (defaults `claude-opus-5-5`, `medium`, `gpt-6-astra`, `sonar`). |
| `DIGEST_MONTHLY` | `0` stops the automatic monthly report (default on; it can still be made by hand on the Digest page). |
| `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_FORMAT`, `DIGEST_DAY` | Weekly digest and urgent alerts: https webhook, `slack` (default) / `discord` / `json`, weekday 0-6 (default 1 = Monday). No email. |
| `MCP_OAUTH_REDIRECTS` | Extra callback addresses an MCP client may register for "Sign in" (comma-separated, exact, https only). Claude's own is built in. Leave empty unless you connect another client. |
| `MCP_INSPECT_PER_KEY_DAY` | Live URL inspections one API key may cause per day through `inspect_url` (default 100, max 2000; Google allows about 2,000 a day per property). |
| `INDEX_RECHECK_PER_RUN` | URLs the automatic day 1 / 3 / 5 re-checks inspect per site per run (default 40, max 200). They share Google's URL Inspection quota with the indexing monitor. |
| `REQUEST_INDEXING_PER_DAY` | Pages the Request tab lists per site per day, and the allowance it counts what you asked against (default 10, max 50). Google does not publish its limit; third-party sources say about 10 to 12 a day, which is unverified. |
| `COMPARE_HOSTED_PRICE` | The sentence about the hosted plan's price on the public `/compare` pages (default: "$9 a month, $29 with the advanced indexing features, launch price $19"). Say what is true for your hosting. |
| `LEGAL_ENTITY`, `LEGAL_CONTACT_EMAIL`, `LEGAL_GOVERNING_LAW`, `LEGAL_UPDATED` | Who the public privacy policy (`/privacy`) and terms (`/terms`) speak for. Until the first two are set the pages say "the operator of this SEOConsole installation" and signed-in users see a reminder. The texts are a starting point, not legal advice: have them reviewed before relying on them (for example for Google's OAuth verification). |
| `MCP_SUBMIT_PER_KEY_DAY` | URLs one API key with the submit permission may push to search engines per day, UTC (default 200, max 10,000). |
| `GOOGLE_INCLUDE_INDEXING=1` | Ask for Google's Indexing API permission on new Google connections and allow that channel. Google documents the API for **job-posting and livestream pages only**: every other page is refused. `INDEXING_API_MAX_PER_DAY` caps notifications per site per day (default 200, the quota as I understand it; verify it). |
| `GOOGLE_INCLUDE_SITE_VERIFICATION=1` | Ask for the Site Verification permission, so a site can be proven and added from the Accounts page or over MCP. |
| `INDEXNOW_ENDPOINT`, `INDEXNOW_MAX_PER_DAY` | IndexNow endpoint (https) and URLs per site per day (default 1000). |
