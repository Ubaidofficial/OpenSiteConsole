import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';

export const KEY_PREFIX = 'osc_';
const hash = (k: string) => createHash('sha256').update(k).digest('hex');

/**
 * read: look at data only. submit: also push URLs and sitemaps to search engines, set up IndexNow and ask for checks. delete: also the few things that
 * cannot be undone by calling the tool again (remove a sitemap from Search Console, throw away queued submissions). Each level includes the one before it.
 * No level can delete your data or change a site's content or settings.
 */
export type Permission = 'read' | 'submit' | 'delete';
const RANK: Record<Permission, number> = { read: 0, submit: 1, delete: 2 };
export const asPermission = (v: unknown): Permission => (v === 'delete' ? 'delete' : v === 'submit' ? 'submit' : 'read');
/** Whether a key with permission `have` may do what needs `need`. */
export const permits = (have: Permission, need: Permission) => RANK[have] >= RANK[need];

export interface ApiKeyRow { id: number; name: string; prefix: string; site_ids: string | null; created_at: number; last_used_at: number | null; expires_at: number | null; permission: Permission }

/** The plaintext key is returned once; only its SHA-256 is stored. `expiresAt` is for OAuth access tokens; keys made by hand never expire. */
export function createApiKey(name: string, siteIds: number[] | null, expiresAt: number | null = null, permission: Permission | boolean = 'read'): { id: number; key: string } {
	const key = KEY_PREFIX + randomBytes(24).toString('base64url');
	const r = db()
		.prepare('INSERT INTO api_keys (name, prefix, hash, site_ids, created_at, expires_at, permission) VALUES (?,?,?,?,?,?,?)')
		.run(name.trim().slice(0, 60) || 'API key', key.slice(0, 8), hash(key), siteIds && siteIds.length ? JSON.stringify(siteIds) : null, Date.now(), expiresAt, asPermission(permission === true ? 'submit' : permission));
	return { id: Number(r.lastInsertRowid), key };
}

/** Give an existing key a new secret and expiry (an OAuth refresh). The old secret stops working at once. */
export function rotateApiKey(id: number, expiresAt: number): string | undefined {
	const key = KEY_PREFIX + randomBytes(24).toString('base64url');
	const r = db().prepare('UPDATE api_keys SET hash = ?, prefix = ?, expires_at = ? WHERE id = ?').run(hash(key), key.slice(0, 8), expiresAt, id);
	return r.changes === 1 ? key : undefined;
}

export const listApiKeys = () => db().prepare('SELECT id, name, prefix, site_ids, created_at, last_used_at, expires_at, permission FROM api_keys ORDER BY id DESC').all() as ApiKeyRow[];

/** Change what an existing key may do (an OAuth sign-in's token keeps it when it renews). */
export const setKeyPermission = (id: number, permission: Permission) => db().prepare('UPDATE api_keys SET permission = ? WHERE id = ?').run(asPermission(permission), id).changes === 1;
/** The older on/off switch: on means the submit level, off means read. A key at the delete level is not touched by turning "on". */
export const setKeyCanWrite = (id: number, on: boolean) => {
	const cur = db().prepare('SELECT permission FROM api_keys WHERE id = ?').get(id) as { permission: string } | undefined;
	if (!cur) return false;
	return setKeyPermission(id, on ? (cur.permission === 'delete' ? 'delete' : 'submit') : 'read');
};
/**
 * Take a deleted site out of every key's scope. SQLite reuses the id of the newest site once it is deleted, so a key scoped to
 * that id would otherwise silently start seeing whatever site is added next. A key left with no sites sees nothing (an empty
 * list is not "all sites"; only a key stored with no list at all is).
 */
export function forgetSite(siteId: number) {
	const keys = db().prepare('SELECT id, site_ids FROM api_keys WHERE site_ids IS NOT NULL').all() as { id: number; site_ids: string }[];
	const upd = db().prepare('UPDATE api_keys SET site_ids = ? WHERE id = ?');
	for (const k of keys) {
		const ids = JSON.parse(k.site_ids) as number[];
		if (ids.includes(siteId)) upd.run(JSON.stringify(ids.filter((x) => x !== siteId)), k.id);
	}
}

export const deleteApiKey = (id: number) => void db().prepare('DELETE FROM api_keys WHERE id = ?').run(id);

/** The credential a request carries, if any (an X-API-Key header or a bearer token), whether or not it is valid. */
export const presentedKey = (request: Request): string => request.headers.get('x-api-key') ?? request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';

/** Returns the key's site scope (null = all sites) and permission, or undefined if the key is unknown or has expired. */
export function authenticate(request: Request, now = Date.now()): { id: number; scope: number[] | null; permission: Permission; canWrite: boolean; name: string } | undefined {
	const header = presentedKey(request);
	if (!header.startsWith(KEY_PREFIX)) return undefined;
	const row = db().prepare('SELECT id, name, site_ids, expires_at, permission FROM api_keys WHERE hash = ?').get(hash(header)) as { id: number; name: string; site_ids: string | null; expires_at: number | null; permission: string } | undefined;
	if (!row) return undefined;
	if (row.expires_at != null && row.expires_at <= now) return undefined;
	db().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
	return { id: row.id, scope: row.site_ids ? (JSON.parse(row.site_ids) as number[]) : null, permission: asPermission(row.permission), canWrite: permits(asPermission(row.permission), 'submit'), name: row.name };
}
