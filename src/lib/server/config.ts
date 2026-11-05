import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** Minimal .env loader so config works in dev, prod and tests alike. process.env always wins. */
let loaded = false;
function loadDotEnv() {
	if (loaded) return;
	loaded = true;
	const file = resolve(process.cwd(), '.env');
	if (!existsSync(file)) return;
	for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i.exec(line);
		if (!m || line.trim().startsWith('#')) continue;
		const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
		if (process.env[m[1]] === undefined) process.env[m[1]] = v;
	}
}

export function env(name: string, fallback = ''): string {
	loadDotEnv();
	return process.env[name] ?? fallback;
}

export const config = {
	get origin() {
		return env('ORIGIN', 'http://localhost:5173').replace(/\/$/, '');
	},
	get googleClientId() {
		return env('GOOGLE_CLIENT_ID');
	},
	get googleClientSecret() {
		return env('GOOGLE_CLIENT_SECRET');
	},
	get adminPassword() {
		return env('ADMIN_PASSWORD');
	},
	get demo() {
		return env('DEMO_MODE') === '1';
	},
	/** READ_ONLY=1 requests the webmasters.readonly scope and disables every write action. */
	get readOnly() {
		return env('READ_ONLY') === '1';
	},
	get dbPath() {
		return resolve(process.cwd(), env('DB_PATH', './data/opensiteconsole.db'));
	},
	/** Max detail rows pulled per day per site (25k per API page). */
	get maxRowsPerDay() {
		return Number(env('MAX_ROWS_PER_DAY', '100000'));
	},
	get syncConcurrency() {
		return Math.max(1, Number(env('SYNC_CONCURRENCY', '2')));
	},
	get schedulerEnabled() {
		return env('SCHEDULER', '1') !== '0' && !process.env.VITEST;
	}
};
