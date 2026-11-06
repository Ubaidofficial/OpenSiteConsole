import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The container's start script, run against a stand-in `litestream` that only records how it was called (the real binary is
 * not available here). This proves the order and the flags, and that the database is never left unprotected silently; it does
 * NOT prove Litestream's own behaviour, which is taken from its documentation.
 */
const SCRIPT = join(process.cwd(), 'deploy/cloudflare/entrypoint.sh');

function run(env: Record<string, string>) {
	const dir = mkdtempSync(join(tmpdir(), 'osc-ep-'));
	const log = join(dir, 'calls.log');
	const stub = join(dir, 'litestream');
	// record every call; for `replicate -exec CMD` also run CMD, as the real one does
	writeFileSync(stub, `#!/bin/sh\necho "litestream $*" >> "${log}"\nif [ "$1" = replicate ]; then while [ "$1" != "-exec" ] && [ $# -gt 0 ]; do shift; done; shift; exec sh -c "$1"; fi\nexit 0\n`);
	chmodSync(stub, 0o755);
	const r = spawnSync('sh', [SCRIPT], { env: { PATH: `${dir}:/usr/bin:/bin`, DB_PATH: join(dir, 'data/app.db'), LITESTREAM_CONFIG: '/etc/ls.yml', OSC_APP_COMMAND: 'echo APP-RAN', ...env }, encoding: 'utf8' });
	let calls = '';
	try { calls = readFileSync(log, 'utf8'); } catch { /* never called */ }
	return { code: r.status, out: r.stdout, err: r.stderr, calls: calls.trim().split('\n').filter(Boolean) };
}
const R2 = { R2_BUCKET: 'b', R2_ACCOUNT_ID: 'acct', R2_ACCESS_KEY_ID: 'k', R2_SECRET_ACCESS_KEY: 's' };

describe('cloudflare container entrypoint', () => {
	it('restores the database first (only if absent, and only if a backup exists), then runs the app under replication', () => {
		const r = run(R2);
		expect(r.code).toBe(0);
		expect(r.calls).toHaveLength(2);
		expect(r.calls[0]).toMatch(/^litestream restore -config \/etc\/ls\.yml -if-db-not-exists -if-replica-exists .*\/data\/app\.db$/);
		expect(r.calls[1]).toBe('litestream replicate -config /etc/ls.yml -exec echo APP-RAN');
		expect(r.out).toContain('APP-RAN');
	});
	it('refuses to start without R2, so data is never silently lost when the container sleeps', () => {
		for (const missing of Object.keys(R2)) {
			const r = run({ ...R2, [missing]: '' });
			expect(r.code, missing).toBe(1);
			expect(r.out).not.toContain('APP-RAN');
			expect(r.calls).toEqual([]);
			expect(r.err).toMatch(/R2_BUCKET.*required/);
		}
	});
	it('runs without replication only when explicitly asked, and says so', () => {
		const r = run({ ALLOW_EPHEMERAL: '1' });
		expect(r.code).toBe(0);
		expect(r.out).toContain('APP-RAN');
		expect(r.calls).toEqual([]);
		expect(r.err).toMatch(/WARNING.*lost whenever the container sleeps/);
	});
	it('the Litestream config targets R2 with the documented endpoint form, region auto, and reads its values from the environment', () => {
		const y = readFileSync(join(process.cwd(), 'deploy/cloudflare/litestream.yml'), 'utf8');
		expect(y).toMatch(/endpoint: \$\{R2_ACCOUNT_ID\}\.r2\.cloudflarestorage\.com/);
		expect(y).toMatch(/region: auto/);
		for (const v of ['DB_PATH', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']) expect(y).toContain('${' + v + '}');
	});
});
