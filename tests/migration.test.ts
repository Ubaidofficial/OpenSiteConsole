import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../src/lib/server/db';

describe('db migration v1', () => {
	it('re-opens backfills that older versions wrongly marked complete, once, keeping stored data', () => {
		const dir = mkdtempSync(join(tmpdir(), 'osc-mig-'));
		const file = join(dir, 'test.db');
		try {
			let db = openDb(file);
			db.prepare("INSERT INTO accounts (id, google_sub, email, created_at) VALUES (1,'s','a@b.c',1)").run();
			db.prepare("INSERT INTO sites (id, account_id, site_url, permission, backfill_done, backfilled_to, created_at) VALUES (1,1,'https://x.example/','siteOwner',1,'2026-09-01',1)").run();
			db.prepare('INSERT INTO site_daily VALUES (1,?,?,?,?)').run('2026-09-01', 5, 50, 9);
			db.pragma('user_version = 0'); // what an install from before the fix looks like
			db.close();

			db = openDb(file); // upgrade
			const s = db.prepare('SELECT backfill_done, backfilled_to FROM sites WHERE id = 1').get() as { backfill_done: number; backfilled_to: string };
			expect(s.backfill_done).toBe(0);
			expect(s.backfilled_to).toBe('2026-09-01'); // resumes from the cursor
			expect((db.prepare('SELECT COUNT(*) n FROM site_daily').get() as { n: number }).n).toBe(1);
			expect(db.pragma('user_version', { simple: true })).toBe(1);

			db.prepare('UPDATE sites SET backfill_done = 1').run(); // finished again legitimately
			db.close();
			db = openDb(file); // a later start must NOT reset it again
			expect((db.prepare('SELECT backfill_done d FROM sites WHERE id = 1').get() as { d: number }).d).toBe(1);
			db.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
