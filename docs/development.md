# Development

Code layout and the marketing website.

[Back to the README](../README.md)

## Layout

```
src/lib/*.ts             pure, unit-tested logic: analytics, tracking, trends, groups, experiments (SEO test statistics),
                         indexing, onpage, actions (queue ranking), digest, sitemap (parser), indexnow
src/lib/server/          db, crypto, Google/Bing/Clarity clients, sync engine, job queue and scheduler, SQL queries, MCP server,
                         and the DB-backed halves of the features: actions, digest, seotests, ga4tests, llmtests, sitemapcov,
                         indexmon, indexnow, gupdates; demo data source
src/lib/components/      shared Svelte components (charts, action cards, ...)
src/routes/              dashboard, portfolio, actions, digest, updates, accounts, sites/[id]/* tabs, auth, /api/mcp
static/                  favicon, touch and app icons, the web manifest, and static/brand/ (the logo files: see brand.md in this folder)
tests/                   vitest (and real-shaped fixtures in tests/fixtures)
deploy/cloudflare/       Worker, entrypoint and Litestream config for the Cloudflare Container deploy
cloud/                   hosted-plan control app (sign-up, Stripe, Coolify provisioning, OAuth relay); its own build and tests
spike/workers/           feasibility spike and proof for a native Workers + D1 port (not part of the app)
Dockerfile, compose.yaml, Dockerfile.cloudflare, wrangler.jsonc   container and Cloudflare deploy files
```

## Checks

`pnpm check` (types), `pnpm test` and `pnpm build` are what GitHub runs on every pull request and every push to `main` (`.github/workflows/ci.yml`); run them before you push to see the same result. `.github/dependabot.yml` opens a weekly pull request for dependency updates (minor and patch grouped) and for the workflow's own actions, so each update goes through the same checks. The workflow covers the app only: the hosted-plan control app in `cloud/` has its own build and tests (`pnpm cloud:check`) and is not run by it.

## Website

`site/` is the marketing page for seoconsole.app: static HTML, CSS and a little vanilla JavaScript, no build step, no third-party requests, light mode only. It has its own `Dockerfile` (nginx, port 8080) and strict security headers. See [`site/README.md`](../site/README.md) for previewing, deploying and refreshing the screenshots. `tests/site.test.ts` keeps it honest: links resolve, nothing loads from another origin, the tool count matches the MCP server, and no customers or ratings are claimed.
