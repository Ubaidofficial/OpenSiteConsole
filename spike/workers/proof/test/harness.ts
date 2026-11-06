/** Starts the proof Worker under `wrangler dev --local` (workerd + miniflare D1, no Cloudflare account involved). */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const proofDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerJs = path.join(proofDir, 'node_modules/wrangler/bin/wrangler.js');

const freePort = () =>
	new Promise<number>((res, rej) => {
		const s = createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
		s.on('error', rej);
	});

export interface Running {
	base: string;
	stop(): Promise<void>;
	get(pathAndQuery: string): Promise<any>;
	post(pathAndQuery: string, body?: unknown): Promise<any>;
	raw(pathAndQuery: string, init: RequestInit): Promise<any>;
	log(): string;
}

export async function startWorker(opts: { today: string }): Promise<Running> {
	const state = path.join(proofDir, '.wrangler-state-test');
	rmSync(state, { recursive: true, force: true });
	const env = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' };
	execFileSync(process.execPath, [wranglerJs, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', state], { cwd: proofDir, env, stdio: 'pipe' });

	const port = await freePort();
	const inspector = await freePort();
	const child: ChildProcess = spawn(process.execPath, [wranglerJs, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(port), '--inspector-port', String(inspector), '--persist-to', state, '--test-scheduled', '--var', `FIXED_TODAY:${opts.today}`], { cwd: proofDir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	let out = '';
	child.stdout!.on('data', (d) => (out += d));
	child.stderr!.on('data', (d) => (out += d));
	await new Promise<void>((res, rej) => {
		const t = setTimeout(() => rej(new Error('wrangler dev did not become ready in 90s:\n' + out)), 90_000);
		const poll = setInterval(() => {
			if (/Ready on http/.test(out)) (clearInterval(poll), clearTimeout(t), res());
			if (child.exitCode !== null) (clearInterval(poll), clearTimeout(t), rej(new Error('wrangler dev exited early:\n' + out)));
		}, 200);
	});
	const base = `http://127.0.0.1:${port}`;
	// One fresh connection per request (agent: false): workerd closes idle keep-alive sockets, and a pooled socket that went
	// stale during a long Node-side phase made fetch() fail with "other side closed".
	const raw = (p: string, init: RequestInit) =>
		new Promise<any>((resolve, reject) => {
			const req = httpRequest(base + p, { method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, agent: false }, (res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c) => chunks.push(c));
				res.on('end', () => {
					const text = Buffer.concat(chunks).toString('utf8');
					try {
						resolve(JSON.parse(text));
					} catch {
						resolve({ __status: res.statusCode, __text: text });
					}
				});
			});
			req.on('error', reject);
			if (init.body) req.write(init.body as Buffer | string);
			req.end();
		});
	return {
		base,
		get: (p) => raw(p, {}),
		post: (p, body) => raw(p, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body), headers: { 'content-type': 'application/json' } }),
		raw,
		log: () => out.replace(/\x1b\[[0-9;]*m/g, ''),
		async stop() {
			try {
				process.kill(-child.pid!, 'SIGTERM');
			} catch {
				/* already gone */
			}
			await new Promise((r) => setTimeout(r, 500));
		}
	};
}
