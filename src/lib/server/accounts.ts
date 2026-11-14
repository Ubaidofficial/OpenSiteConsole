import { audit, db } from './db';
import { applyDefaultsToNewSite } from './automation';
import { encrypt } from './crypto';
import { clientForAccount, type AccountLite } from './clients';
import { DEMO_ACCOUNTS } from './demo';

export interface AccountRow extends AccountLite {
	email: string;
	label: string | null;
	status: string;
	scopes: string;
	created_at: number;
}

export function listAccounts(): AccountRow[] {
	return db().prepare('SELECT id, google_sub, is_demo, email, label, status, scopes, created_at FROM accounts ORDER BY id').all() as AccountRow[];
}

export function upsertGoogleAccount(p: {
	sub: string;
	email: string;
	refreshToken?: string;
	accessToken: string;
	expiresIn: number;
	scope?: string;
}): number {
	const d = db();
	const existing = d.prepare('SELECT id, refresh_token_enc FROM accounts WHERE google_sub = ?').get(p.sub) as
		| { id: number; refresh_token_enc: string | null }
		| undefined;
	const refresh = p.refreshToken ? encrypt(p.refreshToken) : (existing?.refresh_token_enc ?? null);
	const access = encrypt(p.accessToken);
	const expires = Date.now() + p.expiresIn * 1000;
	if (existing) {
		d.prepare("UPDATE accounts SET email = ?, refresh_token_enc = ?, access_token_enc = ?, expires_at = ?, status = 'active', scopes = ? WHERE id = ?").run(
			p.email,
			refresh,
			access,
			expires,
			p.scope ?? '',
			existing.id
		);
		audit('account.reconnected', { accountId: existing.id, detail: p.email });
		return existing.id;
	}
	const r = d
		.prepare('INSERT INTO accounts (google_sub, email, refresh_token_enc, access_token_enc, expires_at, scopes, created_at) VALUES (?,?,?,?,?,?,?)')
		.run(p.sub, p.email, refresh, access, expires, p.scope ?? '', Date.now());
	audit('account.connected', { accountId: Number(r.lastInsertRowid), detail: p.email });
	return Number(r.lastInsertRowid);
}

export function removeAccount(id: number) {
	db().prepare('DELETE FROM accounts WHERE id = ?').run(id);
	audit('account.removed', { accountId: id });
}

export function relabelAccount(id: number, label: string) {
	db().prepare('UPDATE accounts SET label = ? WHERE id = ?').run(label.trim() || null, id);
}

/** Pull the property list for an account and upsert it. Returns the number of properties seen. */
export async function syncAccountSites(accountId: number): Promise<number> {
	const d = db();
	const acc = d.prepare('SELECT id, google_sub, is_demo FROM accounts WHERE id = ?').get(accountId) as AccountLite | undefined;
	if (!acc) throw new Error('Unknown account');
	const sites = await clientForAccount(acc).listSites();
	const upsert = d.prepare(
		`INSERT INTO sites (account_id, site_url, permission, created_at) VALUES (?,?,?,?)
		 ON CONFLICT(account_id, site_url) DO UPDATE SET permission = excluded.permission`
	);
	const seen = new Set<string>();
	const known = new Set((d.prepare('SELECT site_url FROM sites WHERE account_id = ?').all(accountId) as { site_url: string }[]).map((r) => r.site_url));
	d.transaction(() => {
		for (const s of sites) {
			upsert.run(accountId, s.siteUrl, s.permissionLevel, Date.now());
			seen.add(s.siteUrl);
			// A property seen for the first time starts with the automation defaults chosen on the Connect page (all off until chosen).
			if (!known.has(s.siteUrl)) {
				const row = d.prepare('SELECT id FROM sites WHERE account_id = ? AND site_url = ?').get(accountId, s.siteUrl) as { id: number } | undefined;
				if (row) applyDefaultsToNewSite(row.id);
			}
		}
		// Properties the account can no longer see stay in the warehouse but stop syncing.
		for (const row of d.prepare('SELECT id, site_url FROM sites WHERE account_id = ?').all(accountId) as { id: number; site_url: string }[]) {
			if (!seen.has(row.site_url)) d.prepare("UPDATE sites SET permission = 'none' WHERE id = ?").run(row.id);
		}
	})();
	return sites.length;
}

export async function ensureDemoAccounts() {
	const d = db();
	for (const a of DEMO_ACCOUNTS) {
		const row = d.prepare('SELECT id FROM accounts WHERE google_sub = ?').get(a.sub) as { id: number } | undefined;
		const id =
			row?.id ??
			Number(
				d
					.prepare("INSERT INTO accounts (google_sub, email, label, is_demo, created_at) VALUES (?,?,?,1,?)")
					.run(a.sub, a.email, a.label, Date.now()).lastInsertRowid
			);
		await syncAccountSites(id);
	}
}
