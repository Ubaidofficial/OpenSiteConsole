/**
 * PORT of src/lib/server/sync.ts to the async `Db` interface.
 *
 * Deliberately a line-for-line port: same control flow, same SQL, same cursor logic, so a diff against the original shows
 * exactly what changes (every `db().prepare(..).run(..)` becomes `await db.run(..)`, and each `d.transaction(() => {..})()`
 * becomes one `db.batch([..])`). The only decisions that are NOT mechanical are marked  // PORT:  below.
 *
 * Pure helpers (dates, search types, periods) are imported straight from the real src/lib: they bundle for workerd unchanged.
 */
import type { Db, Stmt } from '../db';
import { q } from '../db';
import type { GscClient, SearchRow } from '../../../../../src/lib/server/google';
import type { SiteRow } from '../../../../../src/lib/server/clients';
import { addDays, pacificToday, retentionHorizon } from '../../../../../src/lib/server/dates';
import { SEARCH_TYPES } from '../../../../../src/lib/searchTypes';
import { PERIODS } from '../../../../../src/lib/periods';

const PAGE = 25_000;
const OVERLAP_DAYS = 3;
const BACKFILL_CHUNK_DAYS = 45;

export interface SyncResult {
	days: number;
	rows: number;
	truncatedDays: number;
	backfillDone: boolean;
}

export interface SyncOptions {
	client: GscClient;
	today?: string;
	backfillChunkDays?: number;
	mode?: 'incremental' | 'auto';
	/** PORT: config.maxRowsPerDay came from process.env via config.ts; on Workers it is a binding, so it is passed in. */
	maxRowsPerDay?: number;
	/** PORT: how sa_rows are written. 'perRow' = one INSERT statement per row (the literal translation); 'jsonEach' = see bulkUpsertSaRows. */
	writeMode?: 'perRow' | 'jsonEach';
}

export async function getSite(db: Db, id: number): Promise<SiteRow | undefined> {
	return db.get<SiteRow>('SELECT * FROM sites WHERE id = ?', id);
}

async function setStatus(db: Db, siteId: number, status: string, message: string | null) {
	await db.run('UPDATE sites SET sync_status = ?, sync_message = ? WHERE id = ?', status, message, siteId);
}

async function fetchDayDetail(client: GscClient, siteUrl: string, date: string, maxRowsPerDay: number): Promise<{ rows: SearchRow[]; truncated: boolean }> {
	const rows: SearchRow[] = [];
	for (let startRow = 0; ; startRow += PAGE) {
		const page = await client.query(siteUrl, { startDate: date, endDate: date, dimensions: ['query', 'page', 'country', 'device'], rowLimit: PAGE, startRow, dataState: 'all' });
		rows.push(...page);
		if (page.length < PAGE) return { rows, truncated: false };
		if (rows.length >= maxRowsPerDay) return { rows, truncated: true };
	}
}

const SA_COLS = '(site_id, date, query, page, country, device, clicks, impressions, position)';

/**
 * PORT: the literal translation: INSERT OR REPLACE one statement per row. D1 allows at most 100 bound parameters per
 * statement, so a multi-row VALUES list is capped at 11 rows of this 9-column table: one statement per row is the
 * straightforward shape.
 */
export function perRowUpserts(siteId: number, date: string, rows: SearchRow[]): Stmt[] {
	return rows.map((r) => q(`INSERT OR REPLACE INTO sa_rows ${SA_COLS} VALUES (?,?,?,?,?,?,?,?,?)`, siteId, date, r.keys[0], r.keys[1], r.keys[2], r.keys[3], r.clicks, r.impressions, r.position));
}

/**
 * PORT: bulk alternative that gets around the 100-parameter cap: rows travel as ONE bound JSON string and are unpacked
 * in SQL with json_each (D1 documents JSON-extension support). D1 caps a bound string/row at 2,000,000 bytes, so rows are
 * packed into chunks of at most `maxBytes` of JSON. Statement order inside the enclosing batch() is preserved, and
 * json_each yields array elements in order, so INSERT OR REPLACE keeps "last row wins" semantics for duplicate keys.
 */
