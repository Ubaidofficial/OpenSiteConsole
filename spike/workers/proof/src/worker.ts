/**
 * Proof Worker. Not SvelteKit: a plain Worker with a D1 binding, exposing the ported functions over HTTP so the Node-side
 * test (test/compare.test.ts) can drive them and compare their output with the original better-sqlite3 code.
 *
 *   fetch()      /reset /seed /sync /dump /q /crypto/* /sitemap /state
 *   scheduled()  one resumable sync step (cron). Invoked locally with `wrangler dev --test-scheduled` -> GET /__scheduled
 */
import { D1Db, type D1DatabaseLike } from './db';
import { RESET, SEED } from './seed';
import { FixtureClient } from './fixture';
import { syncSite } from './port/sync';
import * as Q from './port/queries';
import * as W from './crypto-web';
import { sitemapText } from './sitemap-gunzip';
import { dump } from './dump';
import { parseSitemapXml } from '../../../../src/lib/sitemap';
import { pacificToday } from '../../../../src/lib/server/dates';

export interface Env {
	DB: D1DatabaseLike;
	USE_FIXTURE_CLIENT?: string;
	/** test-only: pin "today" so the run is reproducible (the real app uses pacificToday()) */
	FIXED_TODAY?: string;
	APP_SECRET?: string;
}

const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const SIX_HOURS = 6 * 3600_000;

/**
 * PORT of the site-selection half of schedulerTick (src/lib/server/jobs.ts): same SQL, same rules (backfill unfinished -> 'auto'
 * chunk, else incremental when the last sync is older than 6 h). The original enqueued every due site into an in-memory queue;
 * a Worker cannot keep that queue between invocations, so the cron handler does ONE bounded step and relies on the cursor
 * columns in D1 (synced_through / backfilled_to / backfill_done) to resume next time. In production the remaining due sites
 * would be fanned out to a Queue (one message per site-step) instead of looping here.
 */
export async function dueSites(db: D1Db, now = Date.now()) {
	const sites = await db.all<{ id: number; backfill_done: number; last_sync_at: number | null }>(
		`SELECT s.id, s.backfill_done, s.last_sync_at FROM sites s JOIN accounts a ON a.id = s.account_id
		 WHERE s.hidden = 0 AND a.status = 'active' AND s.permission NOT IN ('siteUnverifiedUser','none') ORDER BY s.id`
	);
	const due: { id: number; mode: 'auto' | 'incremental' }[] = [];
	for (const s of sites) {
		if (!s.backfill_done) due.push({ id: s.id, mode: 'auto' });
		else if (!s.last_sync_at || now - s.last_sync_at > SIX_HOURS) due.push({ id: s.id, mode: 'incremental' });
	}
	return due;
}

