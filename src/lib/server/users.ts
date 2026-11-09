import { createHash, randomBytes } from 'node:crypto';
import { audit, db } from './db';
import { hashPassword, verifyPassword } from './password';
import { checkAdminPassword } from './adminauth';
import { safeEqual } from './crypto';
import { endUserSessions } from './sessions';
import { asMemberRole, type CurrentUser, type MemberRole } from './roles';

/**
 * Team members and their invites. There is no email sending in SEOConsole: an invite is a single-use link that the owner or an admin
 * copies and passes on. Only a SHA-256 of the link's token is stored, it expires after INVITE_DAYS, and accepting it is atomic.
 */
export const MIN_MEMBER_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 256;
export const INVITE_DAYS = 7;
export const INVITE_PREFIX = 'osci_';
const INVITE_TTL = INVITE_DAYS * 86_400_000;

export interface UserRow { id: number; email: string; name: string; role: MemberRole; site_ids: string | null; created_at: number; last_login_at: number | null; disabled: number }
export interface InviteRow { id: number; email: string; role: MemberRole; site_ids: string | null; created_at: number; expires_at: number; created_by: string | null }

export class TeamError extends Error {}

const USER_COLS = 'id, email, name, role, site_ids, created_at, last_login_at, disabled';
const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

export function normalizeEmail(v: unknown): string | null {
	const e = String(v ?? '').trim().toLowerCase();
	return e.length <= 254 && /^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(e) ? e : null;
}

