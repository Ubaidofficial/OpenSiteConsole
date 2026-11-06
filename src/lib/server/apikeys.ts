import { createHash, randomBytes } from 'node:crypto';
import { db } from './db';

export const KEY_PREFIX = 'osc_';
const hash = (k: string) => createHash('sha256').update(k).digest('hex');

export interface ApiKeyRow { id: number; name: string; prefix: string; site_ids: string | null; created_at: number; last_used_at: number | null }

/** The plaintext key is returned once; only its SHA-256 is stored. */
export function createApiKey(name: string, siteIds: number[] | null): { id: number; key: string } {
	const key = KEY_PREFIX + randomBytes(24).toString('base64url');
	const r = db()
		.prepare('INSERT INTO api_keys (name, prefix, hash, site_ids, created_at) VALUES (?,?,?,?,?)')
		.run(name.trim().slice(0, 60) || 'API key', key.slice(0, 8), hash(key), siteIds && siteIds.length ? JSON.stringify(siteIds) : null, Date.now());
	return { id: Number(r.lastInsertRowid), key };
}

export const listApiKeys = () => db().prepare('SELECT id, name, prefix, site_ids, created_at, last_used_at FROM api_keys ORDER BY id DESC').all() as ApiKeyRow[];
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

/** Returns the key's site scope (null = all sites) or undefined if the key is unknown. */
export function authenticate(request: Request): { id: number; scope: number[] | null } | undefined {
	const header = request.headers.get('x-api-key') ?? request.headers.get('authorization')?.replace(/^Bearer /i, '') ?? '';
	if (!header.startsWith(KEY_PREFIX)) return undefined;
	const row = db().prepare('SELECT id, site_ids FROM api_keys WHERE hash = ?').get(hash(header)) as { id: number; site_ids: string | null } | undefined;
	if (!row) return undefined;
	db().prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(Date.now(), row.id);
	return { id: row.id, scope: row.site_ids ? (JSON.parse(row.site_ids) as number[]) : null };
}
