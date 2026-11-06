import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';

export const SESSION_COOKIE = 'osc_session';
export const SESSION_DAYS = 14;
const TTL = SESSION_DAYS * 86_400_000;

const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
/** Ties every session to the current password: changing ADMIN_PASSWORD signs everyone out. */
const passwordFingerprint = () => digest('osc-session-v2\n' + (config.adminPasswordHash || config.adminPassword || ''));

/**
 * Sessions are random 256-bit ids kept (hashed) in the database with an expiry. The cookie holds nothing but the id, so a copy
 * of it can be revoked (logout, password change, expiry), which a signed constant could not be.
 */
export function createSession(now = Date.now()): { id: string; maxAgeSeconds: number } {
	const d = db();
	d.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const id = randomBytes(32).toString('base64url');
	d.prepare('INSERT INTO sessions (id_hash, pw_fp, created_at, expires_at) VALUES (?,?,?,?)').run(digest(id), passwordFingerprint(), now, now + TTL);
	return { id, maxAgeSeconds: Math.floor(TTL / 1000) };
}

export function validSession(id: string | undefined, now = Date.now()): boolean {
	if (!id || id.length < 32 || id.length > 128) return false;
	const row = db().prepare('SELECT pw_fp, expires_at FROM sessions WHERE id_hash = ?').get(digest(id)) as { pw_fp: string; expires_at: number } | undefined;
	return !!row && row.expires_at > now && row.pw_fp === passwordFingerprint();
}

export function endSession(id: string | undefined) {
	if (id) db().prepare('DELETE FROM sessions WHERE id_hash = ?').run(digest(id));
}