/** Site lists are stored like an API key's: null = all sites. Admins always see all sites. */
function scopeJson(role: MemberRole, siteIds: number[] | null | undefined): string | null {
	if (role === 'admin' || !siteIds || !siteIds.length) return null;
	return JSON.stringify([...new Set(siteIds.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b));
}
export const scopeOf = (siteIds: string | null): number[] | null => (siteIds ? (JSON.parse(siteIds) as number[]) : null);
const who = (actor: CurrentUser | null | undefined) => (actor ? (actor.email ? `${actor.name} <${actor.email}>` : actor.name) : 'system');

export const listUsers = () => db().prepare(`SELECT ${USER_COLS} FROM users ORDER BY disabled, created_at`).all() as UserRow[];
export const getUser = (id: number) => db().prepare(`SELECT ${USER_COLS} FROM users WHERE id = ?`).get(id) as UserRow | undefined;

// A real scrypt hash of a random password, made once: checking a password against it costs the same as checking a real user's, so the
// time a wrong sign-in takes does not tell whether the email belongs to a member.
let dummy: string | null = null;
const dummyHash = () => (dummy ??= hashPassword(randomBytes(18).toString('base64url')));

/**
 * Sign-in. With an email: that member's password, and if that fails, the owner password (so the owner can sign in whatever the email field
 * holds). Without an email: the owner password only. Unknown email, wrong password and disabled member all look the same to the caller.
 */
export function checkLogin(emailRaw: string, password: string, now = Date.now()): { kind: 'owner' } | { kind: 'member'; user: UserRow } | null {
	const email = String(emailRaw ?? '').trim();
	if (email) {
		const e = normalizeEmail(email);
		const row = e ? (db().prepare('SELECT id, password_hash, disabled FROM users WHERE email = ?').get(e) as { id: number; password_hash: string; disabled: number } | undefined) : undefined;
		const ok = password.length <= MAX_PASSWORD_LENGTH && verifyPassword(password, row?.password_hash ?? dummyHash());
		if (row && ok && row.disabled === 0) {
			db().prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(now, row.id);
			return { kind: 'member', user: getUser(row.id)! };
		}
	}
	return checkAdminPassword(password) ? { kind: 'owner' } : null;
}

export function createInvite(o: { email: unknown; role: unknown; siteIds?: number[] | null; actor?: CurrentUser | null }, now = Date.now()): { id: number; token: string; email: string; role: MemberRole; expiresAt: number } {
	const email = normalizeEmail(o.email);
	if (!email) throw new TeamError('Enter a valid email address.');
	const role = asMemberRole(o.role);
	if (!role) throw new TeamError('Pick a role: admin, editor or viewer.');
	const d = db();
	if (d.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new TeamError('Someone with that email is already on the team.');
	const token = INVITE_PREFIX + randomBytes(32).toString('base64url');
	const expiresAt = now + INVITE_TTL;
	const id = d.transaction(() => {
		// A new invite replaces any pending one for the same address, so only the newest link works.
		const old = d.prepare('UPDATE invites SET revoked_at = ? WHERE email = ? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, email);
		if (old.changes) audit('invite.revoked', { detail: `${email} (replaced by a new invite) by ${who(o.actor)}` });
		const r = d.prepare('INSERT INTO invites (token_hash, email, role, site_ids, created_at, expires_at, created_by) VALUES (?,?,?,?,?,?,?)').run(tokenHash(token), email, role, scopeJson(role, o.siteIds), now, expiresAt, who(o.actor));
		return Number(r.lastInsertRowid);
	})();
	audit('invite.created', { detail: `${email} as ${role}${scopeJson(role, o.siteIds) ? ' (some sites)' : ''} by ${who(o.actor)}` });
	return { id, token, email, role, expiresAt };
}

/** A pending, unexpired invite for this token, or undefined. Shape and prefix are checked first; the stored hash is compared in constant time. */
export function findInvite(token: string, now = Date.now()): InviteRow | undefined {
	if (typeof token !== 'string' || !token.startsWith(INVITE_PREFIX) || token.length < 40 || token.length > 100) return undefined;
	const h = tokenHash(token);
	const row = db().prepare('SELECT id, token_hash, email, role, site_ids, created_at, expires_at, created_by, accepted_at, revoked_at FROM invites WHERE token_hash = ?').get(h) as
		| (InviteRow & { token_hash: string; accepted_at: number | null; revoked_at: number | null })
		| undefined;
	if (!row || !safeEqual(row.token_hash, h) || row.accepted_at !== null || row.revoked_at !== null || row.expires_at <= now) return undefined;
	const { token_hash: _h, accepted_at: _a, revoked_at: _r, ...invite } = row;
	return invite;
}

/** Accept an invite: makes the member and uses up the link, both or neither. Returns the new member. */
export function acceptInvite(token: string, o: { name: unknown; password: unknown }, now = Date.now()): UserRow {
	const name = String(o.name ?? '').replace(/\s+/g, ' ').trim();
	const password = String(o.password ?? '');
	if (!name || name.length > 80) throw new TeamError('Enter your name (up to 80 characters).');
	if (password.length < MIN_MEMBER_PASSWORD_LENGTH) throw new TeamError(`Choose a password of at least ${MIN_MEMBER_PASSWORD_LENGTH} characters.`);
	if (password.length > MAX_PASSWORD_LENGTH) throw new TeamError(`Passwords can be at most ${MAX_PASSWORD_LENGTH} characters.`);
	if (!findInvite(token, now)) throw new TeamError('This invite link is not valid: it was used, revoked or has expired. Ask for a new one.');
	const hash = hashPassword(password); // slow on purpose; done before the write so the transaction stays short
	const d = db();
	const userId = d.transaction(() => {
		const inv = findInvite(token, now);
		if (!inv) throw new TeamError('This invite link is not valid: it was used, revoked or has expired. Ask for a new one.');
		if (d.prepare('SELECT 1 FROM users WHERE email = ?').get(inv.email)) throw new TeamError('Someone with that email is already on the team.');
		// The guard in WHERE makes the link single-use even if two requests race.
		const used = d.prepare('UPDATE invites SET accepted_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?').run(now, inv.id, now);
		if (used.changes !== 1) throw new TeamError('This invite link was just used.');
		const r = d.prepare('INSERT INTO users (email, name, password_hash, role, site_ids, created_at, last_login_at, disabled) VALUES (?,?,?,?,?,?,?,0)').run(inv.email, name, hash, inv.role, inv.site_ids, now, now);
		const id = Number(r.lastInsertRowid);
		d.prepare('UPDATE invites SET accepted_user_id = ? WHERE id = ?').run(id, inv.id);
		audit('invite.accepted', { detail: `${inv.email} joined as ${inv.role} (invited by ${inv.created_by ?? 'unknown'})` });
		return id;
	})();
	return getUser(userId)!;
}

export const listPendingInvites = (now = Date.now()) =>
	db().prepare('SELECT id, email, role, site_ids, created_at, expires_at, created_by FROM invites WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ? ORDER BY created_at DESC').all(now) as InviteRow[];

export function revokeInvite(id: number, actor?: CurrentUser | null, now = Date.now()): boolean {
	const inv = db().prepare('SELECT email FROM invites WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL').get(id) as { email: string } | undefined;
	if (!inv) return false;
	db().prepare('UPDATE invites SET revoked_at = ? WHERE id = ?').run(now, id);
	audit('invite.revoked', { detail: `${inv.email} by ${who(actor)}` });
	return true;
}

/** Guards shared by every change to a member: it must exist, and nobody changes their own role or access (the owner is not a row at all). */
function target(id: number, actor?: CurrentUser | null): UserRow {
	const u = getUser(id);
	if (!u) throw new TeamError('Unknown team member.');
	if (actor && actor.id === u.id) throw new TeamError('You cannot change your own role or access. Ask the owner or another admin.');
	return u;
}

export function setUserRole(id: number, roleRaw: unknown, actor?: CurrentUser | null): UserRow {
	const role = asMemberRole(roleRaw);
	if (!role) throw new TeamError('Pick a role: admin, editor or viewer.');
	const u = target(id, actor);
	if (u.role === role) return u;
	db().prepare('UPDATE users SET role = ?, site_ids = ? WHERE id = ?').run(role, role === 'admin' ? null : u.site_ids, id);
	audit('user.role_changed', { detail: `${u.email}: ${u.role} -> ${role} by ${who(actor)}` });
	return getUser(id)!;
}

export function setUserSites(id: number, siteIds: number[] | null, actor?: CurrentUser | null): UserRow {
	const u = target(id, actor);
	if (u.role === 'admin' && siteIds?.length) throw new TeamError('Admins always see every site. Change the role first.');
	db().prepare('UPDATE users SET site_ids = ? WHERE id = ?').run(scopeJson(u.role, siteIds), id);
	audit('user.sites_changed', { detail: `${u.email}: ${siteIds?.length ? `${siteIds.length} site(s)` : 'all sites'} by ${who(actor)}` });
	return getUser(id)!;
}

export function setUserDisabled(id: number, disabled: boolean, actor?: CurrentUser | null): UserRow {
	const u = target(id, actor);
	db().prepare('UPDATE users SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
	if (disabled) endUserSessions(id);
	audit(disabled ? 'user.disabled' : 'user.enabled', { detail: `${u.email} by ${who(actor)}` });
	return getUser(id)!;
}

export function removeUser(id: number, actor?: CurrentUser | null) {
	const u = target(id, actor);
	endUserSessions(id);
	// Their chat conversations go with them: SQLite can give the next new member the same id, and with it this person's history.
	db().prepare('DELETE FROM chat_threads WHERE owner = ?').run(`user:${id}`);
	db().prepare('DELETE FROM chat_usage WHERE owner = ?').run(`user:${id}`);
	db().prepare('DELETE FROM users WHERE id = ?').run(id);
	audit('user.removed', { detail: `${u.email} by ${who(actor)}` });
}

/** A deleted site leaves every member's and invite's scope (SQLite can reuse its id for the next site). An emptied list means no sites, not all. */
export function forgetSiteForMembers(siteId: number) {
	for (const table of ['users', 'invites'] as const) {
		const rows = db().prepare(`SELECT id, site_ids FROM ${table} WHERE site_ids IS NOT NULL`).all() as { id: number; site_ids: string }[];
		const upd = db().prepare(`UPDATE ${table} SET site_ids = ? WHERE id = ?`);
		for (const r of rows) {
			const ids = JSON.parse(r.site_ids) as number[];
			if (ids.includes(siteId)) upd.run(JSON.stringify(ids.filter((x) => x !== siteId)), r.id);
		}
	}
}
