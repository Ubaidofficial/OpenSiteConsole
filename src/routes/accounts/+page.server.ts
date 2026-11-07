import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db, audit } from '$lib/server/db';
import { listAccounts, relabelAccount, removeAccount, syncAccountSites } from '$lib/server/accounts';
import { clientForAccount, type AccountLite } from '$lib/server/clients';
import { enqueueSiteSync } from '$lib/server/jobs';
import { intParam } from '$lib/server/params';
import { redirectUri } from '$lib/server/google';
import { VERIFY_METHODS, getVerificationToken, siteVerificationEnabled, verifyAndAdd, type VerifyMethod } from '$lib/server/siteverify';

export const load: PageServerLoad = ({ url }) => {
	const counts = db().prepare('SELECT account_id, COUNT(*) n FROM sites GROUP BY account_id').all() as { account_id: number; n: number }[];
	return {
		accounts: listAccounts().map((a) => ({ ...a, sites: counts.find((c) => c.account_id === a.id)?.n ?? 0 })),
		googleConfigured: !!(config.googleClientId && config.googleClientSecret),
		redirectUri: redirectUri(),
		readOnly: config.readOnly,
		siteVerification: siteVerificationEnabled(),
		connected: url.searchParams.get('connected'),
		error: url.searchParams.get('error')
	};
};

const acc = (id: number) => db().prepare('SELECT id, google_sub, is_demo FROM accounts WHERE id = ?').get(id) as AccountLite | undefined;

const methodOf = (v: FormDataEntryValue | null): VerifyMethod | null => (VERIFY_METHODS.includes(String(v) as VerifyMethod) ? (String(v) as VerifyMethod) : null);

export const actions: Actions = {
	/** Step 1 of proving ownership here: ask Google for the token to put on the site or in DNS. */
	verifyToken: async ({ request }) => {
		const f = await request.formData();
		const a = acc(intParam(f.get('id')));
		const method = methodOf(f.get('method'));
		if (!a) return fail(404, { error: 'Unknown account' });
		if (!method) return fail(400, { error: 'Pick a verification method.' });
		try {
			const r = await getVerificationToken(a.id, String(f.get('siteUrl') ?? ''), method);
			return { verify: { accountId: a.id, property: r.property.gscUrl, method: r.method, help: r.help } };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not get a token' });
		}
	},
	/** Step 2: once the token is in place, ask Google to check, then add the site to Search Console. */
	verifyNow: async ({ request }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: verifying and adding properties is disabled.' });
		const f = await request.formData();
		const a = acc(intParam(f.get('id')));
		const method = methodOf(f.get('method'));
		if (!a) return fail(404, { error: 'Unknown account' });
		if (!method) return fail(400, { error: 'Pick a verification method.' });
		try {
			const r = await verifyAndAdd(a, String(f.get('siteUrl') ?? ''), method);
			return { ok: `Verified ${r.property.gscUrl}${r.added ? ' and added it to Search Console' : ' (it was already in Search Console, or could not be added: check the properties list)'}. Data starts syncing; it takes a few minutes.` };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Verification failed' });
		}
	},
	refresh: async ({ request }) => {
		const id = intParam((await request.formData()).get('id'));
		try {
			const n = await syncAccountSites(id);
			const sites = db().prepare("SELECT id FROM sites WHERE account_id = ? AND permission NOT IN ('siteUnverifiedUser','none')").all(id) as { id: number }[];
			for (const s of sites) enqueueSiteSync(s.id, 'incremental');
			return { ok: `Found ${n} properties.` };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'Refresh failed' });
		}
	},
	relabel: async ({ request }) => {
		const f = await request.formData();
		relabelAccount(intParam(f.get('id')), String(f.get('label') ?? ''));
	},
	remove: async ({ request }) => {
		const f = await request.formData();
		if (f.get('confirm') !== 'yes') return fail(400, { error: 'Confirm removal.' });
		removeAccount(intParam(f.get('id')));
	},
	addSite: async ({ request }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: adding properties is disabled.' });
		const f = await request.formData();
		const id = intParam(f.get('id'));
		const siteUrl = String(f.get('siteUrl') ?? '').trim();
		if (!/^(https?:\/\/[^\s/]+\/?.*|sc-domain:[^\s/]+)$/.test(siteUrl)) return fail(400, { error: 'Use https://example.com/ or sc-domain:example.com' });
		const a = acc(id);
		if (!a) return fail(404, { error: 'Unknown account' });
		try {
			await clientForAccount(a).addSite(siteUrl);
			audit('site.added', { accountId: id, detail: siteUrl });
			await syncAccountSites(id);
			return { ok: `Added ${siteUrl}. Verify ownership in Search Console to unlock data.` };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'Could not add property' });
		}
	}
};
