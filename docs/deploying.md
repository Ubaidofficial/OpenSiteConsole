# Deploying

Where to run it and what has been tested.

[Back to the README](../README.md)

## Deploying

**Set `ADMIN_PASSWORD`** before exposing the app beyond localhost: without it the app refuses non-loopback requests. Put it behind HTTPS. It is the **owner's** password; invite everyone else from the **Team** page (see *Team and roles* below).

| Where | How | Status |
|---|---|---|
| **Your computer / a server** | `pnpm serve` (or `pnpm start` after `pnpm build`) | The tested route. |
| **Coolify / a Docker server behind a proxy** (recommended for always-on use) | [`compose.coolify.yaml`](../compose.coolify.yaml) and [`deploy/coolify/`](../deploy/coolify/README.md): the app plus a named volume for the database, healthcheck, proxy-header settings, backup and data-move steps. Works the same on Railway (volume at `/data`). | The compose file parses and the healthcheck and proxy-header settings were tested against a running server; the image was **never built** and nothing was deployed. |
| **Docker (plain)** | `Dockerfile` and `compose.yaml` (data in a volume) | Written, **never built**. |
| **Cloudflare** | [`deploy/cloudflare/`](../deploy/cloudflare/README.md): a Worker in front of a Cloudflare Container running the app, the database replicated to an R2 bucket with Litestream, and a cron trigger that wakes it. Needs the Workers Paid plan and Docker on the computer you deploy from. | Written from the documentation. The Worker type-checks, `wrangler deploy --dry-run` accepts it and the start script is tested against a stand-in, but the image was **never built and nothing was deployed**. |
| **Hosted plan (control app)** | [`cloud/`](../cloud/README.md): a separate small program that sells a **$9/month hosted instance**: sign-up, Stripe Checkout, and automatic creation of one private instance per customer through the Coolify API, with grace period, suspension and retention rules. The app itself stays free to self-host. | Built and tested against fakes (45 tests); **never run against real Stripe, Coolify or Google review**. Needs your Stripe, Coolify and domain details, and Google OAuth verification before public use. |
| **Native Cloudflare Workers + D1** | Not supported. [`spike/workers/REPORT.md`](../spike/workers/REPORT.md) sizes the port (374 functions and 818 calls become async; D1's 10 GB cap) and includes a working proof. | A feasibility spike: staged go, not a quick change. |

**Public pages.** `/privacy` and `/terms` are readable without signing in, even when `ADMIN_PASSWORD` is set, because Google's OAuth verification needs a public privacy policy. They show nothing about the installation. Fill in `LEGAL_ENTITY` and `LEGAL_CONTACT_EMAIL` first. The Digest page is no longer in the top menu (it is still at `/digest`, and the weekly digest still runs).

**Dashboard on its own subdomain (for example `app.example.com`, with a website on the main domain).** The address the app is served at appears in four places, and all four must move together: your reverse proxy / Coolify domain, the `ORIGIN` environment variable, the Google OAuth client's *Authorized redirect URI* (`https://app.example.com/auth/callback`, plus `/auth/bing/callback` if you use Bing sign-in), and the connector URL you gave Claude (`https://app.example.com/api/mcp`). After changing them, remove and re-add the Claude connector (it was registered against the old address) and sign in again. Existing API keys keep working; only their address changes.

## Legal pages (privacy policy and terms)

`/privacy` and `/terms` are public and the footer of every page links to them; the website's footer links to them too, which Google's OAuth verification looks for. They describe what this software really does, written for someone running it alone. They are a starting point, **not legal advice**: have them read by someone qualified before you rely on them, above all if you take money or serve customers.

Before you connect real Google accounts or apply for Google's verification, set these (see `docs/configuration.md`):
- `LEGAL_ENTITY`: your name, or the name you trade under.
- `LEGAL_CONTACT_EMAIL`: an address you actually read. A dedicated one on your own domain is better than a personal inbox, because it is published.
- `LEGAL_GOVERNING_LAW`: the country or state whose law governs the terms (optional, but it fills a sentence that is otherwise vague).
- `LEGAL_UPDATED`: the date (`YYYY-MM-DD`) when you last changed the texts.

Until the first two are set the pages say "the operator of this SEOConsole installation" and give no contact, and Google will not accept that.

Keep the policy true. The pages list who receives data: Google and Microsoft, the search engines you submit URLs to, a webhook, the AI services behind the Ask chat and AI answer tracking, and your host. If you add a service that receives user data, add it to `privacySections` in `src/lib/legal.ts`. **Not covered:** a paid hosted plan. Before you charge anyone you need terms for price, renewal, cancellation and refunds, and a mention that a payment provider (Stripe) handles card data; none of that is in these texts.
