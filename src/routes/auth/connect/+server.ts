import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { buildAuthUrl, newState } from '$lib/server/google';
import { stateWithOrigin } from '$lib/oauthrelay';

export const GET: RequestHandler = ({ cookies, url }) => {
	if (!config.googleClientId || !config.googleClientSecret) error(400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see .env.example).');
	// Behind the hosted plan's shared redirect address the state also carries this instance's origin, so the relay can send the browser back.
	const state = config.oauthRedirectUri ? stateWithOrigin(newState(), config.origin) : newState();
	cookies.set('osc_oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: 600 });
	redirect(303, buildAuthUrl(state));
};
