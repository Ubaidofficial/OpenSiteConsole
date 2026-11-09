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
