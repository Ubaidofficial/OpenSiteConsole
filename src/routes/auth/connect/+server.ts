import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { buildAuthUrl, newState } from '$lib/server/google';
import { GTM_WRITE_SCOPES } from '$lib/server/gtmwrite';
import { SETUP_SCOPES } from '$lib/server/setup';
import { stateWithOrigin } from '$lib/oauthrelay';
import { safeReturn } from '$lib/server/guard';

export const GET: RequestHandler = ({ cookies, url }) => {
	if (!config.googleClientId || !config.googleClientSecret) error(400, 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first (see .env.example).');
	// Opt-in extra permissions, never on a read-only server.
	//   ?grant=gtm-write: edit and publish Tag Manager (to install Clarity).
	//   ?grant=setup:     the same, plus creating Google Analytics properties (the "Set up GA4 & Tag Manager" button).
	const grant = url.searchParams.get('grant');
	const extra = config.readOnly ? [] : grant === 'setup' ? SETUP_SCOPES : grant === 'gtm-write' ? GTM_WRITE_SCOPES : [];
	// Behind the hosted plan's shared redirect address the state also carries this instance's origin, so the relay can send the browser back.
	const state = config.oauthRedirectUri ? stateWithOrigin(newState(), config.origin) : newState();
	const secure = url.protocol === 'https:';
	cookies.set('osc_oauth_state', state, { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: 600 });
	const back = safeReturn(url.searchParams.get('back'));
	// set (or cleared, maxAge 0) on every start, so an old return address never outlives the sign-in it was made for
	cookies.set('osc_oauth_back', back ?? '', { path: '/', httpOnly: true, sameSite: 'lax', secure, maxAge: back ? 600 : 0 });
	redirect(303, buildAuthUrl(state, extra));
};