export function bulkUpsertSaRows(siteId: number, date: string, rows: SearchRow[], maxBytes = 1_500_000): Stmt[] {
	const stmts: Stmt[] = [];
	let chunk: unknown[][] = [];
	let size = 2;
	const flush = () => {
		if (!chunk.length) return;
		stmts.push(
			q(
				`INSERT OR REPLACE INTO sa_rows ${SA_COLS}
				 SELECT ?, ?, json_extract(value,'$[0]'), json_extract(value,'$[1]'), json_extract(value,'$[2]'), json_extract(value,'$[3]'), json_extract(value,'$[4]'), json_extract(value,'$[5]'), json_extract(value,'$[6]')
				 FROM json_each(?)`,
				siteId,
				date,
				JSON.stringify(chunk)
			)
		);
		chunk = [];
		size = 2;
	};
	for (const r of rows) {
		const item = [r.keys[0], r.keys[1], r.keys[2], r.keys[3], r.clicks, r.impressions, r.position];
		const bytes = JSON.stringify(item).length * 3; // worst case UTF-8 bytes per UTF-16 code unit
		if (size + bytes > maxBytes) flush();
		chunk.push(item);
		size += bytes + 1;
	}
	flush();
	return stmts;
}

/** Original: DELETE + N inserts inside one better-sqlite3 transaction. Port: the same list as one atomic batch(). */
export async function storeDay(db: Db, siteId: number, date: string, rows: SearchRow[], writeMode: 'perRow' | 'jsonEach' = 'perRow') {
	const writes = writeMode === 'perRow' ? perRowUpserts(siteId, date, rows) : bulkUpsertSaRows(siteId, date, rows);
	await db.batch([q('DELETE FROM sa_rows WHERE site_id = ? AND date = ?', siteId, date), ...writes]);
}

async function pullTotals(db: Db, client: GscClient, siteId: number, siteUrl: string, start: string, end: string): Promise<string[]> {
	const rows = await client.query(siteUrl, { startDate: start, endDate: end, dimensions: ['date'], rowLimit: PAGE, dataState: 'all' });
	await db.batch(rows.map((r) => q('INSERT OR REPLACE INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)', siteId, r.keys[0], r.clicks, r.impressions, r.position)));
	return rows.map((r) => r.keys[0]).sort();
}

export async function pullTypeTotals(db: Db, client: GscClient, siteId: number, siteUrl: string, start: string, end: string): Promise<{ stored: number; failed: string[] }> {
	const web = new Map(
		(await db.all<{ date: string; clicks: number; impressions: number }>('SELECT date, clicks, impressions FROM site_daily WHERE site_id = ? AND date BETWEEN ? AND ?', siteId, start, end)).map((r) => [r.date, r])
	);
	let stored = 0;
	const failed: string[] = [];
	for (const type of SEARCH_TYPES) {
		let rows: SearchRow[];
		try {
			rows = await client.query(siteUrl, { startDate: start, endDate: end, dimensions: ['date'], rowLimit: PAGE, dataState: 'all', type });
		} catch {
			failed.push(type);
			continue;
		}
		const comparable = rows.filter((r) => {
			const w = web.get(r.keys[0]);
			return w && (w.clicks > 0 || w.impressions > 0);
		});
		const same = comparable.filter((r) => {
			const w = web.get(r.keys[0])!;
			return w.clicks === r.clicks && w.impressions === r.impressions;
		}).length;
		if (comparable.length >= 3 && same === comparable.length) {
			failed.push(type);
			continue;
		}
		await db.batch([
			q('DELETE FROM site_daily_type WHERE site_id = ? AND search_type = ? AND date BETWEEN ? AND ?', siteId, type, start, end),
			...rows.map((r) => q('INSERT OR REPLACE INTO site_daily_type (site_id, search_type, date, clicks, impressions, position) VALUES (?,?,?,?,?,?)', siteId, type, r.keys[0], r.clicks, r.impressions, r.position))
		]);
		stored += rows.length;
	}
	return { stored, failed };
}

export async function pullAppearance(db: Db, client: GscClient, siteId: number, siteUrl: string, today: string): Promise<number> {
	const done = await db.get('SELECT 1 FROM sites WHERE id = ? AND appearance_pulled_on = ?', siteId, today);
	if (done) return 0;
	const horizon = retentionHorizon(today);
	let n = 0;
	for (const days of PERIODS) {
		let start = addDays(today, -(days - 1));
		if (start < horizon) start = horizon;
		let rows: SearchRow[];
		try {
			rows = await client.query(siteUrl, { startDate: start, endDate: today, dimensions: ['searchAppearance'], rowLimit: 100, dataState: 'all' });
		} catch {
			return n;
		}
		await db.batch([
			q('DELETE FROM site_appearance WHERE site_id = ? AND days = ?', siteId, days),
			...rows.map((r) => q('INSERT OR REPLACE INTO site_appearance (site_id, days, appearance, pulled_on, clicks, impressions, position) VALUES (?,?,?,?,?,?,?)', siteId, days, r.keys[0], today, r.clicks, r.impressions, r.position))
		]);
		n += rows.length;
	}
	await db.run('UPDATE sites SET appearance_pulled_on = ? WHERE id = ?', today, siteId);
	return n;
}

