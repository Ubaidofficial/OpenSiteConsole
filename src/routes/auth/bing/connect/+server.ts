import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config, env } from '$lib/server/config';
import { BING_AUTHORIZE } from '$lib/server/bing';
import { newState } from '$lib/server/google';

/** Optional one-click Bing sign-in. Requires an OAuth client registered in Bing Webmaster Tools → Settings → API Access. */
export const GET: RequestHandler = ({ cookies, url }) => {
	const id = env('BING_CLIENT_ID');
	if (!id || !env('BING_CLIENT_SECRET')) error(400, 'Set BING_CLIENT_ID and BING_CLIENT_SECRET first (see README), or paste a Bing API key on the Connect page.');
	const state = newState();
	cookies.set('osc_bing_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 });
	const q = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: `${config.origin}/auth/bing/callback`, scope: 'webmaster.read', state });
	redirect(303, `${BING_AUTHORIZE}?${q}`);
};