export async function scheduledStep(env: Env, ctx?: { waitUntil(p: Promise<unknown>): void }) {
	const db = new D1Db(env.DB);
	const today = env.FIXED_TODAY ?? pacificToday();
	if (env.USE_FIXTURE_CLIENT !== '1') throw new Error('proof only: real Google client not ported');
	const due = await dueSites(db);
	const started = Date.now();
	let outcome: Record<string, unknown> = { due: due.length, step: null };
	const next = due[0];
	if (next) {
		const res = await syncSite(db, next.id, { client: new FixtureClient({ today }), today, mode: next.mode, writeMode: 'jsonEach' });
		outcome = { due: due.length, step: { site: next.id, mode: next.mode, ...res }, ms: Date.now() - started, d1: db.stats };
	}
	await db.run("INSERT OR REPLACE INTO kv (key, value) VALUES ('last_scheduled', ?)", JSON.stringify(outcome));
	return outcome;
}

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		const url = new URL(req.url);
		const p = url.pathname;
		const db = new D1Db(env.DB);
		const num = (k: string, d: number) => Number(url.searchParams.get(k) ?? d);
		try {
			if (p === '/reset') return (await db.batch(RESET), json({ ok: true }));
			if (p === '/seed') return (await db.batch(SEED), json({ ok: true }));
			if (p === '/sync') {
				const today = url.searchParams.get('today')!;
				const t0 = Date.now();
				const res = await syncSite(db, num('site', 1), { client: new FixtureClient({ today, bigDayRows: url.searchParams.has('big') ? num('big', 26000) : undefined }), today, mode: (url.searchParams.get('mode') as 'auto' | 'incremental') ?? 'auto', backfillChunkDays: num('chunk', 45), writeMode: (url.searchParams.get('write') as 'perRow' | 'jsonEach') ?? 'perRow' });
				return json({ res, ms: Date.now() - t0, d1: db.stats });
			}
			if (p === '/dump') return json(await dump(db));
			if (p === '/state') {
				const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'last_scheduled'");
				return json(row ? JSON.parse(row.value) : null);
			}
			if (p === '/q') {
				const id = num('site', 1);
				const days = num('days', 28);
				const site = (await Q.allSites(db, { includeHidden: true })).find((s) => s.id === id)!;
				const per = Q.periodFor(site, days);
				const cost = async <T>(f: () => Promise<T>) => {
					const a = { ...db.stats };
					const result = await f();
					return { result, cost: { roundTrips: db.stats.roundTrips - a.roundTrips, statements: db.stats.statements - a.statements } };
				};
				const literal = await cost(() => Q.siteCards(db, days));
				const batched = await cost(() => Q.siteCardsBatched(db, days));
				return json({
					period: per,
					summary: await Q.summary(db, id, per.start, per.end),
					dailySeries: await Q.dailySeries(db, id, per.start, per.end),
					dailyUnfilled: await Q.dailySeries(db, id, per.start, per.end, false),
					typeBreakdown: await Q.typeBreakdown(db, id, per.start, per.end),
					topQueries: await Q.topQueries(db, id, per.start, per.end, {}, 50),
					topQueriesFiltered: await Q.topQueries(db, id, per.start, per.end, { country: 'usa', search: '50%' }, 50),
					topQueriesUnderscore: await Q.topQueries(db, id, per.start, per.end, { search: 'under_score' }, 50),
					queryPageRows: await Q.queryPageRows(db, id, per.start, per.end, 3, 200),
					anonymisedShare: await Q.anonymisedShare(db, id, per.start, per.end),
					siteCards: literal.result,
					siteCardsBatched: batched.result,
					cost: { siteCardsLiteral: literal.cost, siteCardsBatched: batched.cost, sites: literal.result.length }
				});
			}
			if (p === '/probe/rows-written') {
				// D1 bills rows written. What does D1's own accounting (meta.rows_written) say about sa_rows (WITHOUT ROWID + 2 indexes)?
				const rows = Array.from({ length: 1000 }, (_, i) => ({ keys: [`probe query ${i}`, `https://x.example/p/${i}`, 'usa', 'MOBILE'], clicks: 1, impressions: 2, ctr: 0.5, position: 3.5 }));
				const date = '2099-01-01';
				const step = async (label: string, stmts: { sql: string; args: (string | number | null)[] }[]) => {
					const res = await env.DB.batch(stmts.map((s) => env.DB.prepare(s.sql).bind(...s.args)));
					const m = res.reduce((a, r) => ({ changes: a.changes + (r.meta.changes ?? 0), rows_read: a.rows_read + ((r.meta as { rows_read?: number }).rows_read ?? 0), rows_written: a.rows_written + ((r.meta as { rows_written?: number }).rows_written ?? 0) }), { changes: 0, rows_read: 0, rows_written: 0 });
					return [label, m] as const;
				};
				const { bulkUpsertSaRows } = await import('./port/sync');
				const out = [
					await step('INSERT OR REPLACE 1000 new rows', bulkUpsertSaRows(1, date, rows)),
					await step('INSERT OR REPLACE the same 1000 rows again (all keys exist)', bulkUpsertSaRows(1, date, rows)),
					await step('DELETE those 1000 rows', [{ sql: 'DELETE FROM sa_rows WHERE site_id = 1 AND date = ?', args: [date] }])
				];
				return json(Object.fromEntries(out));
			}
			if (p === '/probe/limits') {
				// What does the LOCAL emulator (workerd + SQLite) enforce? Production documents: 100 bound params, 100 KB statement,
				// 2 MB string/row, 1000 (paid) / 50 (free) queries per invocation. The emulator is not authoritative for production.
				const out: Record<string, unknown> = {};
				const attempt = async (name: string, f: () => Promise<unknown>) => {
					try {
						out[name] = { ok: true, detail: await f() };
					} catch (e) {
						out[name] = { ok: false, error: String(e).slice(0, 220) };
					}
				};
				const binds = (n: number) => Array.from({ length: n }, () => 1);
				const valuesQuery = (n: number) => `WITH t(c) AS (VALUES ${binds(n).map(() => '(?)').join(',')}) SELECT count(*) AS n FROM t`;
				for (const n of [100, 101, 500]) await attempt(`bound_params_${n}`, async () => (await db.get<{ n: number }>(valuesQuery(n), ...binds(n)))!.n);
				await attempt('string_bind_1_5MB', async () => (await db.get<{ n: number }>('SELECT length(?) AS n', 'x'.repeat(1_500_000)))!.n);
				await attempt('string_bind_2_5MB', async () => (await db.get<{ n: number }>('SELECT length(?) AS n', 'x'.repeat(2_500_000)))!.n);
				await attempt('statement_120KB', async () => (await db.get(`SELECT ${'1,'.repeat(60_000)}1 AS last`)) && 'ran');
				await attempt('batch_30000_statements', async () => (await db.batch(Array.from({ length: 30_000 }, () => ({ sql: 'SELECT 1', args: [] })))).length);
				await attempt('sequential_queries_1100_in_one_invocation', async () => {
					for (let i = 0; i < 1100; i++) await db.get('SELECT 1');
					return 1100;
				});
				return json(out);
			}
			if (p === '/crypto/encrypt') {
				const b = (await req.json()) as { secret: string; plain: string };
				return json({ blob: await W.encrypt(b.secret, b.plain) });
			}
			if (p === '/crypto/decrypt') {
				const b = (await req.json()) as { secret: string; blob: string };
				try {
					return json({ ok: true, plain: await W.decrypt(b.secret, b.blob) });
				} catch (e) {
					return json({ ok: false, error: String(e) });
				}
			}
			if (p === '/crypto/sign') {
				const b = (await req.json()) as { secret: string; value: string };
				return json({ signed: await W.signValue(b.secret, b.value) });
			}
			if (p === '/crypto/verify') {
				const b = (await req.json()) as { secret: string; signed: string };
				return json({ value: await W.verifySigned(b.secret, b.signed) });
			}
			if (p === '/sitemap') {
				const buf = new Uint8Array(await req.arrayBuffer());
				const gz = buf[0] === 0x1f && buf[1] === 0x8b;
				try {
					const text = await sitemapText(buf, num('cap', 40_000_000));
					const parsed = parseSitemapXml(text);
					return json({ ok: true, gz, bytesIn: buf.length, chars: text.length, kind: parsed.kind, urls: parsed.entries.length, first: parsed.entries.slice(0, 2), last: parsed.entries.at(-1) });
				} catch (e) {
					return json({ ok: false, gz, error: String(e) });
				}
			}
			return json({ routes: ['/reset', '/seed', '/sync', '/dump', '/q', '/state', '/crypto/*', '/sitemap'] }, 404);
		} catch (e) {
			return json({ error: String(e), stack: (e as Error).stack }, 500);
		}
	},

	/** Cron Trigger entry point: one bounded, resumable step. */
	async scheduled(_controller: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
		ctx.waitUntil(scheduledStep(env, ctx));
	}
};

