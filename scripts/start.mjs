// Start the production build with the same .env the dev server uses.
// adapter-node reads ORIGIN/PORT/HOST from process.env before the app loads .env, and without ORIGIN it assumes
// https, so every form POST on http://localhost is rejected as cross-site. Loading .env first avoids that.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const file = resolve(process.cwd(), '.env');
if (existsSync(file)) {
	for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
		if (!m || line.trim().startsWith('#')) continue;
		if (process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
	}
}
process.env.PORT ||= '5173';
process.env.HOST ||= '127.0.0.1'; // this machine only; set HOST=0.0.0.0 (and ADMIN_PASSWORD) to share it
process.env.ORIGIN ||= `http://localhost:${process.env.PORT}`;

if (!existsSync(resolve(process.cwd(), 'build/index.js'))) {
	console.error('No build found. Run "pnpm build" first, or use "pnpm serve".');
	process.exit(1);
}
await import(resolve(process.cwd(), 'build/index.js'));
