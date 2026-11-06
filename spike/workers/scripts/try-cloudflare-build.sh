#!/usr/bin/env bash
# Section (a) of the spike report, reproducibly: build the REAL app with adapter-cloudflare in a scratch copy (the repo's own
# svelte.config.js and src/ are never touched), then try to run it in workerd.
#
#   bash spike/workers/scripts/try-cloudflare-build.sh            # uses the correct adapter for SvelteKit 2 (7.2.10)
#   ADAPTER=latest bash spike/workers/scripts/try-cloudflare-build.sh   # shows the adapter-8 / SvelteKit-3 mismatch
#
# Needs network for npm only. Nothing is deployed and no Cloudflare credentials are used (dev runs with --local).
set -u
ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
WORK="$(mktemp -d)"
ADAPTER="${ADAPTER:-7.2.10}"
export WRANGLER_SEND_METRICS=false CI=1 NO_COLOR=1
say() { printf '\n=== %s ===\n' "$*"; }

say "scratch copy of HEAD in $WORK"
git -C "$ROOT" archive HEAD | tar -x -C "$WORK"
cd "$WORK"

say "install adapter-cloudflare@$ADAPTER + wrangler"
if [ "$ADAPTER" = latest ]; then pnpm add -D @sveltejs/adapter-cloudflare wrangler >/dev/null 2>&1; else pnpm add -D "@sveltejs/adapter-cloudflare@$ADAPTER" wrangler >/dev/null 2>&1; fi
grep -E '"(@sveltejs/(kit|adapter-cloudflare)|wrangler)"' package.json
sed -i "s#adapter-node#adapter-cloudflare#" svelte.config.js
printf '{ "name": "osc-spike", "main": ".svelte-kit/cloudflare/_worker.js", "compatibility_date": "2026-10-01", "assets": { "binding": "ASSETS", "directory": ".svelte-kit/cloudflare" } }\n' > wrangler.jsonc

say "1. vite build (SvelteKit + adapter)"
pnpm vite build > build.log 2>&1; echo "exit code: $?"
grep -E "TypeError|Error:|✔ done|error during build" build.log | head -5

say "2. wrangler bundle (dry run, no upload): which node:* imports survive into the Worker?"
pnpm exec wrangler deploy --dry-run --outdir dist-dry > dry.log 2>&1; echo "exit code: $?"
[ -f dist-dry/_worker.js ] && { ls -l dist-dry/_worker.js | awk '{print "bundle bytes:", $5}'; grep -oE 'from "node:[a-z/_]+"' dist-dry/_worker.js | sort | uniq -c; }

say "3. wrangler dev --local: first request, as shipped"
pnpm exec wrangler dev --local --port 8788 --ip 127.0.0.1 > dev1.log 2>&1 &
DEV=$!; for _ in $(seq 1 60); do grep -q "Ready on" dev1.log && break; sleep 1; done
curl -s -m 30 -i http://127.0.0.1:8788/ | head -8; kill $DEV 2>/dev/null; sleep 1; pkill -f workerd 2>/dev/null

say "4. same, after removing only the mkdirSync in db.ts (to find the NEXT blocker)"
sed -i "s#if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });##" src/lib/server/db.ts
pnpm vite build > build2.log 2>&1
pnpm exec wrangler dev --local --port 8789 --ip 127.0.0.1 > dev2.log 2>&1 &
DEV=$!; for _ in $(seq 1 60); do grep -q "Ready on" dev2.log && break; sleep 1; done
curl -s -m 30 -o /dev/null http://127.0.0.1:8789/; sleep 2; kill $DEV 2>/dev/null; pkill -f workerd 2>/dev/null
grep -E "ERROR|__filename|never complete" dev2.log | head -4
echo; echo "(scratch copy left in $WORK)"