/** One resumable step: recent window + at most one backfill chunk. Identical contract to the original syncSite. */
export async function syncSite(db: Db, siteId: number, opts: SyncOptions): Promise<SyncResult> {
	const { client } = opts;
	let site = await getSite(db, siteId);
	if (!site) throw new Error(`Unknown site ${siteId}`);
	const today = opts.today ?? pacificToday();
	const horizon = retentionHorizon(today);
	const writeMode = opts.writeMode ?? 'perRow';
	const maxRows = opts.maxRowsPerDay ?? 100_000;
	// PORT: `.lastInsertRowid` was read synchronously off the RunResult; D1 returns it as meta.last_row_id on the awaited result.
	const run = await db.run('INSERT INTO sync_runs (site_id, mode, started_at) VALUES (?,?,?)', siteId, opts.mode ?? 'auto', Date.now());
	const runId = Number(run.lastInsertRowid);
	const res: SyncResult = { days: 0, rows: 0, truncatedDays: 0, backfillDone: !!site.backfill_done };
	const progress = (m: string) => setStatus(db, siteId, 'running', m);

	const pullDays = async (dates: string[]) => {
		for (const date of dates) {
			await progress(`Pulling ${date}`);
			const { rows, truncated } = await fetchDayDetail(client, site!.site_url, date, maxRows);
			await storeDay(db, siteId, date, rows, writeMode);
			res.days++;
			res.rows += rows.length;
			if (truncated) res.truncatedDays++;
		}
	};

	try {
		await setStatus(db, siteId, 'running', 'Starting');

		let start = site.synced_through ? addDays(site.synced_through, -OVERLAP_DAYS) : addDays(today, -7);
		if (start < horizon) start = horizon;
		const recent = await pullTotals(db, client, siteId, site.site_url, start, today);
		await pullDays(recent);
		if (recent.length) {
			const newest = recent[recent.length - 1];
			await db.run('UPDATE sites SET synced_through = MAX(COALESCE(synced_through, ?), ?) WHERE id = ?', newest, newest, siteId);
		}
		await db.run('UPDATE sites SET backfilled_to = CASE WHEN backfilled_to IS NULL OR backfilled_to > ? THEN ? ELSE backfilled_to END WHERE id = ?', start, start, siteId);

		try {
			const first = !(await db.get<{ types_synced_at: number | null }>('SELECT types_synced_at FROM sites WHERE id = ?', siteId))!.types_synced_at;
			const typesFrom = first ? horizon : start;
			const t = await pullTypeTotals(db, client, siteId, site.site_url, typesFrom, today);
			if (first && !t.failed.length) await db.run('UPDATE sites SET types_synced_at = ? WHERE id = ?', Date.now(), siteId);
			await pullAppearance(db, client, siteId, site.site_url, today);
		} catch {
			/* ignored on purpose, as in the original */
		}

		site = (await getSite(db, siteId))!;
		if ((opts.mode ?? 'auto') === 'auto' && !site.backfill_done && site.backfilled_to) {
			const chunk = opts.backfillChunkDays ?? BACKFILL_CHUNK_DAYS;
			const end = addDays(site.backfilled_to, -1);
			let from = addDays(end, -(chunk - 1));
			if (from < horizon) from = horizon;
			if (end < horizon) {
				await db.run('UPDATE sites SET backfill_done = 1 WHERE id = ?', siteId);
				res.backfillDone = true;
			} else {
				await progress(`Backfilling ${from} → ${end}`);
				const dates = await pullTotals(db, client, siteId, site.site_url, from, end);
				await pullDays(dates);
				const reachedHorizon = from <= horizon;
				await db.run('UPDATE sites SET backfilled_to = ?, backfill_done = ? WHERE id = ?', from, reachedHorizon ? 1 : 0, siteId);
				res.backfillDone = reachedHorizon;
			}
		}

		await db.run("UPDATE sites SET last_sync_at = ?, sync_status = 'idle', sync_message = ? WHERE id = ?", Date.now(), res.truncatedDays ? `${res.truncatedDays} day(s) hit the per-day row cap` : null, siteId);
		await db.run('UPDATE sync_runs SET finished_at = ?, days = ?, rows = ?, truncated_days = ? WHERE id = ?', Date.now(), res.days, res.rows, res.truncatedDays, runId);
		return res;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		await setStatus(db, siteId, 'error', msg);
		await db.run('UPDATE sync_runs SET finished_at = ?, days = ?, rows = ?, error = ? WHERE id = ?', Date.now(), res.days, res.rows, msg, runId);
		throw e;
	}
}
