#!/usr/bin/env node
/**
 * One sync step whose newest day carries 100,000 rows (the app's default MAX_ROWS_PER_DAY) on local D1, both write modes.
 * Prints what the step costs in D1 statements / round trips and wall time in the LOCAL EMULATOR (not a production benchmark;
 * workerd's CPU accounting is not exposed locally, so Workers CPU time for this step is NOT measured here).
 *   cd spike/workers/proof && node scripts/measure-big-day.mjs
 */
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const proof = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(proof, 'node_modules/wrangler/bin/wrangler.js');
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const state = path.join(proof, '.wrangler-state-measure');
rmSync(state, { recursive: true, force: true });
const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
execFileSync(process.execPath, [wrangler, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: proof, env, stdio: 'pipe' });
const port = await free();
const child = spawn(process.execPath, [wrangler, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(await free()), '--persist-to', state], { cwd: proof, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stdout.on('data', (d) => (log += d));
child.stderr.on('data', (d) => (log += d));
for (let i = 0; i < 450 && !/Ready on http/.test(log); i++) await new Promise((r) => setTimeout(r, 200));
const base = `http://127.0.0.1:${port}`;
const call = async (p) => (await fetch(base + p, { method: 'POST', headers: { connection: 'close' } })).json();
for (const write of ['jsonEach', 'perRow']) {
	await call('/reset');
	await call('/seed');
	const r = await call(`/sync?site=1&mode=incremental&today=2026-03-31&write=${write}&big=100000`);
	console.log(write.padEnd(9), JSON.stringify({ rows: r.res.rows, truncatedDays: r.res.truncatedDays, d1Statements: r.d1.statements, d1RoundTrips: r.d1.roundTrips, wallMsLocalEmulator: r.ms }));
}
console.log('\nD1 meta accounting for sa_rows (1000 rows; WITHOUT ROWID table + 2 secondary indexes):');
console.log(JSON.stringify(await (await fetch(base + '/probe/rows-written', { headers: { connection: 'close' } })).json(), null, 1));
try { process.kill(-child.pid, 'SIGTERM'); } catch {}
