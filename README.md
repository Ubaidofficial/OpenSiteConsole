# OpenSiteConsole

A self-hosted dashboard for **all your Google Search Console properties across many Google accounts**.
It syncs your data into a local SQLite warehouse (so history is kept beyond Google's 16 months), analyses it,
and lets you do the day-to-day Search Console chores — sitemaps, URL inspection, property management — from one place.

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

Production: `pnpm build && node build` (or the untested Dockerfile). **Set `ADMIN_PASSWORD`** before exposing it beyond localhost —
without it the app refuses non-loopback requests. Put it behind HTTPS.

## Getting credentials

**Google (Search Console + GA4)** — one OAuth client serves both, and OpenSEO can share it.
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project → enable **Google Search Console API**, **Google Analytics Admin API** and **Google Analytics Data API**.
2. OAuth consent screen → *External* → add your Google accounts as test users, then **Publish app** (in *Testing*, Google expires refresh tokens after about 7 days — verify against Google's current docs).
3. Credentials → *Create OAuth client ID* → *Web application* → add redirect URI `<ORIGIN>/auth/callback`.
4. Put the client ID/secret in `.env`. To reuse OpenSEO's client, add this redirect URI to that same client instead.

**Bing Webmaster Tools** (per Microsoft's docs) — two options:
- *API key (simplest, no registration):* sign in at bing.com/webmasters, verify your sites, **Settings → API Access → API Key → Generate API Key**. One key per Bing user, covering all their verified sites. Paste it on the **Connect** page.
- *OAuth (one-click for your users):* in the same **API Access** section choose **OAuth Client**, register a name and the redirect URI `<ORIGIN>/auth/bing/callback`, then set `BING_CLIENT_ID` / `BING_CLIENT_SECRET`. Scope used: `webmaster.read`.

**Microsoft Clarity** — per project: open the project → **Settings → Data Export → Generate new API token** (project admins only). Paste it on the **Connect** page for that site. Limits (Microsoft docs): 10 API calls per project per day, data for the last 1–3 days only, 1,000 rows, no paging — so OpenSiteConsole stores one snapshot a day.

## Connecting sources (the "Connect" page)

One page, five independent steps, status per site. Google sign-in grants Search Console and GA4 together; Bing needs a key (or OAuth);
GA4 properties are auto-matched to sites by their web-stream URL; Clarity needs a token per site; OpenSEO needs its URL + an `oseo_` API key.
Sites are matched by domain; anything unmatched is listed and can be linked by hand. In demo mode, type `demo` as any key/token.

## OpenSEO and AI agents

- **Agents page** → create an API key (optionally limited to some sites) → add OpenSiteConsole as an MCP server next to OpenSEO's. Nine read-only tools; nothing can write or spend money.
- Connect OpenSEO on the Connect page and each site is linked to its OpenSEO project by domain. An agent calls `get_openseo_project` to obtain the project id, then uses OpenSEO's own tools (keyword research, rank tracking, audits) on it — first-party history from here, third-party data from there.

## What it does

| Area | Details |
|---|---|
| **Warehouse** | Incremental sync (re-pulls the newest 3 days, which Google revises) + resumable backfill to the retention horizon. Stores `date × query × page × country × device`, plus accurate daily totals. Background scheduler; per-site status. |
| **Dashboard** | Every property from every account: KPIs, sparklines, period-over-period deltas, search, tags, hide. |
| **Site analysis** | Change chart with anomaly bands; queries & pages (branded split, country/device filters, full-history chart per row, CSV export); segments. |
| **Opportunities** | Striking distance ranked by *estimated extra clicks* using a **CTR curve fitted to your own data**; pages whose CTR is far below your curve. |
| **Cannibalization** | Merges URL variants first (www / slash / tracking params), then flags queries split across real competing pages, with clicks at stake. |
| **Decay** | Significance-tested (Poisson z) drops, labelled *page-specific* vs *site-wide*, with year-over-year when history allows. |
| **Anomalies** | Day-of-week-aware robust detector (not fooled by weekends). |
| **Change log** | Annotate changes; get a before/after readout **adjusted for the site's overall trend**. |
| **Search Console actions** | Sitemaps (list / submit / resubmit / remove, per site and bulk across all sites), URL Inspection (cached 12 h), add / remove property. |
| **Portfolio** | Striking / cannibalization / decay / anomalies across all sites at once. |
| **Security** | OAuth tokens encrypted at rest (AES-256-GCM), optional password with rate limiting, refuses remote access without one, `READ_ONLY=1` mode (read scope + disables writes), audit log of write actions, CSV formula-injection guard. |

## Known limits (read these)

- **Anonymised queries**: Google hides some queries, so query tables never sum to the totals. The share is shown per site.
- **Per-day row cap** (`MAX_ROWS_PER_DAY`, default 100k): very large sites lose long-tail detail beyond it. Totals stay exact. Large sites may want Google's bulk BigQuery export instead.
- **Not yet built**: Bing / Yandex / GA4, email/Slack alerts & digests, multi-user roles, i18n, PDF/client reports, SERP/rank tracking, the Indexing API.
- **Verified**: unit/integration tests (`pnpm test`), type-check, production build, and a headless-browser crawl of every page against **demo data**.
  **Not verified**: a live Google OAuth round-trip and real Search Console / GA4 / Clarity responses, the Bing OAuth flow, and the OpenSEO connection against a real instance — no credentials were available. Bing's API-key endpoint and its error format *were* confirmed against the live service (a deliberately invalid key returned Bing's documented `InvalidApiKey`). The MCP server was checked with the official MCP SDK client. Expect to debug first contact with the real APIs.
- Unconfirmed details coded defensively: GA4 `rows[].dimensionValues/metricValues` field names and the web-stream `defaultUri` used for auto-matching (if absent, link GA4 by hand); Clarity metric field names beyond `Traffic` (shown generically).
- Search Console API quotas (including URL Inspection) change; check Google's current documentation.

## Layout

```
src/lib/analytics.ts     pure analysis functions (unit-tested)
src/lib/server/          db, crypto, google client, sync engine, job queue, SQL queries, demo data source
src/routes/              dashboard, portfolio, sitemaps, accounts, sites/[id]/* tabs, auth
tests/                   vitest
```
