import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config, env } from '$lib/server/config';
import { BING_TOKEN } from '$lib/server/bing';
import { autoMatchBing, saveBingOAuth } from '$lib/server/connect';
import { removeIntegration } from '$lib/server/links';
import { safeEqual } from '$lib/server/crypto';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const expected = cookies.get('osc_bing_state');
	cookies.delete('osc_bing_state', { path: '/' });
	if (!expected || !safeEqual(url.searchParams.get('state') ?? '', expected)) error(400, 'OAuth state mismatch. Start again from the Connect page.');
	if (url.searchParams.get('error')) redirect(303, `/connect?flash=${encodeURIComponent('Bing: ' + url.searchParams.get('error'))}`);
	const code = url.searchParams.get('code');
	if (!code) error(400, 'Missing authorization code');
	const res = await fetch(BING_TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ client_id: env('BING_CLIENT_ID'), client_secret: env('BING_CLIENT_SECRET'), code, grant_type: 'authorization_code', redirect_uri: `${config.origin}/auth/bing/callback` })
	});
	const tokens = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number };
	if (!res.ok || !tokens.access_token) error(502, 'Bing did not return a token. Check the client ID/secret and that the redirect URI matches exactly.');
	const id = saveBingOAuth({ access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_in: tokens.expires_in }, 'Bing (OAuth)');
	try {
		const r = await autoMatchBing(id);
		redirect(303, `/connect?flash=${encodeURIComponent(`Bing connected. Linked ${r.matched} site(s).`)}`);
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e && (e as { status: number }).status === 303) throw e;
		removeIntegration(id);
		error(502, 'Connected to Bing but could not read your sites: ' + (e instanceof Error ? e.message : 'unknown error'));
	}
};
