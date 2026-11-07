import { randomBytes } from 'node:crypto';
import { db } from './db';

/**
 * A second, separate call before anything that cannot be undone by calling the tool again. The first call changes nothing: it shows what the
 * action would touch and hands back a token; the action runs only on a second call that presents that token. A token works once (the first call that
 * presents it spends it, right or wrong), for ten minutes, for the API key that was given it, and only for the same tool, site and target.
 *
 * What this is and is not: it makes a single mistaken or injected call unable to delete anything, and it puts a pause where a person can look at what is
 * about to go (an MCP client normally asks before each tool call). It does not prove a person agreed: an agent that makes both calls itself gets through,
 * which is why the permission to do it is a separate, higher level that is not the default.
 */
export const CONFIRM_TTL_MS = 10 * 60_000;
export const MAX_OUTSTANDING = 20;

export interface Bound { keyId: number; tool: string; siteId: number; target: string }
interface Stored extends Bound { expires: number }
const kvKey = (token: string) => `confirm:${token}`;

function outstanding(now: number): { key: string; v: Stored }[] {
	const rows = db().prepare("SELECT key, value FROM kv WHERE key LIKE 'confirm:%'").all() as { key: string; value: string }[];
	const live: { key: string; v: Stored }[] = [];
	for (const r of rows) {
		let v: Stored | null = null;
		try {
			v = JSON.parse(r.value) as Stored;
		} catch {
			/* a damaged row is dropped below */
		}
		if (v && typeof v.expires === 'number' && v.expires > now) live.push({ key: r.key, v });
		else db().prepare('DELETE FROM kv WHERE key = ?').run(r.key);
	}
	return live;
}

export function issueConfirmation(b: Bound, now = Date.now()): { token: string; expiresAt: number } {
	const live = outstanding(now);
	// Asking again for the same action replaces the earlier token rather than piling up.
	for (const x of live) if (x.v.keyId === b.keyId && x.v.tool === b.tool && x.v.siteId === b.siteId && x.v.target === b.target) db().prepare('DELETE FROM kv WHERE key = ?').run(x.key);
	if (live.filter((x) => x.v.keyId === b.keyId).length >= MAX_OUTSTANDING) throw new Error(`This key has ${MAX_OUTSTANDING} confirmations waiting. Use or let them lapse (${CONFIRM_TTL_MS / 60_000} minutes) before asking for more.`);
	const token = 'cf_' + randomBytes(18).toString('base64url');
	const expiresAt = now + CONFIRM_TTL_MS;
	db().prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run(kvKey(token), JSON.stringify({ ...b, expires: expiresAt } satisfies Stored));
	return { token, expiresAt };
}

export type Consumed = { ok: true } | { ok: false; reason: string };

/** Spend a token. It is gone after this call whether or not it matched. */
export function consumeConfirmation(token: string, b: Bound, now = Date.now()): Consumed {
	const row = db().prepare('SELECT value FROM kv WHERE key = ?').get(kvKey(token)) as { value: string } | undefined;
	if (!row) return { ok: false, reason: 'That confirmation token is unknown or was already used.' };
	db().prepare('DELETE FROM kv WHERE key = ?').run(kvKey(token));
	let v: Stored;
	try {
		v = JSON.parse(row.value) as Stored;
	} catch {
		return { ok: false, reason: 'That confirmation token is damaged.' };
	}
	if (v.expires <= now) return { ok: false, reason: `That confirmation token expired (they last ${CONFIRM_TTL_MS / 60_000} minutes).` };
	if (v.keyId !== b.keyId) return { ok: false, reason: 'That confirmation token was issued to a different API key.' };
	if (v.tool !== b.tool || v.siteId !== b.siteId || v.target !== b.target) return { ok: false, reason: 'That confirmation token was issued for a different action, site or target.' };
	return { ok: true };
}
