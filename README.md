# SEOConsole

> Formerly **OpenSiteConsole**. Only the name changed: the repository path, the default database file (`data/opensiteconsole.db`), the Docker service name and the `osc_` API-key prefix keep their old names on purpose, so existing installs, volumes and keys keep working. The on-page checker's user agent is now `SEOConsole/1.0`; if you had allowed the old one in a firewall rule, add the new one.

A self-hosted SEO dashboard for **all your Google Search Console properties across many Google accounts**.
It syncs your data into a local SQLite warehouse (so history is kept beyond Google's 16 months), joins it with GA4, Tag Manager,
Bing and Clarity, and turns it into a **ranked to-do list** (what to fix first and why), a weekly digest, calibrated SEO tests,
an indexing monitor, sitemap coverage and IndexNow submission. It also does the day-to-day Search Console chores (sitemaps,
URL inspection, property management) from one place, and exposes everything read-only to AI agents over MCP.

> **Status.** Everything is verified against demo data, unit tests and a headless-browser pass, but **nothing has been run against live Google data or on a real Cloudflare account**. Expect to debug first contact with the real APIs. Details are under *Known limits*.

## Quick start

```bash
pnpm install
cp .env.example .env        # then edit it
pnpm dev                    # http://localhost:5173
```

**Requirements:** Node.js 20.19+ or 22+, and pnpm 10 or 12 (`corepack enable` provides pnpm). Tested with Node 20.20, Node 22 and pnpm 10.28 / 12.16 on Linux. The SQLite driver is a native module: on Node 22 a prebuilt binary is used, while on Node 20 it is compiled during install (macOS needs the Xcode Command Line Tools: `xcode-select --install`).

pnpm 12 refuses packages published in the last ~day (`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`). The committed lockfile already respects that; if you update dependencies and hit it, wait a day or run `pnpm clean --lockfile && pnpm install`.

**Run it on your own computer for the first Google sign-in.** The default redirect URI is `http://localhost:5173/auth/callback`, and "localhost" only reaches the app when it runs on the same machine as your browser. Put `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `ORIGIN=http://localhost:5173` in `.env`, then open `/accounts` and click *Connect Google account*. `.env` holds secrets: never commit or share it.

**Try it without Google credentials:** set `DEMO_MODE=1` in `.env`. Two synthetic accounts / six sites are created and
synced locally (with planted patterns: a decaying page group, cannibalising pages, an anomaly day).

**Connect real accounts:**
1. Google Cloud Console → enable the **Search Console API** → create an **OAuth client ID** (Web application).
2. Authorised redirect URI: `<ORIGIN>/auth/callback` (e.g. `http://localhost:5173/auth/callback`).
3. Put `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env`, restart, open **Accounts → Connect Google account**. Repeat per account.
4. While the OAuth consent screen is in *Testing*, Google expires refresh tokens after about 7 days — publish the app (or accept re-connecting weekly). Verify this against Google's current OAuth docs.

**Faster day-to-day use:** `pnpm serve` builds and starts the production server on `http://localhost:5173` (pages load in tens of
milliseconds instead of the hundreds `pnpm dev` takes, because dev compiles on demand). It reads `.env`, and defaults `ORIGIN`/`PORT`/`HOST`
for you. Do not run `node build` directly on localhost: without `ORIGIN` in the process environment, SvelteKit assumes https and rejects
every form submit as cross-site. `pnpm get-latest` pulls the latest `main` and installs packages (not `pnpm update`, which is pnpm's own command for upgrading dependencies).

## Deploying

**Set `ADMIN_PASSWORD`** before exposing the app beyond localhost: without it the app refuses non-loopback requests. Put it behind HTTPS.

| Where | How | Status |
|---|---|---|
| **Your computer / a server** | `pnpm serve` (or `pnpm start` after `pnpm build`) | The tested route. |
| **Coolify / a Docker server behind a proxy** (recommended for always-on use) | [`compose.coolify.yaml`](compose.coolify.yaml) and [`deploy/coolify/`](deploy/coolify/README.md): the app plus a named volume for the database, healthcheck, proxy-header settings, backup and data-move steps. Works the same on Railway (volume at `/data`). | The compose file parses and the healthcheck and proxy-header settings were tested against a running server; the image was **never built** and nothing was deployed. |
| **Docker (plain)** | `Dockerfile` and `compose.yaml` (data in a volume) | Written, **never built**. |
| **Cloudflare** | [`deploy/cloudflare/`](deploy/cloudflare/README.md): a Worker in front of a Cloudflare Container running the app, the database replicated to an R2 bucket with Litestream, and a cron trigger that wakes it. Needs the Workers Paid plan and Docker on the computer you deploy from. | Written from the documentation. The Worker type-checks, `wrangler deploy --dry-run` accepts it and the start script is tested against a stand-in, but the image was **never built and nothing was deployed**. |
| **Hosted plan (control app)** | [`cloud/`](cloud/README.md): a separate small program that sells a **$10/month hosted instance**: sign-up, Stripe Checkout, and automatic creation of one private instance per customer through the Coolify API, with grace period, suspension and retention rules. The app itself stays free to self-host. | Built and tested against fakes (45 tests); **never run against real Stripe, Coolify or Google review**. Needs your Stripe, Coolify and domain details, and Google OAuth verification before public use. |
| **Native Cloudflare Workers + D1** | Not supported. [`spike/workers/REPORT.md`](spike/workers/REPORT.md) sizes the port (374 functions and 818 calls become async; D1's 10 GB cap) and includes a working proof. | A feasibility spike: staged go, not a quick change. |

## Environment variables

All are optional except where noted; copy `.env.example` to `.env`. On Cloudflare they are Worker secrets or variables instead.

| Variable | Meaning |
|---|---|
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google OAuth client (not needed in demo mode). |
| `ORIGIN` | Public address of the app; builds the OAuth redirect URI. |
| `APP_SECRET` | 32+ random characters; encrypts OAuth tokens at rest. If unset, a key is generated next to the database. **Required on Cloudflare**, where the disk is wiped. |
| `ADMIN_PASSWORD` | Password for the whole app. Required before any non-local access. |
| `ADMIN_PASSWORD_HASH` | Instead of `ADMIN_PASSWORD`: a scrypt hash (`pnpm hash-password`), so the password itself is never stored. Wins if both are set. |
| `OAUTH_REDIRECT_URI` | Hosted plan only: the one shared Google redirect address (the control app's `/oauth/callback`). Leave empty for a normal install. |
| `DEMO_MODE=1` | Synthetic data, no Google credentials. |
| `DB_PATH` | SQLite file (default `./data/opensiteconsole.db`). |
| `GOOGLE_INCLUDE_GA4`, `GOOGLE_INCLUDE_GTM` | Ask for GA4 / read-only Tag Manager access in the same consent (default 1). |
| `BING_CLIENT_ID`, `BING_CLIENT_SECRET` | One-click Bing sign-in; otherwise paste a Bing API key. |
| `INDEX_MONITOR_URLS` | URLs the indexing monitor inspects per run (default 40, max 200). |
| `ONPAGE_ALLOW_PRIVATE=1` | Let on-page checks reach private addresses (only if your site lives on your own network). |
| `READ_ONLY=1` | Read-only Google scope and write actions disabled. |
| `MAX_ROWS_PER_DAY` | Per-day row cap in the warehouse (default 100,000). |
| `DIGEST_WEBHOOK_URL`, `DIGEST_WEBHOOK_FORMAT`, `DIGEST_DAY` | Weekly digest and urgent alerts: https webhook, `slack` (default) / `discord` / `json`, weekday 0-6 (default 1 = Monday). No email. |
| `MCP_OAUTH_REDIRECTS` | Extra callback addresses an MCP client may register for "Sign in" (comma-separated, exact, https only). Claude's own is built in. Leave empty unless you connect another client. |
| `MCP_INSPECT_PER_KEY_DAY` | Live URL inspections one API key may cause per day through `inspect_url` (default 100, max 2000; Google allows about 2,000 a day per property). |
| `INDEXNOW_ENDPOINT`, `INDEXNOW_MAX_PER_DAY` | IndexNow endpoint (https) and URLs per site per day (default 1000). |

## Getting credentials

**Google (Search Console + GA4 + Tag Manager)** — one OAuth client serves all three, and OpenSEO can share it.
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project → enable **Google Search Console API**, **Google Analytics Admin API**, **Google Analytics Data API** and **Tag Manager API**.
2. OAuth consent screen → *External* → add your Google accounts as test users, then **Publish app** (in *Testing*, Google expires refresh tokens after about 7 days — verify against Google's current docs).
3. Credentials → *Create OAuth client ID* → *Web application* → add redirect URI `<ORIGIN>/auth/callback`.
4. Put the client ID/secret in `.env`. To reuse OpenSEO's client, add this redirect URI to that same client instead.
5. Tag Manager access is requested read-only (`tagmanager.readonly`) in the same consent; set `GOOGLE_INCLUDE_GTM=0` to leave it out. Accounts connected before this was added must use *Connect Google account* again to grant it. Whether Google requires app verification for this scope on a published app: I have not checked, so verify in the consent-screen settings.

**Bing Webmaster Tools** (per Microsoft's docs) — two options:
- *API key (simplest, no registration):* sign in at bing.com/webmasters, verify your sites, **Settings → API Access → API Key → Generate API Key**. One key per Bing user, covering all their verified sites. Paste it on the **Connect** page.
- *OAuth (one-click for your users):* in the same **API Access** section choose **OAuth Client**, register a name and the redirect URI `<ORIGIN>/auth/bing/callback`, then set `BING_CLIENT_ID` / `BING_CLIENT_SECRET`. Scope used: `webmaster.read`.

**Microsoft Clarity** — per project: open the project → **Settings → Data Export → Generate new API token** (project admins only). Paste it on the **Connect** page for that site. Limits (Microsoft docs): 10 API calls per project per day, data for the last 1–3 days only, 1,000 rows, no paging — so SEOConsole stores one snapshot a day.

## Connecting sources (the "Connect" page)

One page, seven independent steps, status per site. Google sign-in grants Search Console, GA4 and Tag Manager together; Bing needs a key (or OAuth);
GA4 properties are auto-matched to sites by their web-stream URL; Tag Manager containers by their domain (or a container name that is the site's address), across every connected account that has Tag Manager access; Clarity needs a token per site; OpenSEO needs its URL + an `oseo_` API key; Core Web Vitals needs one free Google API key (enable the *Chrome UX Report API* in Google Cloud, then Credentials → API key).
Sites are matched by domain; anything unmatched is listed and can be linked by hand. In demo mode, type `demo` as any key/token.

## OpenSEO and AI agents

- **Sign in from a connector (claude.ai, Claude Desktop, ChatGPT-style clients that use OAuth):** no key to paste. In Claude: *Customize → Connectors → Add custom connector*, URL `https://<your-address>/api/mcp`, Authentication **Sign in now**, and if it asks how Claude identifies itself choose **Register automatically**. Click Connect: your browser opens SEOConsole's approval page, you sign in with the admin password, choose all sites or some, and Allow. The app gets a read-only token that renews itself (access token 1 hour, refresh token 60 days unused) and shows up on the Agents page with a "sign-in" tag; **Revoke** cuts it off. This is a small OAuth 2.1 server built into the app (dynamic client registration, PKCE S256, rotating refresh tokens; the discovery documents are at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`). Only Claude's callback (`https://claude.ai/api/mcp/auth_callback`) and local loopback addresses may register by default; allow another client's exact https callback with `MCP_OAUTH_REDIRECTS`. It was tested against a simulated client and a real browser, **not yet against the real claude.ai**. The public address must be https and reachable from the internet.
- **Agents page** → create an API key (optionally limited to some sites) → add SEOConsole as an MCP server next to OpenSEO's. For Claude Code, run the command shown there in a terminal **on your own computer** (not in a cloud session), then check it with `claude mcp list`. By default it is available only in the folder you ran it in; add `--scope user` right after `mcp add` to use it in every project (per Claude Code's documentation, user-scope servers live in `~/.claude.json`, which the desktop app's Code tab also reads). The key is a bearer token that is shown once: keep it private and delete it on the Agents page if it leaks. Twenty-nine read-only tools covering every connected source (Search Console, GA4, Tag Manager, Bing, Clarity, Core Web Vitals, OpenSEO link) and every analysis below (trends, content groups, SEO tests, indexing, on-page, AI traffic, the action queue, the weekly digest, sitemap coverage, IndexNow and Google updates), almost all answered from stored data; nothing can write or spend money. Three tools reach Google live: `get_sitemaps` (Google's own sitemap status), `inspect_url` (URL Inspection for up to 5 URLs of the property; answers are reused for 12 hours, `refresh` spends URL Inspection quota) and the sync itself. `get_page_insights` returns the same combined per-page view as the Pages tab (below). `get_performance` answers questions like "mobile in the US last month against the month before": one dimension (query, page, country, device or date), any date range, an optional comparison window (a change is only claimed when the stored history covers it), and country, device and text filters. The **Agents** page has copy-paste setup for Claude Code, Claude (custom connector with a header credential), Codex and generic clients; ChatGPT's connectors are reported to expect OAuth, which this server does not implement, so it may not work there (unverified). `get_connections` tells an agent which sources are connected, and `get_tracking_health` cross-checks Search Console, GA4 and Tag Manager.
- Connect OpenSEO on the Connect page and each site is linked to its OpenSEO project by domain. An agent calls `get_openseo_project` to obtain the project id, then uses OpenSEO's own tools (keyword research, rank tracking, audits) on it — first-party history from here, third-party data from there.

## Using the dashboard

- **Privacy eye** (header): blurs site names, accounts, avatars, page and sitemap URLs, and branded queries (those containing your brand terms) for screenshots and screen sharing; hover tooltips that would reveal them are suppressed. The choice is remembered per browser. Numbers and non-branded queries stay visible. Your browser's own status bar can still show a link's address on hover.
- **Eye on a card:** hides that site from the dashboard (it leaves the totals and stops syncing). A toast offers Undo, and "Show hidden sites" at the bottom brings it back.
- **Light theme only**: there is no theme switcher, and the app ignores your OS dark-mode setting.
- **Hover explainers:** on the Actions page, hover any chip (type, ≈ clicks / 28d, confidence, effort, "Do first: blocking") or button (Open, Done, Snooze 30d) for what it means. Done hides an item for 90 days and Snooze for 30 days; either returns if the problem is still found.
- **Grouped site tabs:** a site's 23 tabs sit under five captions (Traffic, Findings, Indexing, Other sources, Site), and every table header explains itself on hover (for example Est. +clicks, vs site, CTR).
- **Tab titles and tab hints:** every page sets its own browser-tab title (for example "Queries · SEOConsole"; it never contains a site name, because privacy mode cannot blur the tab strip or your history), and every tab on a site's page explains itself on hover.
- **Dashed end of each chart:** the last two days, which Google may still revise.

## What it does

| Area | Details |
|---|---|
| **Warehouse** | Incremental sync (re-pulls the newest 3 days, which Google revises) + resumable backfill to the retention horizon. Stores `date × query × page × country × device`, plus accurate daily totals. Background scheduler; per-site status. |
| **Dashboard** | Every property from every account: KPIs, sparklines, period-over-period deltas, search, tags, hide. |
| **Site analysis** | Change chart with anomaly bands; queries & pages (branded split, country/device filters, full-history chart per row, CSV export); segments. |
| **Search types** | Web, Image, Video, News, Discover and Google News reported separately (Overview and the dashboard are Web only, as in Search Console), plus the *search appearance* report (rich results and similar), which Google only provides on its own. |
| **Pages (all sources side by side)** | One table with a band per source, joined on the page's URL path (www, http and https variants count as one page), each metric with its change against the previous period (▲/▼ %): **Google** (clicks, impressions, CTR, position), **Bing** (clicks, impressions, position), **GA4** (sessions that landed there from Google organic search, engaged share, key events) and **Clarity** (sessions, sessions with rage clicks and with dead clicks). A dash means that source has nothing for the page. Changes are only shown where that source's previous period is stored: Google's history must reach back over it, Bing's stored range must too, and GA4's previous window is pulled with the daily sync (not for the 16-month view, which would predate what GA4 keeps). **Clarity covers only its latest 24-hour snapshot**, not the selected period, and its per-URL field names are from memory of its documentation and the demo data (a row that does not match contributes nothing), so verify on first contact. GA4 sessions and Google clicks are different measurements and are not expected to match. Users in GA4 are unique users over the window, as GA4 reports them, not a sum of daily users. The same data is available to agents as `get_page_insights`. |
| **Tag Manager** | Read-only. Stores each linked container's *published* version (tags, triggers, variables) and a per-site **Tag Manager** tab with a tracking audit that combines all three sources: unpublished container, container sending to a different GA4 property than the one linked (compares `G-` measurement IDs), no GA4 tag, paused / trigger-less / leftover Universal Analytics tags, and GA4 organic sessions far below Search Console clicks (a heuristic: sessions and clicks are different measurements, so it is a prompt to look, not proof). Nothing is ever edited or published. |
| **Trends** | *Winners & losers* (queries and pages that moved by more than noise, same Poisson test as Decay), *new & lost queries*, *position bands* (non-branded queries in 1–3 / 4–10 / 11–20 / 21–50 / 51+), *question-style queries* (English heuristic; also a filter on Queries), *trajectories* (weekly direction of the biggest queries) and a *projection*: level plus a damped robust trend for 8 weeks with a range, and last year's same weeks for reference. The projection does **not** model seasonality or Google updates; it says what happens if recent behaviour continues, not what will happen. |
| **Groups** | Pages grouped by URL folder (any depth), queries clustered by shared words (transparent word match, not semantic), a month-by-month **decay heatmap** (complete months only), locale folders such as `/en-gb/` with where their clicks come from (flags a region folder earning most clicks from another country), and cannibalization *within a country*. |
| **Tests** | Before/after, **split** (control pages, picked by hand or matched on traffic level) and **redirect / URL switch** tests (old and new URLs measured together, so moved traffic is not a loss). Lift of test pages relative to control pages with a 95% interval, p-value and verdict. Traffic drifts on its own, so the noise level is **measured on the site's own earlier windows** (the same comparison run at dates when nothing changed); a test needs at least four windows of history before the change (112 days for 28-day windows, 56 for 14-day ones). With less it shows an *estimate with no verdict*. The control is, by default, **matched automatically**: pages in the sections of the site whose weekly clicks moved with the test pages before the change (chosen from pre-change data only, so it cannot be influenced by the result). Simulation of sites whose sections drift together: a real +50% change was detected 23-53% of the time against the rest of the site and 90-95% with the matched control, with 0-1.4% false verdicts on unchanged pages. Results are stored and refreshed after each sync, so the tab opens instantly. Observational, not randomised: it shows "unlikely to be noise given the control", not proof of cause. Also needs 7+ days after the change, enough clicks before it, and a fully downloaded "before". **Judged on conversions too** when GA4 is linked: Google-organic sessions and key events for the same test and control pages, with the same calibration; key events are rare, so many tests honestly say "not enough to judge" (a test scoped to a different host than the property cannot be separated in GA4, which has no hostname on landing pages, and says so). A change-log entry with a URL prefix can be turned into a test with one click, and its verdict shows on the entry. Google's ranking updates inside a test window are listed next to the result. |
| **Indexing** | Opt-in per site: re-inspects the biggest pages daily (up to `INDEX_MONITOR_URLS`, default 40, least recently checked first) and logs *de-indexed, newly indexed, canonical changed, blocked by robots.txt, page fetch error*. First check is a baseline; changes appear from the second. URLs are checked in priority order: your **watch list**, pages that **appeared for the first time** this period (their indexing is still open), pages that lost visibility, then the biggest pages. Shows Google's reasons for non-indexing, the indexed share over time, and why a run stopped: a quota stop resumes tomorrow, a refusal (403) retries in ~6 h and a total failure in ~2 h, instead of being marked done or hammered. Plus **weak and dead URLs**: every page Search Console has shown, classed dead / not indexed / fading / underperforming / weak (cut-offs are heuristics). |
| **On-page** | Fetches a page of the site and checks title, meta description and H1 against the queries the page already earns clicks for (exact / all words / some words / missing), plus noindex, canonical, missing or several H1s. Fetching is confined to the site's own host or its subdomains (standard ports only, never an IP address, re-checked on every redirect) and refuses private addresses at connect time, so a name that resolves to localhost or a cloud metadata address is not fetched; 10 s timeout, 1.5 MB cap; JavaScript is not run. Set `ONPAGE_ALLOW_PRIVATE=1` only if the site genuinely lives on your own network. |
| **AI-assistant traffic** | On the GA4 tab: sessions from ChatGPT, Perplexity, Gemini, Claude and Copilot by landing page, found by the referrer GA4 recorded. A floor, not a total: assistants that send no referrer land in Direct. |
| **Core Web Vitals** | LCP, INP, CLS (plus FCP, TTFB) from the Chrome UX Report for phone and desktop, rated good / needs improvement / poor; one snapshot a day, so history builds from when you connect. Site-wide field data, not per page. |
| **Opportunities** | Striking distance ranked by *estimated extra clicks* using a **CTR curve fitted to your own data**; pages whose CTR is far below your curve. |
| **Cannibalization** | Merges URL variants first (www / slash / tracking params), then flags queries split across real competing pages, with clicks at stake. |
| **Decay** | Significance-tested (Poisson z) drops, labelled *page-specific* vs *site-wide*, with year-over-year when history allows. |
| **Anomalies** | Day-of-week-aware robust detector (not fooled by weekends). |
| **Action queue** | Every finding the app can make as **one ranked list** (per site and across sites; also an MCP tool): measurement broken, key pages blocked or de-indexed, traffic collapse, dead pages, cannibalization, CTR gaps, decay, striking distance, on-page and sitemap problems, finished tests. Blocking items come first, then estimated clicks per 28 days × confidence (high 1, medium 0.6, low 0.3), then items with no honest estimate. Estimates come from the site's own CTR curve and history, are model figures rather than promises, and are **not added together** because findings overlap. *Done* hides an item for 90 days and *snooze* for 30; if the problem is still detected afterwards it returns. The key for blocked / de-indexed / not-indexed items depends on the set of pages, so a changed set reappears as a new item. |
| **Digest and alerts** | A weekly digest (headline, top actions, real movers, Google updates, decided tests) made once a week on `DIGEST_DAY` (catching up if the server was off), and **urgent alerts** for blocking problems, checked every ~3 h, announced once and again only if still open after 14 days. Both are stored on the **Digest** page. Delivery is a **webhook only** (`DIGEST_WEBHOOK_URL`, Slack / Discord / generic JSON); **there is no email delivery**. A failed weekly delivery is retried at most hourly; urgent alerts mention at most 8 items per message and the rest follow in the next one. Teams Workflows webhooks are untested. |
| **Sitemap coverage** | Reads the sitemaps you submitted (follows indexes, gzip, up to 25 files / 200,000 URLs, only URLs of the property) and compares them with the pages Search Console has shown in 90 days: **never shown** (no impression at all; pages under two weeks old counted separately) and **earning clicks but missing from every sitemap**. "Never shown" uses the stored query×page detail, which leaves out anonymised and very rare queries, so treat it as a list to inspect, not proof of non-indexing. A **Check** button explains a "pending" sitemap (Google's own `isPending` flag: it accepted the file and has not processed it yet; resubmitting does not speed it up). The indexing monitor looks at never-shown pages first. |
| **Google updates** | Ranking-update dates from Google's Search Status Dashboard feed (plus your own entries), shown on the traffic chart, in tests that overlap one, in the action queue and in the digest. |
| **IndexNow** | Per site: creates the key, serves `/{key}.txt`, verifies it on each host, and submits new, changed and removed URLs (from the sitemap diff and the indexing monitor) to `api.indexnow.org`, with a 24 h per-URL cooldown and a daily cap (`INDEXNOW_MAX_PER_DAY`). **Google does not take part in IndexNow** (Bing, Yandex, Naver, Seznam and others do); the tab shows your Bing share of clicks against Google's so you can judge the value. For Google, the sitemap is still the route. |
| **Change log** | Annotate changes; get a before/after readout **adjusted for the site's overall trend**. |
| **Search Console actions** | Sitemaps (list / submit / resubmit / remove, per site and bulk across all sites), URL Inspection (cached 12 h), add / remove property. |
| **Portfolio** | The per-site findings merged into one list across all your visible, synced sites (a property that another already covers counts once; hidden sites are left out): striking distance, cannibalization (most serious cases), content decay and anomalies. Each site is judged on its own data first. Hover a tab, or read the line under the tabs, for what each means. |
| **Security** | OAuth tokens encrypted at rest (AES-256-GCM); password login with a per-visitor attempt limit and server-side sessions (random ids, 14-day expiry, ended by logout or a password change); without a password the app serves only a request that really comes from this machine (checks the connection's address and the `Host` header, and refuses anything behind a proxy), demo mode included; cross-site state-changing requests refused (including form posts with no Origin; only the server-to-server MCP and OAuth endpoints are exempt); "Sign in" for connectors uses PKCE S256, exact callback matching, one-time codes (5 minutes), tokens stored as hashes, refresh tokens that rotate and revoke the grant if an old one is replayed; Content-Security-Policy, HSTS over https, no-store on private pages; API keys stored as hashes, scoped per site, rate-limited, with a daily budget of live URL inspections; outbound fetches confined to the site's own host and refused for private addresses; containers run as an unprivileged user and the database file is owner-only; `READ_ONLY=1` mode; audit log; CSV formula-injection guard. See *Security notes* under Known limits. |

## Known limits (read these)

- **Anonymised queries**: Google hides some queries, so query tables never sum to the totals. The share is shown per site.
- **Per-day row cap** (`MAX_ROWS_PER_DAY`, default 100k): very large sites lose long-tail detail beyond it. Totals stay exact. Large sites may want Google's bulk BigQuery export instead.
- **Not yet built**: Yandex, email delivery of digests (webhook only), multi-user roles, i18n, PDF/client reports, SERP/rank tracking, the Indexing API, a REST API and monthly / white-label client reports (planned, not built), **writing** to Tag Manager / GA4 through MCP (creating tags, key events or custom dimensions, publishing containers): everything is read-only by design for now.
- **Verified**: unit/integration tests (`pnpm test`, 515 passing), type-check (`pnpm check`), production build, and a headless-browser crawl of the pages against **demo data**, including privacy-mode and phone-width checks.
  **Not verified**: a live Google OAuth round-trip and real Search Console / GA4 / Tag Manager / Clarity / Chrome UX Report responses (search types, search appearance, GA4 landing pages and Core Web Vitals are tested against documented response shapes and demo data only), the Bing OAuth flow, and the OpenSEO connection against a real instance — no credentials were available. Bing's API-key endpoint and its error format *were* confirmed against the live service (a deliberately invalid key returned Bing's documented `InvalidApiKey`). The MCP server was checked with the official MCP SDK client. Expect to debug first contact with the real APIs.
- **Motion** is short and subtle (page settle, staggered cards, charts drawing left to right, small bars growing, press feedback), and is switched off entirely for people whose system asks for reduced motion.
- **Comparisons wait for history.** Trends, Groups, Indexing classes and SEO tests compare against the previous period; while that period is still downloading, or has no data, they say so instead of showing every query as a winner.
- New analysis tabs (Trends, Groups, Tests, Indexing, On-page) are verified against demo data, controlled synthetic data with planted effects, an independent code review, and unit tests. Simulation of the SEO-test statistic (400 trials per case, daily traffic with drifting levels, no real change): about 40-60% false verdicts with a plain Poisson error, 0-4.5% after calibrating on earlier windows. The price: on very drifty traffic a real +40% change is detected only 15-45% of the time (on steady traffic, over 99%), so "no clear effect" is not "no effect". Not verified against real Search Console history, real URL Inspection responses (field names such as `verdict`, `robotsTxtState` and `pageFetchState` are from my recollection of the API) or real GA4 referrer names for AI assistants, which change.
- Unconfirmed details coded defensively: Tag Manager API v2 field names (`domainName`, `usageContext`, tag `type` codes `googtag` / `gaawc` / `gaawe` / `ua`, `paused`, `firingTriggerId`, and the 404 for a never-published container), GA4 `webStreamData.measurementId`, and Tag Manager API quotas (check Google's current documentation); a container with no `domainName` and a name that is not an address cannot be auto-matched, so link it by hand. GA4 `rows[].dimensionValues/metricValues` field names and the web-stream `defaultUri` used for auto-matching (if absent, link GA4 by hand); Clarity metric field names beyond `Traffic` (shown generically).
- Search Console API quotas (including URL Inspection) change; check Google's current documentation.
- Action queue, digest, sitemap coverage, conversions in tests, Google updates and IndexNow are verified against demo data, unit tests (mutation-checked), a browser pass, a real-shaped sitemap fixture, Google's real incidents feed, and an independent code review. **Nothing has run against live Google data.** GA4 data-retention behaviour, `measurementId`, Tag Manager and URL Inspection field names, and Google's refusal of off-property URLs (403) come from recollection; verify on first contact. GA4 loads more than 600,000 landing-page rows for a period are refused (the conversion block shows an error) rather than truncated.

### Security notes
- **What was tested.** Live attack probes against a running server (every route unauthenticated, path and `__data.json` tricks, cookie forgery and replay, cross-site posts, DNS-rebinding `Host` headers, a network client against a no-password instance, oversized and malformed MCP requests, scope leakage across 28 tools), an independent code audit, regression tests for each hole found (mutation-checked), and a browser pass for the CSP. Holes found and fixed this way: an open instance when bound to all interfaces, a session cookie that never expired and survived logout, DNS rebinding, a demo mode open to the network, a regular expression that froze the server on a hostile page, gaps in the private-address check, and quota abuse through `inspect_url`. **This is not a guarantee that no loophole remains**, and it was not a professional penetration test.
- **Run it behind HTTPS and set `ADMIN_PASSWORD`** for anything beyond your own computer. If a reverse proxy sits in front, make sure it passes the real visitor address (or accept that the login attempt limit is shared by everyone behind it).
- **Prompt injection.** Search queries, page titles and URLs come from third parties and appear in MCP output and chat digests. The MCP server tells agents to treat them as data, and chat messages escape mentions and markup, but a model can still be misled by text it reads; keep API keys read-only scoped to the sites an agent needs. Every MCP tool is read-only apart from `inspect_url` (which spends URL Inspection quota).
- **Known remaining limits.** `APP_SECRET` is hashed with plain SHA-256 (use 32+ random characters; it is not stretched). `list_sites` shows the Google account label to any key that can see the site. Error text from Google is passed through. A self-hosted OpenSEO may sit on a private address, so only credentials in the URL and link-local / cloud-metadata addresses are refused when connecting it. The Cloudflare Worker passes the visitor address in a header the container trusts (untested on a real account). Dependency audit: 4 low-severity advisories in a build-tool chain.

## Layout

```
src/lib/*.ts             pure, unit-tested logic: analytics, tracking, trends, groups, experiments (SEO test statistics),
                         indexing, onpage, actions (queue ranking), digest, sitemap (parser), indexnow
src/lib/server/          db, crypto, Google/Bing/Clarity clients, sync engine, job queue and scheduler, SQL queries, MCP server,
                         and the DB-backed halves of the features: actions, digest, seotests, ga4tests, sitemapcov,
                         indexmon, indexnow, gupdates; demo data source
src/lib/components/      shared Svelte components (charts, action cards, ...)
src/routes/              dashboard, portfolio, actions, digest, updates, accounts, sites/[id]/* tabs, auth, /api/mcp
tests/                   vitest (and real-shaped fixtures in tests/fixtures)
deploy/cloudflare/       Worker, entrypoint and Litestream config for the Cloudflare Container deploy
cloud/                   hosted-plan control app (sign-up, Stripe, Coolify provisioning, OAuth relay); its own build and tests
spike/workers/           feasibility spike and proof for a native Workers + D1 port (not part of the app)
Dockerfile, compose.yaml, Dockerfile.cloudflare, wrangler.jsonc   container and Cloudflare deploy files
```

## License

SEOConsole is free software under the **GNU Affero General Public License v3.0** (AGPL-3.0-only). See [LICENSE](LICENSE).
In short: you may use, study, modify and share it. If you modify it and let other people use your version over a network
(for example as a hosted service), the AGPL requires you to offer those users the corresponding source code. This summary is
not legal advice; the license text is what applies.
