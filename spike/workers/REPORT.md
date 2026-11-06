# Feasibility spike: a native Cloudflare Workers + D1 port of OpenSiteConsole

**Verdict: staged go, gated on a sizing decision. The Workers free plan is not possible.**
This is a spike, not a port. Nothing under `src/` was changed.

## How to read this report
Written by the main session from a spike agent's findings. Each item is tagged:

- **Reproduced**: re-run by the main session after the agent finished (commands below).
- **Agent-reported**: measured or quoted by the agent; the main session did not re-check it.
- **Unverified**: not measured or not documented.

Fixtures are synthetic. The local D1 emulator is not production: it did not enforce the 2 MB bind limit, the queries-per-invocation limit or a batch-size limit, so local success is not production evidence.

Measured against commit `2104582` (the feature branch before the Cloudflare container kit). The kit and this spike are additive.

## 1. What breaks today (agent-reported)
- `@sveltejs/adapter-cloudflare@8.0.2` fails on SvelteKit 2.70.3 (its peer needs Kit 3): `TypeError: Cannot read properties of undefined (reading 'assets')`. Adapter 7.2.10 (npm tag `version-2`) builds, and `wrangler deploy --dry-run` exits 0. **A green build would hide the real problem:** at runtime every request fails.
  - `db.ts` `openDb` calls `mkdirSync`, which is not permitted; then `better-sqlite3` fails with `__filename is not defined` (the native module cannot load).
  - `onpage.ts` `guardedFetch` fails: the `lookup` option of `node:http` is "not implemented".
  - Global-scope timers are rejected, so the `jobs.ts` scheduler and in-memory queue have no home. 11 `enqueue*` call sites in 7 route files are fire-and-forget and would be cancelled after the response unless moved to `waitUntil` or a Queue.
- Adapter 8 needs Kit 3, so a native port is also coupled to a Kit major upgrade.

## 2. Data layer (reproduced)
`node spike/workers/scripts/count-callsites.mjs` (a TypeScript type-checker script, not a grep):

| Measure | Count |
|---|---|
| `.prepare` sites | 270 |
| Calls needing `await` under D1 | 291 (248 in `src/lib/server`, 43 in routes and hooks) |
| Transactions | 17 (14 map to `batch()`, 3 read inside the transaction: `accounts.ts:72`, `sitemapcov.ts:90`, `gupdates.ts:45`) |
| `lastInsertRowid` uses | 8 |
| `INSERT OR REPLACE` statements | 34 |
| `.iterate`, `.changes`, user-defined functions | 0 |
| Functions that must become async | 374 (246 are synchronous today) |
| Calls to those functions | 818, of which 769 have no `await` today; 27 inside array callbacks |

The "~340" quoted earlier in this session was a naive grep (348) that included `Map.get`. The true blast radius is the **374 functions / 818 calls**, not 270. Because 769 calls would silently become floating promises, a `no-floating-promises` lint rule should come before any conversion.

## 3. D1 and Workers limits (agent-reported, quoted from developers.cloudflare.com on 2026-11-06; re-check)
- D1: 100 bound parameters per statement; 100 KB statement; 2 MB string or row; **10 GB database, which cannot be increased** (500 MB free); 30 s per query (applies to a whole batch); 50 MB result; 1,000 queries per invocation on paid and 50 on free (a batch counts as 1).
- **Maximum statements per batch is not documented (unverified).**
- Workers: subrequests 50 (free) / 10,000 (paid); cron CPU 30 s if the interval is under an hour, 15 min if an hour or more; queue consumer CPU 30 s by default, up to 5 min; 128 MB memory.
- Capacity (agent-measured on synthetic data): `sa_rows` is about 403 bytes per row including two indexes, so about **25 million rows per 10 GB**. The app allows 100,000 rows a day for 16 months, which is about **48 million rows**. A very large property would not fit in D1. Typical sites would.
- Write cost (agent-measured on the local emulator): an upsert writes 3 rows per row, a delete 1, so re-pulling a day writes 4 per row. Packing rows with `json_each` cuts a 100,000-row day from 100,601 statements to 312.

