import Database from 'better-sqlite3';
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { audit, db } from './db';
import { config } from './config';
import { postWebhook, webhook } from './digest';

/**
 * A daily copy of the database made with SQLite's own backup call (a plain file copy of a live database can catch it mid-write),
 * checked, and pruned to the last BACKUP_KEEP. It lives next to the database, so it protects against a bad change or a damaged
 * file, NOT against losing the disk or server: copy the folder somewhere else as well. The copy holds the encrypted Google tokens,
 * and is only readable with the same APP_SECRET, so keep that safe too.
 */
const KEY = 'backup_last';
const ALERT_KEY = 'backup_alerted';
const FILE = /^opensiteconsole-(\d{4}-\d{2}-\d{2})\.db$/;
const RETRY_AFTER_MS = 6 * 3600_000;
const ALERT_EVERY_MS = 24 * 3600_000;

export interface BackupStatus { at: number; ok: boolean; file: string | null; bytes: number | null; message: string | null }

const kvGet = (k: string) => (db().prepare('SELECT value FROM kv WHERE key = ?').get(k) as { value: string } | undefined)?.value;
const kvSet = (k: string, v: string) => void db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(k, v);
const utcDay = (t: number) => new Date(t).toISOString().slice(0, 10);

export function lastBackup(): BackupStatus | null {
	const v = kvGet(KEY);
	if (!v) return null;
	try {
		return JSON.parse(v) as BackupStatus;
	} catch {
		return null;
	}
}

/** The copies on disk, newest first. */
export function backupFiles(dir = config.backupDir): { file: string; day: string; bytes: number }[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.map((f) => ({ f, m: FILE.exec(f) }))
		.filter((x): x is { f: string; m: RegExpExecArray } => !!x.m)
		.map((x) => ({ file: join(dir, x.f), day: x.m[1], bytes: statSync(join(dir, x.f)).size }))
		.sort((a, b) => b.day.localeCompare(a.day));
}

/** Due when one has not been made today (UTC), and the last attempt did not fail within the last 6 hours. */
export function backupDue(now = Date.now()): boolean {
	if (!config.backupEnabled || db().memory) return false;
	const last = lastBackup();
	if (!last) return true;
	if (last.ok) return utcDay(last.at) !== utcDay(now);
	return now - last.at >= RETRY_AFTER_MS;
}

const freeBytesOf = (dir: string) => {
	const s = statfsSync(dir);
	return Number(s.bavail) * Number(s.bsize);
};

export async function runBackup(o: { now?: number; freeBytes?: (dir: string) => number; fetchImpl?: typeof fetch } = {}): Promise<BackupStatus> {
	const now = o.now ?? Date.now();
	const d = db();
	const record = (s: Omit<BackupStatus, 'at'>): BackupStatus => {
		const full = { at: now, ...s };
		kvSet(KEY, JSON.stringify(full));
		return full;
	};
	const fail = async (message: string) => {
		const s = record({ ok: false, file: null, bytes: null, message });
		audit('backup.failed', { detail: message.slice(0, 300) });
		// One notice a day, not one per retry.
		const lastAlert = Number(kvGet(ALERT_KEY) ?? 0);
		if (webhook().url && now - lastAlert >= ALERT_EVERY_MS) {
			const r = await postWebhook(`SEOConsole: the daily database backup failed. ${message}`, { backup: { ok: false, message } }, o.fetchImpl);
			if (r.ok) kvSet(ALERT_KEY, String(now));
		}
		return s;
	};
	if (d.memory) return record({ ok: false, file: null, bytes: null, message: 'The database is in memory; there is nothing to copy.' });
	const dir = config.backupDir;
	const target = join(dir, `opensiteconsole-${utcDay(now)}.db`);
	const part = target + '.part';
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		const size = statSync(d.name).size;
		// Room for the copy and some headroom; a full disk would break the app itself, not only the backup.
		const free = (o.freeBytes ?? freeBytesOf)(dir);
		if (free < size * 1.5 + 50_000_000) return await fail(`Not enough free disk space for a copy (${Math.round(size / 1e6)} MB database, ${Math.round(free / 1e6)} MB free). Make room or set BACKUP=0.`);
		rmSync(part, { force: true });
		await d.backup(part);
		// Never keep a copy that does not open and pass SQLite's own check.
		const copy = new Database(part, { readonly: true });
		try {
			const r = copy.pragma('quick_check') as { quick_check: string }[];
			if (r.length !== 1 || r[0].quick_check !== 'ok') throw new Error(`The copy failed SQLite's integrity check (${r[0]?.quick_check ?? 'no result'}).`);
		} finally {
			copy.close();
		}
		chmodSync(part, 0o600);
		renameSync(part, target);
		for (const old of backupFiles(dir).slice(config.backupKeep)) rmSync(old.file, { force: true });
		return record({ ok: true, file: target, bytes: statSync(target).size, message: null });
	} catch (e) {
		rmSync(part, { force: true });
		return await fail(e instanceof Error ? e.message : String(e));
	}
}
