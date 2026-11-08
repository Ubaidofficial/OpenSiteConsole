import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { OWNER, asMemberRole, type CurrentUser } from './roles';

export const SESSION_COOKIE = 'osc_session';
export const SESSION_DAYS = 14;
const TTL = SESSION_DAYS * 86_400_000;

const digest = (s: string) => createHash('sha256').update(s).digest('base64url');
/** Ties every session to the current password: changing ADMIN_PASSWORD signs everyone out, team members included. */
const passwordFingerprint = () => digest('osc-session-v2\n' + (config.adminPasswordHash || config.adminPassword || ''));
/** A team member's session is also tied to their own password hash, so a new password ends their other sessions. */
const memberFingerprint = (passwordHash: string) => digest('osc-session-member-v1\n' + passwordFingerprint() + '\n' + passwordHash);

/**
 * Sessions are random 256-bit ids kept (hashed) in the database with an expiry. The cookie holds nothing but the id, so a copy
 * of it can be revoked (logout, password change, a member disabled or removed, expiry), which a signed constant could not be.
 * `userId` null is the owner.
 */
export function createSession(now = Date.now(), userId: number | null = null): { id: string; maxAgeSeconds: number } {
	const d = db();
	let fp = passwordFingerprint();
	if (userId !== null) {
		const u = d.prepare('SELECT password_hash FROM users WHERE id = ? AND disabled = 0').get(userId) as { password_hash: string } | undefined;
		if (!u) throw new Error('No such active user');
		fp = memberFingerprint(u.password_hash);
	}
	d.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
	const id = randomBytes(32).toString('base64url');
	d.prepare('INSERT INTO sessions (id_hash, pw_fp, created_at, expires_at, user_id) VALUES (?,?,?,?,?)').run(digest(id), fp, now, now + TTL, userId);
	return { id, maxAgeSeconds: Math.floor(TTL / 1000) };
}

interface Row { pw_fp: string; expires_at: number; user_id: number | null; email: string | null; name: string | null; role: string | null; site_ids: string | null; disabled: number | null; password_hash: string | null }

/** Who a session cookie belongs to, or null. Role and site scope are read fresh on every request, so a change applies at once. */
export function sessionUser(id: string | undefined, now = Date.now()): CurrentUser | null {
	if (!id || id.length < 32 || id.length > 128) return null;
	const row = db()
		.prepare('SELECT s.pw_fp, s.expires_at, s.user_id, u.email, u.name, u.role, u.site_ids, u.disabled, u.password_hash FROM sessions s LEFT JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?')
		.get(digest(id)) as Row | undefined;
	if (!row || row.expires_at <= now) return null;
	if (row.user_id === null) return row.pw_fp === passwordFingerprint() ? OWNER : null;
	const role = asMemberRole(row.role);
	if (!role || row.disabled !== 0 || !row.password_hash || row.pw_fp !== memberFingerprint(row.password_hash)) return null;
	const siteIds = role === 'admin' || !row.site_ids ? null : (JSON.parse(row.site_ids) as number[]);
	return { id: row.user_id, email: row.email, name: row.name ?? row.email ?? 'Member', role, siteIds };
}

export function validSession(id: string | undefined, now = Date.now()): boolean {
	return sessionUser(id, now) !== null;
}

export function endSession(id: string | undefined) {
	if (id) db().prepare('DELETE FROM sessions WHERE id_hash = ?').run(digest(id));
}

/** Sign a team member out everywhere (disabled, removed). */
export function endUserSessions(userId: number) {
	db().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}