## 4. Scheduling (agent-reported, limits as above)
`schedulerTick` and the backfill would become a Cron Trigger plus Queues or Workflows, with resumable steps. The proof runs a resumable sync step from `scheduled()` (33 invocations to reach the backfill horizon). **Not measured:** Workers CPU time (not exposed locally) and production D1 write latency, so whether a big Search Console backfill chunk fits in the CPU limits is unknown.

## 5. SSRF guard (agent-reported)
`hostAllowed` and the manual-redirect loop port unchanged. `guardedFetch`'s connect-time private-IP check cannot exist on Workers. Cloudflare's documentation (security model, known issues, TCP sockets pages) says outbound `fetch` from a Worker cannot reach internal services. How a public name that resolves to a private address behaves in production is unverified. `ONPAGE_ALLOW_PRIVATE` would be lost (a site on a private network could not be checked).

## 6. Smaller swaps (agent-reported, proven in workerd by the proof)
- `DecompressionStream` gunzip matches `node:zlib` on a 50,001-URL sitemap, a zip-bomb cap and a damaged archive.
- WebCrypto AES-GCM and HMAC are wire-compatible with `crypto.ts` (a known-answer vector plus 800 cross-engine operations, 0 mismatches), so stored Google tokens would still decrypt.
- `node:crypto`, `node:zlib`, `node:path`, `node:net` and `node:dns` also loaded in the workerd probe. These are not blockers. (`nodejs_compat` made no difference at compat date 2026-10-01; why is unknown.)

## 7. The proof (reproduced)
`spike/workers/proof/`: a plain Worker with a local D1, migrations generated from the real `db.ts`, an async `Db` interface (D1 and better-sqlite3 implementations), line-for-line ports of the real `sync.ts` and a 9-function slice of `queries.ts`, and a `scheduled()` handler. The vitest harness compares the original better-sqlite3 code with the port on identical input: **12 tests, 158 checks, 0 failures**, with tables identical step by step (3 sites, 70,613 `sa_rows`, two 26,000-row days, backfill to the horizon), over HTTP and through scheduled invocations. See `proof/RESULTS.txt`.

## 8. Recommendation: staged
1. Add `no-floating-promises` linting, and decide the sizing question (D1's 10 GB cap against very large properties; paid plan required).
2. Introduce the async `Db` interface and convert module by module, keeping better-sqlite3 as the second implementation so the 318 tests keep running unchanged against both.
3. Move the scheduler to Cron Triggers plus a queue, with `waitUntil` for the 11 fire-and-forget sites.
4. Upgrade to SvelteKit 3 and adapter-cloudflare 8, or stay on adapter 7.x for a while.
5. Measure CPU time and D1 write throughput on a real account before committing.

**Top risks:** (1) D1 capacity, cost and write time; (2) the async blast radius (374 functions, 818 calls); (3) the background-work model, and the Kit 3 coupling.

## 9. Not done
Full SvelteKit app end to end on Workers; Queues; Workflows; a Kit 3 upgrade; `@cloudflare/vitest-pool-workers`; the other ~25 server modules; the real Search Console client; a real cron (the proof used `--test-scheduled`); production D1 numbers; the exact limits key for raising subrequests; `process.env` population from Worker variables.

## Reproduce
```bash
pnpm install --frozen-lockfile && pnpm exec svelte-kit sync
node spike/workers/scripts/count-callsites.mjs        # --txns / --hazards / --json
bash spike/workers/scripts/try-cloudflare-build.sh    # ADAPTER=latest shows the Kit 3 mismatch
cd spike/workers/proof && pnpm install --ignore-workspace   # plain npm install crashes in this pnpm tree
pnpm test                                             # about 2.5 minutes, prints PASS/FAIL per check
node probe/run-probe.mjs ; node scripts/measure-big-day.mjs
```
