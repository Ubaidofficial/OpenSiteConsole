/**
 * Original (better-sqlite3, the REAL modules from src/lib/server, untouched) vs. port (async Db, running in workerd on local D1).
 * Identical input from src/fixture.ts. Every check prints PASS/FAIL; the vitest run fails if any check fails.
 *
 *   cd spike/workers/proof && pnpm install --ignore-workspace && pnpm test
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';

// Must be set before the real crypto.ts derives its key.
process.env.APP_SECRET = 'spike-secret-0123456789abcdef';
const SECRET = process.env.APP_SECRET;

import { openDb } from '../../../../src/lib/server/db';
import { syncSite as origSync } from '../../../../src/lib/server/sync';
import * as OQ from '../../../../src/lib/server/queries';
import { encrypt as origEncrypt, decrypt as origDecrypt, signValue as origSign, verifySigned as origVerify } from '../../../../src/lib/server/crypto';
import { sitemapText as origSitemapText } from '../../../../src/lib/server/sitemapcov';
import { parseSitemapXml } from '../../../../src/lib/sitemap';
import { FixtureClient, FIXTURE_SITES } from '../src/fixture';
import { SEED } from '../src/seed';
import { dump } from '../src/dump';
import { syncSite as portSync } from '../src/port/sync';
import { SqliteDb } from './sqlite-db';
import { startWorker, type Running } from './harness';

const TODAY = '2026-03-31';
const SITE_IDS = FIXTURE_SITES.map((_, i) => i + 1);
const failures: string[] = [];
const report = (ok: boolean, what: string, extra = '') => {
	if (!ok) failures.push(what);
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}${extra ? '  ' + extra : ''}`);
};
const info = (s: string) => console.log(`INFO  ${s}`);
/** `it` that also records exceptions as failures and fails if any report() inside it failed. */
function t(name: string, fn: () => Promise<void> | void, timeout?: number) {
	it(
		name,
		async () => {
			const before = failures.length;
			try {
				await fn();
			} catch (e) {
				failures.push(`${name}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
				console.log(`FAIL  ${name}  (exception) ${String((e as Error)?.message ?? e).slice(0, 200)}`);
				throw e;
			}
			if (failures.length > before) throw new Error(`${failures.length - before} check(s) failed in: ${name}`);
		},
		timeout
	);
}
/** JSON round trip with object keys sorted, so comparisons ignore key order (arrays keep their order). */
const canon = (x: any): any => (Array.isArray(x) ? x.map(canon) : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, canon(x[k])])) : x);
const norm = (x: unknown) => canon(JSON.parse(JSON.stringify(x)));
/** First path where two JSON values differ, for readable FAIL lines. */
function jdiff(a: any, b: any, path = '$'): string | null {
	a = canon(a);
	b = canon(b);
	if (JSON.stringify(a) === JSON.stringify(b)) return null;
	if (a && b && typeof a === 'object' && typeof b === 'object') {
		for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
			const d = jdiff(a[k], b[k], `${path}.${k}`);
			if (d) return d;
		}
	}
	return `${path}: ${JSON.stringify(a)?.slice(0, 80)} vs ${JSON.stringify(b)?.slice(0, 80)}`;
}

/** Compare two arrays of rows; return the first difference (or null). */
function firstDiff(a: unknown[], b: unknown[]): string | null {
	if (a.length !== b.length) return `row count ${a.length} vs ${b.length}`;
	for (let i = 0; i < a.length; i++) if (JSON.stringify(canon(a[i])) !== JSON.stringify(canon(b[i]))) return `row ${i}: ${JSON.stringify(a[i])} vs ${JSON.stringify(b[i])}`;
	return null;
}
function compareDumps(label: string, a: Record<string, unknown[]>, b: Record<string, unknown[]>) {
	for (const t of Object.keys(a)) {
		const d = firstDiff(a[t], b[t]);
		report(d === null, `${label} :: ${t}`, d ?? `${a[t].length} rows identical`);
	}
}

/** The original, untouched: real syncSite on real better-sqlite3. */
async function runOriginal() {
	const d = openDb(':memory:');
	globalThis.__openSiteConsoleDb = d;
	for (const s of SEED) d.prepare(s.sql).run(...s.args);
	const steps: unknown[] = [];
	for (const id of SITE_IDS) {
		for (let guard = 0; guard < 40; guard++) {
			const r = await origSync(id, { client: new FixtureClient({ today: TODAY }), today: TODAY, mode: 'auto', backfillChunkDays: 45 });
			steps.push({ site: id, ...r });
			if (r.backfillDone) break;
		}
	}
	return { d, steps, dump: norm(await dump(new SqliteDb(d))) };
}

let w: Running;
let orig: Awaited<ReturnType<typeof runOriginal>>;

beforeAll(async () => {
	orig = await runOriginal();
	w = await startWorker({ today: TODAY });
}, 180_000);
afterAll(async () => {
	await w?.stop();
	console.log(failures.length ? `\nRESULT: FAIL (${failures.length} failed): ${failures.join('; ')}` : '\nRESULT: ALL CHECKS PASSED');
});

async function runWorkerLoop(write: 'perRow' | 'jsonEach') {
	await w.post('/reset');
	await w.post('/seed');
	const steps: unknown[] = [];
	const cost = { ms: 0, roundTrips: 0, statements: 0 };
	for (const id of SITE_IDS) {
		for (let guard = 0; guard < 40; guard++) {
			const r = await w.post(`/sync?site=${id}&mode=auto&chunk=45&today=${TODAY}&write=${write}`);
			if (!r.res) throw new Error('worker /sync failed: ' + JSON.stringify(r).slice(0, 500));
			steps.push({ site: id, ...r.res });
			cost.ms += r.ms;
			cost.roundTrips += r.d1.roundTrips;
			cost.statements += r.d1.statements;
			if (r.res.backfillDone) break;
		}
	}
	return { steps, cost, dump: await w.get('/dump') };
}

describe('sync: original (better-sqlite3) vs port (D1 in workerd)', () => {
	t('original ran to completion on every site', () => {
		const last = (orig.dump as { sites: { backfill_done: number }[] }).sites;
		report(last.every((s) => s.backfill_done === 1), 'original: all 3 sites backfilled to the retention horizon', `${orig.steps.length} sync steps`);
		const n = (orig.dump as { sa_rows: unknown[] }).sa_rows.length;
		info(`original produced ${n} sa_rows (includes two 26,000-row days, so paging past the 25,000-row API page ran)`);
		expect(n).toBeGreaterThan(50_000);
	});

	for (const write of ['jsonEach', 'perRow'] as const) {
		t(`port on D1, writeMode=${write}: identical tables and identical per-step results`, async () => {
			const p = await runWorkerLoop(write);
			report(JSON.stringify(p.steps) === JSON.stringify(orig.steps), `D1[${write}] per-step SyncResult sequence equals original`, `${p.steps.length} steps`);
			compareDumps(`D1[${write}]`, p.dump, orig.dump as never);
			info(`D1[${write}] full 3-site backfill: ${p.cost.roundTrips} D1 round trips, ${p.cost.statements} statements, ${p.cost.ms} ms inside the Worker (local emulator, NOT a latency benchmark)`);
		}, 300_000);
	}

	t('port on better-sqlite3 (same async code, original engine) is also identical: isolates D1-specific differences', async () => {
		for (const write of ['jsonEach', 'perRow'] as const) {
			const d = openDb(':memory:');
			for (const s of SEED) d.prepare(s.sql).run(...s.args);
			const db = new SqliteDb(d);
			const steps: unknown[] = [];
			for (const id of SITE_IDS) for (let g = 0; g < 40; g++) {
				const r = await portSync(db, id, { client: new FixtureClient({ today: TODAY }), today: TODAY, mode: 'auto', backfillChunkDays: 45, writeMode: write });
				steps.push({ site: id, ...r });
				if (r.backfillDone) break;
			}
			report(JSON.stringify(steps) === JSON.stringify(orig.steps), `port-on-sqlite[${write}] per-step results equal original`);
			compareDumps(`port-on-sqlite[${write}]`, norm(await dump(db)), orig.dump as never);
		}
	}, 300_000);
});

describe('reads: ported queries.ts slice vs original', () => {
	t('summary / dailySeries / typeBreakdown / topQueries / queryPageRows / anonymisedShare / siteCards', async () => {
		// the worker still holds the last D1 run (perRow) -> same data as the original
		globalThis.__openSiteConsoleDb = orig.d;
		let literalCost = 0;
		for (const id of SITE_IDS) {
			for (const days of [7, 28, 90]) {
				const r = await w.get(`/q?site=${id}&days=${days}`);
				const site = OQ.allSites({ includeHidden: true }).find((s) => s.id === id)!;
				const per = OQ.periodFor(site, days);
				const exp = {
					period: per,
					summary: OQ.summary(id, per.start, per.end),
					dailySeries: OQ.dailySeries(id, per.start, per.end),
					dailyUnfilled: OQ.dailySeries(id, per.start, per.end, false),
					typeBreakdown: OQ.typeBreakdown(id, per.start, per.end),
					topQueries: OQ.topQueries(id, per.start, per.end, {}, 50),
					topQueriesFiltered: OQ.topQueries(id, per.start, per.end, { country: 'usa', search: '50%' }, 50),
					topQueriesUnderscore: OQ.topQueries(id, per.start, per.end, { search: 'under_score' }, 50),
					queryPageRows: OQ.queryPageRows(id, per.start, per.end, 3, 200),
					anonymisedShare: OQ.anonymisedShare(id, per.start, per.end)
				};
				for (const k of Object.keys(exp) as (keyof typeof exp)[]) {
					const same = jdiff(norm(exp[k]), r[k]) === null;
					report(same, `read site=${id} days=${days} :: ${k}`);
				}
				const cards = OQ.siteCards(days).map((c) => ({ siteId: c.site.id, coveredBy: c.coveredBy, comparable: c.comparable, now: c.now, prev: c.prev, spark: c.spark, period: c.period }));
				report(jdiff(norm(cards), r.siteCards) === null, `read days=${days} :: siteCards (literal port, ${r.cost.siteCardsLiteral.roundTrips} D1 round trips)`, jdiff(norm(cards), r.siteCards) ?? '');
				report(jdiff(norm(cards), r.siteCardsBatched) === null, `read days=${days} :: siteCards (batched rewrite, ${r.cost.siteCardsBatched.roundTrips} D1 round trip)`, jdiff(norm(cards), r.siteCardsBatched) ?? '');
				literalCost = r.cost.siteCardsLiteral.roundTrips;
				if (id === 1 && days === 28) {
					info(`topQueries sample: ${JSON.stringify(r.topQueries.slice(0, 2))}`);
					info(`LIKE search for '50%' returned ${r.topQueriesFiltered.length} rows; for 'under_score' ${r.topQueriesUnderscore.length} rows (both engines agree: wildcards behave identically)`);
				}
			}
		}
		info(`dashboard siteCards for ${SITE_IDS.length} sites: literal port = ${literalCost} sequential D1 round trips (3N+1); batched = 2 (sites list + one batch)`);
	}, 120_000);
});

describe('scheduled(): one resumable step per Cron invocation', () => {
	t('repeated cron invocations walk every site to the same end state as the original loop', async () => {
		await w.post('/reset');
		await w.post('/seed');
		const log: any[] = [];
		for (let i = 0; i < 80; i++) {
			const r = await w.raw(`/__scheduled?cron=*%2F15+*+*+*+*`, {});
			void r;
			let state = await w.get('/state');
			// the handler hands the work to ctx.waitUntil; wait until this invocation's outcome is written
			for (let t = 0; t < 100 && (state === null || log.length && JSON.stringify(state) === JSON.stringify(log.at(-1))); t++) {
				await new Promise((r) => setTimeout(r, 100));
				state = await w.get('/state');
				if (state && state.step === null) break;
			}
			log.push(state);
			if (state && state.step === null) break;
		}
		const steps = log.filter((s) => s?.step).map((s) => ({ site: s.step.site, days: s.step.days, rows: s.step.rows, truncatedDays: s.step.truncatedDays, backfillDone: s.step.backfillDone }));
		const expected = (orig.steps as any[]).map((s) => ({ site: s.site, days: s.days, rows: s.rows, truncatedDays: s.truncatedDays, backfillDone: s.backfillDone }));
		report(JSON.stringify(steps) === JSON.stringify(expected), `scheduled(): step sequence equals original loop`, `${steps.length} cron invocations until nothing was due`);
		report(log.at(-1)?.step === null, 'scheduled(): ends with "nothing due" (cursors persisted in D1 between invocations)');
		compareDumps('scheduled()', await w.get('/dump'), orig.dump as never);
		const maxMs = Math.max(...log.filter((s) => s?.ms).map((s) => s.ms));
		info(`slowest single cron step: ${maxMs} ms wall in the local emulator; D1 stats of that step type: ${JSON.stringify(log.find((s) => s?.step?.rows > 20000)?.d1)}`);
	}, 300_000);
});

describe('AES-256-GCM / HMAC: WebCrypto port is wire-compatible with node:crypto crypto.ts', () => {
	// Generated once with the algorithm in src/lib/server/crypto.ts and APP_SECRET='spike-secret-0123456789abcdef'.
	const KNOWN = 'v1:n6LTKVWwxHEaMJKX:H4vFgyfachxlRlvPYD4Duw==:g9144xLuE+LVRIxjc62XV/ftSF+wapmMg43yMif8LZvw';
	const KNOWN_PLAIN = '1//0g-refresh-token-ünïcode-✓';
	const KNOWN_SIG = 'value._Ab82vFHuZXBPU_qhBQALoBbiCw0aWTHmBvN6O3BuLs';

	t('a stored ciphertext (known-answer vector) decrypts in the real crypto.ts AND in workerd WebCrypto', async () => {
		report(origDecrypt(KNOWN) === KNOWN_PLAIN, 'known-answer vector decrypts with the real crypto.ts (validates the vector itself)');
		const r = await w.post('/crypto/decrypt', { secret: SECRET, blob: KNOWN });
		report(r.ok && r.plain === KNOWN_PLAIN, 'known-answer vector decrypts in workerd via WebCrypto', JSON.stringify(r).slice(0, 80));
		const s = await w.post('/crypto/verify', { secret: SECRET, signed: KNOWN_SIG });
		report(s.value === 'value' && origVerify(KNOWN_SIG) === 'value', 'known HMAC session signature verifies in both');
	});

	t('round trips in both directions for 200 random strings (unicode, long, short)', async () => {
		let n = 0;
		let bad = 0;
		for (let i = 0; i < 200; i++) {
			const plain = i % 3 === 0 ? randomBytes(1 + (i % 50)).toString('base64') : i % 3 === 1 ? 'ünï-' + '✓🔥'.repeat(i % 40) + `-${i}` : JSON.stringify({ access_token: randomBytes(40).toString('hex'), i });
			const viaWeb = await w.post('/crypto/encrypt', { secret: SECRET, plain });
			if (origDecrypt(viaWeb.blob) !== plain) bad++; // workerd encrypts -> node decrypts
			const dec = await w.post('/crypto/decrypt', { secret: SECRET, blob: origEncrypt(plain) });
			if (!dec.ok || dec.plain !== plain) bad++; // node encrypts -> workerd decrypts
			const signedNode = origSign(plain);
			const v = await w.post('/crypto/verify', { secret: SECRET, signed: signedNode });
			if (v.value !== plain) bad++;
			const signedWeb = await w.post('/crypto/sign', { secret: SECRET, value: plain });
			if (origVerify(signedWeb.signed) !== plain) bad++;
			n += 4;
		}
		report(bad === 0, `${n} cross-engine operations (encrypt/decrypt/sign/verify both ways)`, `${bad} mismatches`);
	}, 120_000);

	t('tampering and wrong secrets are rejected on both sides', async () => {
		const blob = origEncrypt('secret-value');
		const tampered = blob.slice(0, -4) + 'AAAA';
		const r1 = await w.post('/crypto/decrypt', { secret: SECRET, blob: tampered });
		let nodeRejects = false;
		try { origDecrypt(tampered); } catch { nodeRejects = true; }
		report(!r1.ok && nodeRejects, 'tampered ciphertext rejected by both');
		const r2 = await w.post('/crypto/decrypt', { secret: 'a-different-secret-0123456789', blob });
		report(!r2.ok, 'wrong secret rejected by WebCrypto');
		const v = await w.post('/crypto/verify', { secret: SECRET, signed: origSign('abc').slice(0, -2) + 'xx' });
		report(v.value === null && origVerify(origSign('abc').slice(0, -2) + 'xx') === null, 'forged signature rejected by both');
	});
});

describe('gunzip: node:zlib gunzipSync vs DecompressionStream in workerd', () => {
	const urlset = (n: number) =>
		`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
		Array.from({ length: n }, (_, i) => `<url><loc>https://greenleaf.example/p/${i}?a=1&amp;b=${i}</loc>${i % 2 ? `<lastmod>2026-03-${String(1 + (i % 28)).padStart(2, '0')}</lastmod>` : ''}</url>`).join('') +
		`<url><loc><![CDATA[https://greenleaf.example/café/日本語]]></loc></url></urlset>`;
	const post = (body: Buffer, q = '') => w.raw('/sitemap' + q, { method: 'POST', body, headers: { 'content-type': 'application/octet-stream' } });

	t('a gzipped sitemap yields the same URLs as the original sitemapText + parseSitemapXml', async () => {
		for (const n of [3, 50_000]) {
			const xml = urlset(n);
			const gz = gzipSync(Buffer.from(xml));
			const exp = parseSitemapXml(origSitemapText(gz));
			const r = await post(gz);
			const same = r.ok && r.gz && r.urls === exp.entries.length && JSON.stringify(r.first) === JSON.stringify(exp.entries.slice(0, 2)) && JSON.stringify(r.last) === JSON.stringify(exp.entries.at(-1));
			report(same, `gzipped sitemap with ${n + 1} URLs`, `${gz.length} gz bytes -> ${r.chars} chars, ${r.urls} URLs (original: ${exp.entries.length})`);
		}
		const plain = Buffer.from(urlset(5));
		const r = await post(plain);
		report(r.ok && !r.gz && r.urls === parseSitemapXml(origSitemapText(plain)).entries.length, 'plain (non-gzip) sitemap passes through unchanged');
	}, 120_000);

	t('zip-bomb cap and damaged archives fail on both sides', async () => {
		const bomb = gzipSync(Buffer.alloc(45_000_000, 0)); // 45 MB of zeros, ~45 KB gzipped; the cap is 40 MB
		let nodeThrows = false;
		try { origSitemapText(bomb); } catch { nodeThrows = true; }
		const r = await post(bomb);
		report(nodeThrows && r.ok === false && /exceeds cap/.test(r.error), 'decompression bomb above the 40 MB cap rejected by both', `${bomb.length} bytes gz`);
		const good = gzipSync(Buffer.from(urlset(2000)));
		const bad = Buffer.from(good);
		for (let i = 40; i < 60; i++) bad[i] ^= 0xff;
		let nodeBad = false;
		try { origSitemapText(bad); } catch { nodeBad = true; }
		const rb = await post(bad);
		report(nodeBad && rb.ok === false, 'damaged gzip rejected by both');
	}, 120_000);
});

describe('what the local D1 emulator enforces (informational; production limits are in the Cloudflare docs)', () => {
	t('probes', async () => {
		const r = await w.get('/probe/limits');
		for (const [k, v] of Object.entries(r as Record<string, { ok: boolean; detail?: unknown; error?: string }>)) info(`limits probe ${k}: ${v.ok ? 'accepted ' + JSON.stringify(v.detail) : 'REFUSED ' + v.error}`);
		report(r.bound_params_100.ok && !r.bound_params_101.ok, 'emulator enforces the documented 100-bound-parameter limit (100 ok, 101 refused)');
	});
});
