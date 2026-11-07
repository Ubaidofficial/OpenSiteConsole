# Deploy SEOConsole on Cloudflare

A Worker sits in front of a **Cloudflare Container** that runs the app exactly as it runs on your own machine. The SQLite database is copied to an **R2 bucket** by [Litestream](https://litestream.io) and restored whenever the container starts on a fresh disk.

> **Status: written from Cloudflare's and Litestream's documentation, not run on a real Cloudflare account.** The Worker type-checks against the real `@cloudflare/containers` package, `wrangler deploy --dry-run` accepts the configuration and bundles the Worker, and the start script is tested against a stand-in for Litestream. The Docker image has **not** been built, and Litestream has not been run. Expect to debug first contact, and tell me what breaks. See "What is not verified" below.

> **Which to pick?** For an always-on install, [Coolify or another Docker server](../coolify/README.md) is simpler: a real disk, no R2 bucket, no cold starts. Use Cloudflare only if you do not want to run a server.

## Why a container
The app is a Node server with a SQLite file and its own background scheduler (syncs, digests, alerts, indexing checks). Plain Workers cannot load that native database module or keep a disk. A native Workers version (D1 instead of SQLite, Cron Triggers instead of the built-in scheduler) is a much larger port: see [spike/workers/REPORT.md](../../spike/workers/REPORT.md) for the measured size (374 functions and 818 calls become async) and a working D1 proof. Verdict there: staged go, not a quick change.

## What you need
- A Cloudflare account on the **Workers Paid** plan (Containers are not on the free plan).
- **Docker running on the computer you deploy from.** Wrangler builds the image locally and pushes it to Cloudflare.
- Node 22, and R2 enabled on your account.

## Steps
1. **R2 bucket and token.** In the dashboard open R2, create a bucket (the default name in `wrangler.jsonc` is `opensiteconsole-data`; change `R2_BUCKET` there if you use another). Under R2 → *Manage API tokens* create a token with **Object Read & Write** for that bucket, and note the **account ID**, the **access key ID** and the **secret access key**.
2. **Install the deploy tools** (they stay out of the app's own dependencies):
   ```bash
   npm install --prefix deploy/cloudflare
   ```
3. **Deploy** from the repository root (the first build takes a while; after the first deploy Cloudflare says to wait several minutes before container requests succeed):
   ```bash
   npx --prefix deploy/cloudflare wrangler deploy
   ```
4. **Set the secrets** (each command asks for the value):
   ```bash
   npx --prefix deploy/cloudflare wrangler secret put ADMIN_PASSWORD
   npx --prefix deploy/cloudflare wrangler secret put APP_SECRET        # 32+ random characters; encrypts Google tokens at rest
   npx --prefix deploy/cloudflare wrangler secret put GOOGLE_CLIENT_ID
   npx --prefix deploy/cloudflare wrangler secret put GOOGLE_CLIENT_SECRET
   npx --prefix deploy/cloudflare wrangler secret put R2_ACCOUNT_ID
   npx --prefix deploy/cloudflare wrangler secret put R2_ACCESS_KEY_ID
   npx --prefix deploy/cloudflare wrangler secret put R2_SECRET_ACCESS_KEY
   ```
   Until `ADMIN_PASSWORD`, `APP_SECRET` and the four R2 values are set, the Worker answers with a plain message naming what is missing, and the container refuses to start rather than run without a password or without a backup. Any other setting from `.env.example` (for example `DIGEST_WEBHOOK_URL`) can be added the same way, as a secret or under `vars` in `wrangler.jsonc`; every string variable on the Worker is passed to the app.
5. **Google sign-in.** Use your public address (for example `https://opensiteconsole.<your-subdomain>.workers.dev`, or your own domain) in the Google OAuth client as an authorised redirect URI: `<address>/auth/callback`. If you do not set `ORIGIN`, the first address you open the app on is remembered and used; set `ORIGIN` under `vars` in `wrangler.jsonc` to pin it (do this if you later add a custom domain).
6. Open the address, sign in with `ADMIN_PASSWORD`, and connect Google on the **Connect** page.

Secrets and variables are read when the container **starts**. After changing one, the container picks it up the next time it starts (it sleeps after `SLEEP_AFTER` of no requests, 20 minutes by default, and the cron trigger wakes it).

## How it behaves
- **Sleep and wake.** The container sleeps after 20 minutes without requests (`SLEEP_AFTER`). A cron trigger (`0 */3 * * *`, every 3 hours) wakes it, and the app's own scheduler then does whatever is due: the daily sync and indexing checks, urgent alerts (every 3 hours) and the weekly digest (which catches up if it was due). Visiting the app wakes it too, after a cold start of some seconds.
- **For an always-on instance** (sync as soon as data is available, alerts within minutes of a problem), set `"SLEEP_AFTER": "35m"` and change the cron to `*/30 * * * *`. It costs more.
- **Your data.** Litestream copies each change to R2 about every second. If the container is replaced, the next start restores the latest copy. Anything written in the last second or so before an abrupt stop can be lost.
- **One instance only.** `max_instances` is 1 because the database has a single writer.
- **Protect it further** (optional): put the Worker's domain behind Cloudflare Access so only your team can reach even the login page.

## Cost (an estimate, check the current pricing page)
Cloudflare's Containers page (last updated Oct 5, 2026 when I read it) bills memory and disk for every 10 ms a container is running, and CPU only while it is actively used. The rates I read: memory $0.0000025 per GiB-second, disk $0.00000007 per GB-second, CPU $0.000020 per vCPU-second, with 25 GiB-hours of memory, 200 GB-hours of disk and 375 vCPU-minutes included in the $5 Workers Paid plan.
- The `basic` instance has 1 GiB of memory and 4 GB of disk. Running all month (about 2.59 million seconds) that is roughly **$6.30 of memory plus $0.70 of disk beyond the included amounts**, so about **$7 a month on top of the $5 plan**, plus CPU, requests and R2 storage, which should be small.
- With the default 3-hourly wake and 20-minute sleep the container runs a small fraction of the time, so the cost is a fraction of that. How much depends on how long your syncs take.

## Updating
Pull the new version and run `npx --prefix deploy/cloudflare wrangler deploy` again. Cloudflare rolls the container over; the database is restored from R2 on the new instance.

## Restoring or inspecting the database
The replica lives in your bucket under `opensiteconsole/`. To restore it on your own computer, install Litestream and run `litestream restore -o ./opensiteconsole.db s3://...` with the R2 endpoint settings from `litestream.yml` (see Litestream's documentation).

## What is not verified
- The image build (`Dockerfile.cloudflare`) was never run: there is no Docker in the environment it was written in. The Litestream binary path (`/usr/local/bin/litestream` in `litestream/litestream:0.5`) was confirmed by reading the published image's layers; the binary itself was not run.
- Nothing was deployed to Cloudflare. Whether the secrets reach the container at the first start, how `wake()` behaves on a cold container, and the container's behaviour on `SIGTERM` (Litestream is documented to exit when the app exits; I could not confirm that it forwards the signal to the app) are from the documentation and the package's type definitions, not from a run.
- The cost figures are my arithmetic from the rates above.
- Cloudflare Containers are a newer product than Workers; check their current limits and status before relying on this for anything important.
