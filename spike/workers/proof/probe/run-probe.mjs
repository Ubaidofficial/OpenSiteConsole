#!/usr/bin/env node
/**
 * Runs probe.ts under `wrangler dev --local` twice (no compat flags / nodejs_compat) and writes probe/results.json.
 *   cd spike/workers/proof && node probe/run-probe.mjs
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const proof = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = path.join(proof, 'node_modules/wrangler/bin/wrangler.js');
const free = () => new Promise((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

async function run(label, flags) {
	const cfg = path.join(proof, `probe/.wrangler.${label}.jsonc`);
	writeFileSync(cfg, JSON.stringify({ name: 'osc-probe-' + label, main: path.join(proof, 'probe/probe.ts'), compatibility_date: '2026-10-01', compatibility_flags: flags }));
	const port = await free();
	const inspector = await free();
	const child = spawn(process.execPath, [wrangler, 'dev', '-c', cfg, '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', path.join(proof, '.wrangler-state-probe')], { cwd: proof, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let log = '';
	child.stdout.on('data', (d) => (log += d));
	child.stderr.on('data', (d) => (log += d));
	for (let i = 0; i < 300 && !/Ready on http/.test(log); i++) await new Promise((r) => setTimeout(r, 200));
	let body;
	try {
		await fetch(`http://127.0.0.1:${port}/`); // first hit (module state: hits=1)
		const r = await fetch(`http://127.0.0.1:${port}/`);
		const text = await r.text();
		try { body = JSON.parse(text); } catch { body = { httpStatus: r.status, text: text.slice(0, 600), workerLog: log.replace(/\x1b\[[0-9;]*m/g, '').slice(-1200) }; }
	} catch (e) {
		body = { fetchError: String(e), workerLog: log.slice(-1200) };
	}
	try { process.kill(-child.pid, 'SIGTERM'); } catch {}
	await new Promise((r) => setTimeout(r, 500));
	rmSync(cfg, { force: true });
	return body;
}

const results = { none: await run('none', []), nodejs_compat: await run('compat', ['nodejs_compat']) };
writeFileSync(path.join(proof, 'probe/results.json'), JSON.stringify(results, null, 2));
for (const [k, v] of Object.entries(results)) {
	console.log(`\n=== compatibility_flags: ${k} ===`);
	for (const [name, r] of Object.entries(v)) console.log(`${r && r.ok === false ? 'FAIL' : r && r.ok ? 'ok  ' : '    '} ${name}: ${JSON.stringify(r && r.ok !== undefined ? (r.ok ? r.detail : r.error) : r)}`);
}
