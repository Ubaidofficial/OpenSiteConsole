import { createHash, randomBytes } from 'node:crypto';
import { audit, db } from './db';
import { hashPassword, verifyPassword } from './password';
import { safeEqual } from './crypto';
import { endUserSessions } from './sessions';
import type { CurrentUser } from './roles';
import { getUser, isOwnerEmail, MAX_PASSWORD_LENGTH, MIN_MEMBER_PASSWORD_LENGTH, normalizeEmail, TeamError, who, type UserRow } from './users';

/**
 * What a team member can do for themselves (change their name, email and password, link a Google account), how "Sign in with Google" decides
 * who someone is, and password reset links.
 *
 * There is no email sending in SEOConsole, so "forgot my password" works like an invite: an owner or admin makes a single-use link for the
 * member and passes it on. Only a SHA-256 of the link is stored, it expires after RESET_HOURS, and using it is atomic. The owner is not a row:
 * their password is ADMIN_PASSWORD / ADMIN_PASSWORD_HASH in the environment, which is where it is changed.
 */
export const RESET_PREFIX = 'oscr_';
export const RESET_HOURS = 24;
const RESET_TTL = RESET_HOURS * 3_600_000;
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

function passwordProblem(pw: string): string | null {
	if (pw.length < MIN_MEMBER_PASSWORD_LENGTH) return `Choose a password of at least ${MIN_MEMBER_PASSWORD_LENGTH} characters.`;
	if (pw.length > MAX_PASSWORD_LENGTH) return `Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.`;
	return null;
}

/** The member, once they have proved they know their current password. */
function confirmed(userId: number, current: unknown): UserRow {
	const u = getUser(userId);
	const row = db().prepare('SELECT password_hash, disabled FROM users WHERE id = ?').get(userId) as { password_hash: string; disabled: number } | undefined;
	const pw = String(current ?? '');
	if (!u || !row || row.disabled !== 0 || pw.length > MAX_PASSWORD_LENGTH || !verifyPassword(pw, row.password_hash)) throw new TeamError('Your current password is wrong.');
	return u;
}

export function changeOwnName(userId: number, nameRaw: unknown): UserRow {
	const name = String(nameRaw ?? '').replace(/\s+/g, ' ').trim();
	if (!name || name.length > 80) throw new TeamError('Enter your name (up to 80 characters).');
	const u = getUser(userId);
	if (!u) throw new TeamError('Unknown team member.');
	db().prepare('UPDATE users SET name = ? WHERE id = ?').run(name, userId);
	audit('user.name_changed', { detail: `${u.email}: “${u.name}” -> “${name}”` });
	return getUser(userId)!;
}

/**
 * The address they sign in with. Needs the current password, so someone at an unlocked screen cannot take the account over. There is no email
 * sending, so the new address is not verified by a message: that is also why it cannot be an owner address, and why the Google link is dropped
 * (the next Google sign-in must prove the new address).
 */
export function changeOwnEmail(userId: number, currentPassword: unknown, emailRaw: unknown): UserRow {
	const u = confirmed(userId, currentPassword);
	const email = normalizeEmail(emailRaw);
	if (!email) throw new TeamError('Enter a valid email address.');
	if (email === u.email) throw new TeamError('That is already your email address.');
	if (isOwnerEmail(email)) throw new TeamError('That address is the owner’s and cannot be used by a team member.');
	if (db().prepare('SELECT 1 FROM users WHERE email = ? AND id <> ?').get(email, userId)) throw new TeamError('Someone else on the team already uses that email.');
	db().prepare('UPDATE users SET email = ?, google_sub = NULL WHERE id = ?').run(email, userId);
	audit('user.email_changed', { detail: `${u.email} -> ${email} (by the member)` });
	return getUser(userId)!;
}

/** New password. Every session of theirs ends (the caller starts a fresh one for the browser that asked) and any pending reset link is voided. */
export function changeOwnPassword(userId: number, currentPassword: unknown, nextRaw: unknown): UserRow {
	const u = confirmed(userId, currentPassword);
	const next = String(nextRaw ?? '');
	const bad = passwordProblem(next);
	if (bad) throw new TeamError(bad);
	if (next === String(currentPassword)) throw new TeamError('Choose a password you are not already using.');
	const hash = hashPassword(next);
	db().prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
	endUserSessions(userId);
	db().prepare('UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(Date.now(), userId);
	audit('user.password_changed', { detail: `${u.email} (by the member)` });
	return getUser(userId)!;
}

// ── Sign in with Google ──────────────────────────────────────────────────────
export type GoogleSignIn =
	| { kind: 'owner' }
	| { kind: 'member'; user: UserRow }
	/** unverified: Google has not verified the address. unknown: not on the team. disabled. other-google: the member signs in with a different Google account. */
	| { kind: 'refused'; reason: 'unverified' | 'unknown' | 'disabled' | 'other-google' };

/**
 * Who a Google identity is. Only people already set up can sign in; Google never creates an account.
 *  1. A member whose Google account (the stable `sub`) is linked: that member, whatever the address is now.
 *  2. Otherwise Google must have verified the address. An address in OWNER_GOOGLE_EMAILS is the owner.
 *  3. Otherwise a member with that address and no Google account linked yet is signed in and the account is linked to them.
 * The owner is matched by verified address only (there is no row to link). Connected Search Console accounts do NOT count: an admin can connect one.
 */
export function googleSignIn(g: { sub: string; email: string; emailVerified: boolean }, now = Date.now()): GoogleSignIn {
	const d = db();
	const touch = (id: number): GoogleSignIn => (d.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, id), { kind: 'member', user: getUser(id)! });
	const bound = d.prepare('SELECT id, disabled FROM users WHERE google_sub = ?').get(g.sub) as { id: number; disabled: number } | undefined;
	if (bound) return bound.disabled ? { kind: 'refused', reason: 'disabled' } : touch(bound.id);
	if (!g.emailVerified) return { kind: 'refused', reason: 'unverified' };
	const email = normalizeEmail(g.email);
	if (!email) return { kind: 'refused', reason: 'unknown' };
	if (isOwnerEmail(email)) return { kind: 'owner' };
	const row = d.prepare('SELECT id, disabled, google_sub FROM users WHERE email = ?').get(email) as { id: number; disabled: number; google_sub: string | null } | undefined;
	if (!row) return { kind: 'refused', reason: 'unknown' };
	if (row.disabled) return { kind: 'refused', reason: 'disabled' };
	if (row.google_sub) return { kind: 'refused', reason: 'other-google' };
	d.prepare('UPDATE users SET google_sub = ? WHERE id = ? AND google_sub IS NULL').run(g.sub, row.id);
	audit('user.google_linked', { detail: `${email} (first Google sign-in)` });
	return touch(row.id);
}

