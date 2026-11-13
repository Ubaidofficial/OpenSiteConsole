<h1 align="center"><img src="static/brand/banner.png" alt="SEOConsole" width="860"></h1>

> Formerly **OpenSiteConsole**. Only the name changed: the repository path, database file (`data/opensiteconsole.db`), Docker service name and `osc_` API-key prefix keep the old name so existing installs and keys keep working.

A self-hosted dashboard for **all your Google Search Console properties across many Google accounts**. It keeps your data past Google's 16 months, joins it with GA4, Tag Manager, Bing and Clarity, and turns it into a ranked to-do list. AI agents can use it over MCP, read-only by default.

> **Status.** Verified against demo data, unit tests and a headless-browser pass. **Nothing has been run against live Google data or on a real Cloudflare account**, so expect to debug first contact with the real APIs. See [known limits](docs/known-limits.md).

## What you get

- **A ranked to-do list**: what to fix first and why, per site and across sites.
- **History and analysis**: queries, pages, trends, decay, cannibalization, anomalies, Core Web Vitals.
- **One-click GA4 & Tag Manager setup**: per site, find or create the GA4 property and Tag Manager container, link both and add the Google tag, after showing the plan and with its own opt-in permission. SEOConsole cannot put the Tag Manager code on your site, so it shows it with a copy button.
- **Sign in with Google, and self-service accounts**: team members can sign in with Google, change their own name, email and password, and an admin can hand out one-time reset links (there is no email sending).
- **Light and a dim dark theme**: a sun/moon button in the header switches, and the choice is remembered per browser. Light is the default.
- **SEO and LLM tests**: before/after, split and redirect tests with a control group and a significance figure.
- **Indexing without the busywork**: sitemap coverage and `lastmod` checks, IndexNow and Bing submission, an indexing monitor, and a daily Request Indexing list. Google has no API for that button, so you still press it yourself, one page at a time.
- **Digest and alerts**: a weekly digest, urgent alerts and a monthly report, by webhook if you set one.
- **Ask your data**: a chat over your own data, using your own Anthropic API key.
- **MCP server and REST API**: the same tools for agents and scripts, with keys that read only unless you allow more.
- **Team**: unlimited users with roles.

The [full feature list](docs/features.md) has the details.

## Quick start

```bash
pnpm install
cp .env.example .env        # then edit it
pnpm dev                    # http://localhost:5173
```

Needs Node.js 20.19+ or 22+ and pnpm 10 or 12 (`corepack enable` provides pnpm). To try it without Google credentials, set `DEMO_MODE=1` in `.env`. To connect real accounts, create a Google OAuth client and put `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`; the steps, and the first sign-in, are in [getting started](docs/getting-started.md).

## Deploying

**Set `ADMIN_PASSWORD`** before exposing the app beyond localhost: without it the app refuses non-loopback requests. Put it behind HTTPS.

| Where | Status |
|---|---|
| Your computer or a server: `pnpm serve` | The tested route. |
| Coolify or a Docker server ([`compose.coolify.yaml`](compose.coolify.yaml)); plain Docker | The compose file and healthcheck were tested against a running server; the image was **never built** and nothing was deployed. |
| Cloudflare Container ([`deploy/cloudflare/`](deploy/cloudflare/README.md)) | Written from the documentation, **never deployed**. |
| Hosted plan control app ([`cloud/`](cloud/README.md)) | Built against fakes, **never run against real Stripe, Coolify or Google review**. |

Details, including putting the dashboard on its own subdomain, are in [deploying](docs/deploying.md).

## Team and roles

The owner (whoever signs in with `ADMIN_PASSWORD`) or an admin invites people from the **Team** page. Roles: **owner** and **admin** (everything), **editor** (uses the app but cannot connect accounts, manage keys or change settings) and **viewer** (read only). Editors and viewers can be limited to some sites. Roles are enforced on the server for every request. See [team and roles](docs/team-and-roles.md).

## Documentation

- [Getting started](docs/getting-started.md): install, credentials, connecting sources
- [Configuration](docs/configuration.md): every environment variable
- [Deploying](docs/deploying.md)
- [AI agents, MCP and OpenSEO](docs/agents-and-mcp.md)
- [Features](docs/features.md)
- [Known limits and security notes](docs/known-limits.md)
- [Development](docs/development.md) and [brand files](docs/brand.md)

## License

Free software under the **GNU Affero General Public License v3.0** (AGPL-3.0-only); see [LICENSE](LICENSE). If you modify it and let other people use your version over a network, the AGPL requires you to offer them the source. This is not legal advice; the license text is what applies.
