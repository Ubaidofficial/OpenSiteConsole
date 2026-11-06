import type { Db } from './db';

/** Canonical, timestamp-free snapshot of the synced tables: what the comparison test diffs between engines. */
export async function dump(db: Db) {
	return {
		sa_rows: await db.all('SELECT site_id, date, query, page, country, device, clicks, impressions, position FROM sa_rows ORDER BY site_id, date, query, page, country, device'),
		site_daily: await db.all('SELECT * FROM site_daily ORDER BY site_id, date'),
		site_daily_type: await db.all('SELECT * FROM site_daily_type ORDER BY site_id, search_type, date'),
		site_appearance: await db.all('SELECT * FROM site_appearance ORDER BY site_id, days, appearance'),
		sites: await db.all('SELECT id, site_url, synced_through, backfilled_to, backfill_done, sync_status, sync_message, types_synced_at IS NOT NULL AS types_done, appearance_pulled_on FROM sites ORDER BY id'),
		sync_runs: await db.all('SELECT site_id, mode, days, rows, truncated_days, error, finished_at IS NOT NULL AS finished FROM sync_runs ORDER BY id')
	};
}