/** Link a Google account to a member who is signed in (their Google address need not match their SEOConsole one). */
export function linkGoogle(userId: number, sub: string) {
	const u = getUser(userId);
	if (!u) throw new TeamError('Unknown team member.');
	const other = db().prepare('SELECT id FROM users WHERE google_sub = ? AND id <> ?').get(sub, userId);
	if (other) throw new TeamError('That Google account is already linked to another team member.');
	db().prepare('UPDATE users SET google_sub = ? WHERE id = ?').run(sub, userId);
	audit('user.google_linked', { detail: `${u.email} (linked from their profile)` });
}

export function unlinkGoogle(userId: number) {
	const u = getUser(userId);
	if (!u) throw new TeamError('Unknown team member.');
	db().prepare('UPDATE users SET google_sub = NULL WHERE id = ?').run(userId);
	audit('user.google_unlinked', { detail: u.email });
}

export const googleLinked = (userId: number) => !!(db().prepare('SELECT google_sub FROM users WHERE id = ?').get(userId) as { google_sub: string | null } | undefined)?.google_sub;

// ── password reset links ─────────────────────────────────────────────────────
export interface ResetRow { id: number; userId: number; email: string; name: string; expiresAt: number }

/** An owner or admin makes a reset link for a member. A newer link replaces any pending one. The link is shown once and only its hash is kept. */
export function createPasswordReset(userId: number, actor?: CurrentUser | null, now = Date.now()): { token: string; email: string; name: string; expiresAt: number } {
	if (actor && actor.id === userId) throw new TeamError('Change your own password from your profile.');
	const u = getUser(userId);
	if (!u) throw new TeamError('Unknown team member.');
	if (u.disabled) throw new TeamError('Enable this member first: a disabled member cannot sign in.');
	const token = RESET_PREFIX + randomBytes(32).toString('base64url');
	const expiresAt = now + RESET_TTL;
	const d = db();
	d.transaction(() => {
		d.prepare('UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, userId);
		d.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, created_by) VALUES (?,?,?,?,?)').run(tokenHash(token), userId, now, expiresAt, who(actor));
	})();
	audit('user.reset_link_created', { detail: `${u.email} by ${who(actor)}` });
	return { token, email: u.email, name: u.name, expiresAt };
}

/** A pending reset link for this token whose member can still sign in, or undefined. Shape first, then the stored hash in constant time. */
export function findReset(token: string, now = Date.now()): ResetRow | undefined {
	if (typeof token !== 'string' || !token.startsWith(RESET_PREFIX) || token.length < 40 || token.length > 100) return undefined;
	const h = tokenHash(token);
	const r = db()
		.prepare('SELECT r.id, r.token_hash, r.user_id, r.expires_at, r.used_at, r.revoked_at, u.email, u.name, u.disabled FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ?')
		.get(h) as { id: number; token_hash: string; user_id: number; expires_at: number; used_at: number | null; revoked_at: number | null; email: string; name: string; disabled: number } | undefined;
	if (!r || !safeEqual(r.token_hash, h) || r.used_at !== null || r.revoked_at !== null || r.expires_at <= now || r.disabled) return undefined;
	return { id: r.id, userId: r.user_id, email: r.email, name: r.name, expiresAt: r.expires_at };
}

/** Use the link: sets the new password, ends every session of that member, and uses the link up. All or nothing. Returns the member. */
export function completePasswordReset(token: string, nextRaw: unknown, now = Date.now()): UserRow {
	const next = String(nextRaw ?? '');
	const bad = passwordProblem(next);
	if (bad) throw new TeamError(bad);
	if (!findReset(token, now)) throw new TeamError('This reset link is not valid: it was used, replaced or has expired. Ask for a new one.');
	const hash = hashPassword(next); // slow on purpose, done before the write so the transaction stays short
	const d = db();
	const userId = d.transaction(() => {
		const r = findReset(token, now);
		if (!r) throw new TeamError('This reset link is not valid: it was used, replaced or has expired. Ask for a new one.');
		const used = d.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(now, r.id, now);
		if (used.changes !== 1) throw new TeamError('This reset link was just used.');
		d.prepare('UPDATE users SET password_hash = ?, last_login_at = ? WHERE id = ?').run(hash, now, r.userId);
		endUserSessions(r.userId);
		d.prepare('UPDATE password_resets SET revoked_at = ? WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL').run(now, r.userId);
		audit('user.password_reset', { detail: `${r.email} (with a reset link)` });
		return r.userId;
	})();
	return getUser(userId)!;
}

export const pendingResetUserIds = (now = Date.now()): Set<number> =>
	new Set((db().prepare('SELECT DISTINCT user_id FROM password_resets WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at > ?').all(now) as { user_id: number }[]).map((r) => r.user_id));
