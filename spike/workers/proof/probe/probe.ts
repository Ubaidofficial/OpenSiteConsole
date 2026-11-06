/**
 * What of the app's Node-only surface actually works inside workerd? One Worker, run twice by probe/run-probe.mjs:
 * with no compatibility flags and with `nodejs_compat`. Each probe reports ok/error; nothing here is a guess.
 */
let startupError: string | null = null;
try {
	setInterval(() => {}, 60_000); // what startScheduler() does at boot
} catch (e) {
	startupError = String(e);
}
let hits = 0; // module-level state: how long does it live?

const attempt = async (f: () => unknown | Promise<unknown>) => {
	try {
		return { ok: true, detail: await f() };
	} catch (e) {
		return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
	}
};

// gzip("<urlset/>") produced by node:zlib
const GZ = Uint8Array.from(atob('H4sIAAAAAAAAA7MpLcopTi3RtwMA285y/AkAAAA='), (c) => c.charCodeAt(0));

export default {
	async fetch(req: Request): Promise<Response> {
		hits++;
		const origin = new URL(req.url).origin;
		if (new URL(req.url).pathname === '/ping') return new Response('pong');
		const out: Record<string, unknown> = { startupSetIntervalError: startupError, moduleStateHits: hits };

		out['import node:crypto + aes-256-gcm'] = await attempt(async () => {
			const c = await import('node:crypto');
			const key = c.createHash('sha256').update('k').digest();
			const iv = c.randomBytes(12);
			const ci = c.createCipheriv('aes-256-gcm', key, iv);
			const ct = Buffer.concat([ci.update('hello', 'utf8'), ci.final()]);
			const de = c.createDecipheriv('aes-256-gcm', key, iv);
			de.setAuthTag(ci.getAuthTag());
			return Buffer.concat([de.update(ct), de.final()]).toString();
		});
		out['import node:fs: existsSync / mkdirSync(./data) / write+read /tmp'] = await attempt(async () => {
			const fs = await import('node:fs');
			const r: Record<string, unknown> = { existsSync_root: fs.existsSync('/') };
			try { fs.mkdirSync('data', { recursive: true }); r.mkdirSync_relative = 'ok'; } catch (e) { r.mkdirSync_relative = String(e); }
			try { fs.writeFileSync('/tmp/x.txt', 'hi'); r.tmp_roundtrip = fs.readFileSync('/tmp/x.txt', 'utf8'); } catch (e) { r.tmp_roundtrip = String(e); }
			return r;
		});
		out['import node:path'] = await attempt(async () => (await import('node:path')).resolve('/a', 'b'));
		out['import node:zlib gunzipSync'] = await attempt(async () => (await import('node:zlib')).gunzipSync(GZ).toString());
		out['import node:net isIP'] = await attempt(async () => { const n = await import('node:net'); return [n.isIP('127.0.0.1'), n.isIP('::1'), n.isIP('example.com')]; });
		out['import node:dns lookup(example.com)'] = await attempt(async () => {
			const dns = await import('node:dns');
			return await new Promise((res, rej) => dns.lookup('example.com', (e, a) => (e ? rej(e) : res(a))));
		});
		out['import node:stream Readable.toWeb'] = await attempt(async () => typeof (await import('node:stream')).Readable.toWeb);
		out['process.env / process.cwd()'] = await attempt(async () => ({ env: typeof process !== 'undefined' ? typeof process.env : 'no process', cwd: typeof process !== 'undefined' ? process.cwd() : null }));
		// SSRF guard: guardedFetch relies on http.request({ lookup }) to refuse private addresses at connect time.
		out['node:http request to own origin (loopback) works'] = await attempt(async () => {
			const http = await import('node:http');
			return await new Promise((res, rej) => {
				http.get(origin + '/ping', (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
			});
		});
		out['node:http request honours a custom `lookup` that REFUSES (the guardedFetch mechanism)'] = await attempt(async () => {
			const http = await import('node:http');
			return await new Promise((res, rej) => {
				const lookup = (_h: string, _o: unknown, cb: (e: Error | null, a?: string, f?: number) => void) => cb(Object.assign(new Error('Private address refused'), { code: 'EPRIVATE' }));
				const r = http.request(new URL(origin + '/ping'), { method: 'GET', lookup: lookup as never }, (resp) => res({ lookupHonoured: false, note: 'request SUCCEEDED, so the lookup hook was ignored', status: resp.statusCode }));
				r.on('error', (e) => res({ lookupHonoured: true, error: String(e).slice(0, 100) }));
				r.end();
			});
		});
		out['import better-sqlite3'] = await attempt(async () => {
			const D = (await import('better-sqlite3')).default;
			return new D(':memory:').prepare('select 1 x').get();
		});
		return new Response(JSON.stringify(out, null, 2), { headers: { 'content-type': 'application/json' } });
	}
};
