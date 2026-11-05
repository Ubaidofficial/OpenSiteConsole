import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from './config';

let cachedKey: Buffer | null = null;

function secret(): string {
	const fromEnv = env('APP_SECRET');
	if (fromEnv.length >= 16) return fromEnv;
	// No APP_SECRET: generate one next to the database so tokens survive restarts.
	const file = resolve(process.cwd(), env('DB_PATH', './data/opensiteconsole.db') + '.secret');
	if (existsSync(file)) return readFileSync(file, 'utf8').trim();
	const fresh = randomBytes(32).toString('base64');
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, fresh, { mode: 0o600 });
	return fresh;
}

function key(): Buffer {
	return (cachedKey ??= createHash('sha256').update(secret()).digest());
}

/** AES-256-GCM. Output: v1:<iv>:<tag>:<ciphertext> (base64). */
export function encrypt(plain: string): string {
	const iv = randomBytes(12);
	const c = createCipheriv('aes-256-gcm', key(), iv);
	const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
	return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decrypt(blob: string): string {
	const [v, iv, tag, ct] = blob.split(':');
	if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext format');
	const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
	d.setAuthTag(Buffer.from(tag, 'base64'));
	return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

export function signValue(value: string): string {
	return value + '.' + createHmac('sha256', key()).update(value).digest('base64url');
}

export function verifySigned(signed: string | undefined): string | null {
	if (!signed) return null;
	const i = signed.lastIndexOf('.');
	if (i < 1) return null;
	const value = signed.slice(0, i);
	const expected = Buffer.from(signValue(value));
	const actual = Buffer.from(signed);
	return expected.length === actual.length && timingSafeEqual(expected, actual) ? value : null;
}

export function safeEqual(a: string, b: string): boolean {
	const ha = createHash('sha256').update(a).digest();
	const hb = createHash('sha256').update(b).digest();
	return timingSafeEqual(ha, hb);
}
