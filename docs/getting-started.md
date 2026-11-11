# Getting started

Install, first run, Google and Bing credentials, and the Connect page.

[Back to the README](../README.md)

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

## Getting credentials

**Google (Search Console + GA4 + Tag Manager)** — one OAuth client serves all three, and OpenSEO can share it.
1. [Google Cloud Console](https://console.cloud.google.com/) → create/select a project → enable **Google Search Console API**, **Google Analytics Admin API**, **Google Analytics Data API** and **Tag Manager API**.
2. OAuth consent screen → *External* → add your Google accounts as test users, then **Publish app** (in *Testing*, Google expires refresh tokens after about 7 days — verify against Google's current docs).
3. Credentials → *Create OAuth client ID* → *Web application* → add redirect URI `<ORIGIN>/auth/callback`.
4. Put the client ID/secret in `.env`. To reuse OpenSEO's client, add this redirect URI to that same client instead.
5. Tag Manager access is requested read-only (`tagmanager.readonly`) in the same consent; set `GOOGLE_INCLUDE_GTM=0` to leave it out. Accounts connected before this was added must use *Connect Google account* again to grant it. Whether Google requires app verification for this scope on a published app: I have not checked, so verify in the consent-screen settings.
6. **Set up GA4 & Tag Manager (optional, per site).** The **Connect** page has a button that creates a missing GA4 property and Tag Manager container and puts the Google tag in the container. It asks for its own consent when first used (`analytics.edit`, `tagmanager.edit.containers`, `tagmanager.edit.containerversions`, `tagmanager.publish`), which is never part of the normal sign-in and never requested with `READ_ONLY=1`; the *Google Analytics Admin API* and *Tag Manager API* from step 1 are the ones it uses. For someone with no GA4 account, Google sends them back to `<ORIGIN>/auth/callback` after they accept its Terms of Service, which is the redirect URI from step 3 (Google's reference says it must be a registered redirect URI). Behind the hosted plan's shared redirect address that return lands on the shared address, not on your instance: press **Continue** on the setup panel yourself. Whether Google needs app verification for these sensitive scopes: I have not checked.
7. **Sign in to SEOConsole with Google (optional).** With `ADMIN_PASSWORD` and the Google client set, the sign-in page shows *Continue with Google*. Add a **second redirect URI** to the same OAuth client: `<ORIGIN>/login/google/callback`. It asks Google for `openid email` only (no data access, nothing stored but the Google account ID). Google never creates an account: a team member is matched by their verified address (and the Google account is then linked to them), and the owner by `OWNER_GOOGLE_EMAILS`. Not available on the hosted plan. Members can link a Google account with a different address from *Your account*. `GOOGLE_LOGIN=0` hides it.

**Bing Webmaster Tools** (per Microsoft's docs) — two options:
- *API key (simplest, no registration):* sign in at bing.com/webmasters, verify your sites, **Settings → API Access → API Key → Generate API Key**. One key per Bing user, covering all their verified sites. Paste it on the **Connect** page.
- *OAuth (one-click for your users):* in the same **API Access** section choose **OAuth Client**, register a name and the redirect URI `<ORIGIN>/auth/bing/callback`, then set `BING_CLIENT_ID` / `BING_CLIENT_SECRET`. Scope used: `webmaster.read`.

**Microsoft Clarity** — per project: open the project → **Settings → Data Export → Generate new API token** (project admins only). Paste it on the **Connect** page for that site. Limits (Microsoft docs): 10 API calls per project per day, data for the last 1–3 days only, 1,000 rows, no paging — so SEOConsole refreshes the day's snapshot three times a day (every 8½ hours) (3 refreshes of 3 calls = 9 a day), always keeps one call free for a manual refresh, never goes over 10, and keeps one snapshot per day as history.

## Connecting sources (the "Connect" page)

One page, seven independent steps, status per site. Google sign-in grants Search Console, GA4 and Tag Manager together; Bing needs a key (or OAuth);
GA4 properties are auto-matched to sites by their web-stream URL; Tag Manager containers by their domain (or a container name that is the site's address), across every connected account that has Tag Manager access; Clarity needs a token per site; OpenSEO needs its URL + an `oseo_` API key; Core Web Vitals needs one free Google API key (enable the *Chrome UX Report API* in Google Cloud, then Credentials → API key).
Sites are matched by domain; anything unmatched is listed and can be linked by hand, or (GA4 and Tag Manager) created: each site row has a **Set up GA4 & Tag Manager** button that finds what exists, creates what is missing, links both and adds the Google tag after showing you the plan (see [features](features.md)). In demo mode, type `demo` as any key/token.
