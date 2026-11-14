# Deploy SEOConsole on Coolify (Netcup or any server)

This is the simplest way to run the app permanently, and the one I recommend over Cloudflare. The app is a Node server that keeps its data in a SQLite file and runs its own background scheduler (daily sync, alerts, digest). A normal server with a disk suits that exactly: no database port, no wake-ups, no R2 bucket.

> **Status: written from the documentation of Coolify and SvelteKit's Node adapter. The compose file parses, and its healthcheck command and the proxy-header settings were tested against a real server on this repository's code. The Docker image was NOT built and nothing was deployed to Coolify (no Docker or Coolify was available).** Expect to adjust labels in Coolify's screens, and tell me what differs.

## Which option?
| | Good for | Catch |
|---|---|---|
| **Coolify on Netcup** (this guide) | Always on, a real disk, your data on your server, same Dockerfile as everywhere | You own backups and updates |
| **Railway** | Works the same way: this compose file or the Dockerfile plus a volume at `/data` | You are leaving it |
| **Cloudflare Container** ([`deploy/cloudflare`](../cloudflare/README.md)) | No server to run | Disk is wiped on sleep, so it needs R2 plus Litestream; cold starts; the image was never built |
| **Your computer** | Zero setup | Sleeps with the laptop, so no scheduled syncs or alerts |

## Steps
1. **DNS.** Point a domain (for example `seo.example.com`) at the Netcup server.
2. **New resource in Coolify:** *Docker Compose* from this Git repository (branch `main`). Set the compose file location to `/compose.coolify.yaml`.
3. **Domain.** On the service, set the domain to `https://seo.example.com:3000`. The `:3000` tells Coolify's proxy which container port to send traffic to. The compose file deliberately publishes no host port: a published port would bypass the proxy.
4. **Environment variables** (Coolify shows them after loading the compose file):
   - `ORIGIN` = `https://seo.example.com` (the public address, no trailing slash). It builds the Google redirect address and the cookie's `Secure` flag.
   - `ADMIN_PASSWORD` = the login password you choose (or, instead, `ADMIN_PASSWORD_HASH`: a hash made with `pnpm hash-password`, so the password itself is never stored).
   - `APP_SECRET` = 32 or more random characters, for example from `openssl rand -base64 32`. It encrypts the Google tokens; keep a copy somewhere safe, because losing it means reconnecting every Google account.
   - Optional: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DIGEST_WEBHOOK_URL`, `MCP_INSPECT_PER_KEY_DAY` and the rest from `.env.example`.
   The deploy stops with a message if `ORIGIN` or `APP_SECRET` is missing. If you set neither `ADMIN_PASSWORD` nor `ADMIN_PASSWORD_HASH`, the app starts but refuses every remote request (it can never run open), so you would see an error page, not a login.
5. **Deploy.** The healthcheck calls `/login` from inside the container.
6. **Google sign-in.** In the Google Cloud console add `https://seo.example.com/auth/callback` to the OAuth client's authorised redirect URIs (and `.../auth/bing/callback` if you use Bing sign-in). Then open the site, sign in, and connect your Google accounts.

## If another proxy sits in front (for example Cloudflare in front of Coolify)
The app reads the visitor's address from `X-Forwarded-For` so the login attempt limit counts visitors separately. The compose file trusts **one** proxy (`XFF_DEPTH=1`). With Cloudflare proxying your domain as well, set `XFF_DEPTH=2` (my reading of how the header chain builds up; check by trying a wrong password from two networks). Do not set these two variables if the container is reachable directly without a proxy: the header could then be forged. A login attempt that arrives without the header is counted in one shared bucket instead of failing.

## Moving your local data
Your local `data/opensiteconsole.db` holds the history that Google no longer provides after 16 months, so it is worth moving.
1. Stop the local app. Copy `data/opensiteconsole.db` and, **if you never set `APP_SECRET` locally**, also read `data/opensiteconsole.db.secret`: that file's contents are the key that encrypts your Google tokens, so use them as the `APP_SECRET` value in Coolify. (If you did set `APP_SECRET` locally, use the same value.)
2. After the first deploy has created the volume, stop the app in Coolify, copy the database into the volume and fix its owner. On the server, with the container name from `docker ps`:
   ```bash
   docker cp opensiteconsole.db <container>:/data/opensiteconsole.db
   docker exec -u root <container> chown node:node /data/opensiteconsole.db
   ```
   then start the app again. (`docker cp` leaves the file owned by root, which the app's unprivileged user could not write.) If a `-wal` or `-shm` file sits next to your local database, stop the local app first so SQLite folds them in.
3. If you skip this, start fresh: reconnect your Google accounts and the app downloads Google's last 16 months again.

## Backups (you own these)
The database is one file in the `osc-data` volume. Two layers are sensible:
- **Server snapshots** from Netcup (whatever they offer for your plan; I have not checked).
- **A daily consistent copy inside the volume, made by the app itself.** Once a day the app writes `/data/backups/opensiteconsole-YYYY-MM-DD.db` with SQLite's own backup call (a plain file copy of a live database can catch it mid-write), opens the copy and runs SQLite's integrity check on it, and keeps the newest 3 (`BACKUP_KEEP`, up to 30; each is a full copy, so allow for that much disk). It is on by default and switched off with `BACKUP=0`; `BACKUP_DIR` moves the folder. It refuses to run when the disk would be left nearly full. If a backup fails, the audit log (Agents page) records it and, with `DIGEST_WEBHOOK_URL` set, the webhook is told once a day.
  **What it does not do:** the copy is on the same disk as the database, so it guards against a bad change or a damaged file, not against losing the server. Copy `/data/backups/` off the machine now and then (for example with `rclone` or `scp`), or rely on the server snapshots above. The copy holds the encrypted Google tokens and opens them only with the same `APP_SECRET`, so keep that safe as well.
  **Restoring:** stop the app, copy the chosen file over `/data/opensiteconsole.db` (delete any `opensiteconsole.db-wal` and `-shm` beside it first), fix its owner as in the data-move steps above, and start the app again.

## Updating
Redeploy from Coolify (or turn on its auto-deploy for the branch). The volume, and so your data, stays.

## What is verified and what is not
- **Tested here:** the compose file parses; the healthcheck command exits 0 against a running server; with `ADDRESS_HEADER=X-Forwarded-For` and `XFF_DEPTH=1`, five wrong passwords from one address lock that address while another address can still sign in; the session cookie carries `Secure` when `ORIGIN` is https; the backup call produces a readable copy of a WAL database (and the app's own backup is covered by unit tests on a real file database).
- **Not tested:** building the image, Coolify itself (domain field, environment screen, scheduled tasks), Netcup, and Cloudflare in front of Coolify.
