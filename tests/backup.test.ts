import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db, openDb } from '../src/lib/server/db';
import { backupDue, backupFiles, lastBackup, runBackup } from '../src/lib/server/backup';

/** The daily copy: a real file database, SQLite's own backup call, checked, pruned, and loud when it fails. */
let dir: string;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 14, 12, 0, 0);

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), 'osc-backup-'));
	delete process.env.DEMO_MODE;
	delete process.env.BACKUP;
	process.env.BACKUP_DIR = join(dir, 'backups');
	process.env.BACKUP_KEEP = '2';
	globalThis.__openSiteConsoleDb = openDb(join(dir, 'app.db'));
	db().prepare("INSERT INTO kv (key, value) VALUES ('marker', 'hello from the live database')").run();
});
afterEach(() => {
	db().close();
	delete process.env.BACKUP_DIR;
	delete process.env.BACKUP_KEEP;
	delete process.env.BACKUP;
	delete process.env.DIGEST_WEBHOOK_URL;
	rmSync(dir, { recursive: true, force: true });
});

describe('the daily database backup', () => {
	it('writes a copy that opens, passes the integrity check and holds the live data, readable by the owner only', async () => {
		const r = await runBackup({ now: T0 });
		expect(r).toMatchObject({ ok: true, message: null });
		const file = join(dir, 'backups', 'opensiteconsole-2026-11-14.db');
		expect(r.file).toBe(file);
		expect(statSync(file).mode & 0o777).toBe(0o600);
		const copy = new Database(file, { readonly: true });
		expect(copy.prepare("SELECT value FROM kv WHERE key = 'marker'").get()).toEqual({ value: 'hello from the live database' });
		expect(copy.pragma('quick_check')).toEqual([{ quick_check: 'ok' }]);
		copy.close();
		expect(readdirSync(join(dir, 'backups')).filter((f) => f.endsWith('.part'))).toEqual([]);
		expect(lastBackup()).toMatchObject({ ok: true, file });
	});

	it('is due once a day: not after a success today, again the next day', async () => {
		expect(backupDue(T0)).toBe(true);
		await runBackup({ now: T0 });
		expect(backupDue(T0 + 3600_000)).toBe(false);
		expect(backupDue(T0 + DAY)).toBe(true);
	});

	it('keeps the newest BACKUP_KEEP copies and removes older ones, leaving other files alone', async () => {
		mkdirOnce();
		writeFileSync(join(dir, 'backups', 'notes.txt'), 'mine');
		for (let i = 0; i < 4; i++) await runBackup({ now: T0 + i * DAY });
		expect(backupFiles().map((f) => f.day)).toEqual(['2026-11-17', '2026-11-16']);
		expect(existsSync(join(dir, 'backups', 'notes.txt'))).toBe(true);
	});

	it('does nothing when BACKUP=0 and in demo mode', () => {
		process.env.BACKUP = '0';
		expect(backupDue(T0)).toBe(false);
		delete process.env.BACKUP;
		process.env.DEMO_MODE = '1';
		expect(backupDue(T0)).toBe(false);
	});

	it('refuses to fill the disk: too little free space is a failure, nothing is written, and the old copies stay', async () => {
		await runBackup({ now: T0 });
		const r = await runBackup({ now: T0 + DAY, freeBytes: () => 1000 });
		expect(r.ok).toBe(false);
		expect(r.message).toMatch(/Not enough free disk space/);
		expect(backupFiles().map((f) => f.day)).toEqual(['2026-11-14']);
		expect(db().prepare("SELECT COUNT(*) n FROM audit_log WHERE action = 'backup.failed'").get()).toMatchObject({ n: 1 });
	});

	it('retries a failed backup after six hours, not on every tick', async () => {
		await runBackup({ now: T0, freeBytes: () => 0 });
		expect(backupDue(T0 + 3600_000)).toBe(false);
		expect(backupDue(T0 + 7 * 3600_000)).toBe(true);
	});

	it('tells the webhook once a day when it fails, and says what failed', async () => {
		process.env.DIGEST_WEBHOOK_URL = 'https://hooks.example.com/x';
		const posted: string[] = [];
		const fetchImpl = (async (_u: string, init: { body: string }) => {
			posted.push(init.body);
			return new Response('ok', { status: 200 });
		}) as unknown as typeof fetch;
		await runBackup({ now: T0, freeBytes: () => 0, fetchImpl });
		await runBackup({ now: T0 + 7 * 3600_000, freeBytes: () => 0, fetchImpl });
		expect(posted).toHaveLength(1);
		expect(posted[0]).toContain('database backup failed');
		await runBackup({ now: T0 + 25 * 3600_000, freeBytes: () => 0, fetchImpl });
		expect(posted).toHaveLength(2);
	});

	it('an in-memory database is never due and cannot be copied', async () => {
		globalThis.__openSiteConsoleDb = openDb(':memory:');
		expect(backupDue(T0)).toBe(false);
		expect(await runBackup({ now: T0 })).toMatchObject({ ok: false, message: expect.stringMatching(/in memory/) });
	});
});

function mkdirOnce() {
	// the folder is created by the first backup; make it early so the stray file can be placed before it
	rmSync(join(dir, 'backups'), { recursive: true, force: true });
	mkdirSync(join(dir, 'backups'), { recursive: true });
}
