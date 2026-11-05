import { db } from './db';
import { clientForSite, type SiteRow } from './clients';
import type { GscClient, SearchRow } from './google';
import { addDays, pacificToday, retentionHorizon } from './dates';
import { config } from './config';

const PAGE = 25_000;
const OVERLAP_DAYS = 3; // re-pull the newest days: fresh data is revised for a few days
const BACKFILL_CHUNK_DAYS = 45;

export interface SyncResult {
	days: number;
	rows: number;
	truncatedDays: number;
	backfillDone: boolean;
}

export interface SyncOptions {
	client?: GscClient;
	today?: string;
	/** Days of history to backfill in one run. Further runs continue where this stopped. */
	backfillChunkDays?: number;
	/** incremental: only recent days. auto: recent days + one backfill chunk if history is incomplete. */
	mode?: 'incremental' | 'auto';
	onProgress?: (msg: string) => void;
}

function setStatus(siteId: number, status: string, message: string | null) {
	db().prepare('UPDATE sites SET sync_status = ?, sync_message = ? WHERE id = ?').run(status, message, siteId);
}

async function fetchDayDetail(client: GscClient, siteUrl: string, date: string): Promise<{ rows: SearchRow[]; truncated: boolean }> {
	const rows: SearchRow[] = [];
	for (let startRow = 0; ; startRow += PAGE) {
		const page = await client.query(siteUrl, {
			startDate: date,
			endDate: date,
			dimensions: ['query', 'page', 'country', 'device'],
			rowLimit: PAGE,
			startRow,
			dataState: 'all'
		});
		rows.push(...page);
		if (page.length < PAGE) return { rows, truncated: false };
		if (rows.length >= config.maxRowsPerDay) return { rows, truncated: true };
	}
}

function storeDay(siteId: number, date: string, rows: SearchRow[]) {
	const d = db();
	const ins = d.prepare('INSERT OR REPLACE INTO sa_rows (site_id, date, query, page, country, device, clicks, impressions, position) VALUES (?,?,?,?,?,?,?,?,?)');
	d.transaction(() => {
		d.prepare('DELETE FROM sa_rows WHERE site_id = ? AND date = ?').run(siteId, date);
		for (const r of rows) ins.run(siteId, date, r.keys[0], r.keys[1], r.keys[2], r.keys[3], r.clicks, r.impressions, r.position);
	})();
}

/** Totals per day for a range, in one request. Returns the dates that have data. */
async function pullTotals(client: GscClient, siteId: number, siteUrl: string, start: string, end: string): Promise<string[]> {
	const rows = await client.query(siteUrl, { startDate: start, endDate: end, dimensions: ['date'], rowLimit: PAGE, dataState: 'all' });
	const ins = db().prepare('INSERT OR REPLACE INTO site_daily (site_id, date, clicks, impressions, position) VALUES (?,?,?,?,?)');
	db().transaction(() => {
		for (const r of rows) ins.run(siteId, r.keys[0], r.clicks, r.impressions, r.position);
	})();
	return rows.map((r) => r.keys[0]).sort();
}

export async function syncSite(siteId: number, opts: SyncOptions = {}): Promise<SyncResult> {
	const resolved = opts.client ? { client: opts.client, site: clientForSite(siteId).site } : clientForSite(siteId);
	const { client } = resolved;
	let site: SiteRow = resolved.site;
	const today = opts.today ?? pacificToday();
	const horizon = retentionHorizon(today);
	const d = db();
	const run = d.prepare('INSERT INTO sync_runs (site_id, mode, started_at) VALUES (?,?,?)').run(siteId, opts.mode ?? 'auto', Date.now());
	const runId = Number(run.lastInsertRowid);
	const res: SyncResult = { days: 0, rows: 0, truncatedDays: 0, backfillDone: !!site.backfill_done };
	const progress = (m: string) => {
		setStatus(siteId, 'running', m);
		opts.onProgress?.(m);
	};

	const pullDays = async (dates: string[]) => {
		for (const date of dates) {
			progress(`Pulling ${date}`);
			const { rows, truncated } = await fetchDayDetail(client, site.site_url, date);
			storeDay(siteId, date, rows);
			res.days++;
			res.rows += rows.length;
			if (truncated) res.truncatedDays++;
		}
	};

	try {
		setStatus(siteId, 'running', 'Starting');

		// 1. Recent window (always)
		let start = site.synced_through ? addDays(site.synced_through, -OVERLAP_DAYS) : addDays(today, -7);
		if (start < horizon) start = horizon;
		const recent = await pullTotals(client, siteId, site.site_url, start, today);
		await pullDays(recent);
		if (recent.length) {
			const newest = recent[recent.length - 1];
			const oldest = recent[0];
			d.prepare('UPDATE sites SET synced_through = MAX(COALESCE(synced_through, ?), ?), backfilled_to = COALESCE(MIN(backfilled_to, ?), ?) WHERE id = ?').run(
				newest,
				newest,
				oldest,
				oldest,
				siteId
			);
		}

		// 2. One backfill chunk towards the retention horizon
		site = clientForSite(siteId).site;
		if ((opts.mode ?? 'auto') === 'auto' && !site.backfill_done && site.backfilled_to) {
			const chunk = opts.backfillChunkDays ?? BACKFILL_CHUNK_DAYS;
			const end = addDays(site.backfilled_to, -1);
			let from = addDays(end, -(chunk - 1));
			if (from < horizon) from = horizon;
			if (end < horizon) {
				d.prepare('UPDATE sites SET backfill_done = 1 WHERE id = ?').run(siteId);
				res.backfillDone = true;
			} else {
				progress(`Backfilling ${from} → ${end}`);
				const dates = await pullTotals(client, siteId, site.site_url, from, end);
				await pullDays(dates);
				// An entirely empty chunk means we have walked past the start of the property's data.
				const reachedStart = dates.length === 0 || from <= horizon;
				d.prepare('UPDATE sites SET backfilled_to = ?, backfill_done = ? WHERE id = ?').run(dates[0] ?? from, reachedStart ? 1 : 0, siteId);
				res.backfillDone = reachedStart;
			}
		}

		d.prepare("UPDATE sites SET last_sync_at = ?, sync_status = 'idle', sync_message = ? WHERE id = ?").run(
			Date.now(),
			res.truncatedDays ? `${res.truncatedDays} day(s) hit the per-day row cap` : null,
			siteId
		);
		d.prepare('UPDATE sync_runs SET finished_at = ?, days = ?, rows = ?, truncated_days = ? WHERE id = ?').run(Date.now(), res.days, res.rows, res.truncatedDays, runId);
		return res;
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		setStatus(siteId, 'error', msg);
		d.prepare('UPDATE sync_runs SET finished_at = ?, days = ?, rows = ?, error = ? WHERE id = ?').run(Date.now(), res.days, res.rows, msg, runId);
		throw e;
	}
}
