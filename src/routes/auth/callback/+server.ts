import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { exchangeCode } from '$lib/server/google';
import { syncAccountSites, upsertGoogleAccount } from '$lib/server/accounts';
import { enqueueSiteSync } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { safeEqual } from '$lib/server/crypto';
import { safeReturn } from '$lib/server/guard';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const expected = cookies.get('osc_oauth_state');
	cookies.delete('osc_oauth_state', { path: '/' });
	const state = url.searchParams.get('state') ?? '';
	if (!expected || !safeEqual(state, expected)) error(400, 'OAuth state mismatch. Start the connection again.');
	const err = url.searchParams.get('error');
	if (err) redirect(303, `/accounts?error=${encodeURIComponent(err)}`);
	const code = url.searchParams.get('code');
	if (!code) error(400, 'Missing authorization code');

	const { tokens, sub, email } = await exchangeCode(code);
	const id = upsertGoogleAccount({ sub, email, refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresIn: tokens.expires_in, scope: tokens.scope });
	await syncAccountSites(id);
	const sites = db().prepare("SELECT id FROM sites WHERE account_id = ? AND permission NOT IN ('siteUnverifiedUser','none')").all(id) as { id: number }[];
	for (const s of sites) enqueueSiteSync(s.id, 'auto');
	const back = safeReturn(cookies.get('osc_oauth_back') ?? null);
	cookies.delete('osc_oauth_back', { path: '/' });
	redirect(303, back ? `${back}${back.includes('?') ? '&' : '?'}granted=1` : '/accounts?connected=' + encodeURIComponent(email));
};
