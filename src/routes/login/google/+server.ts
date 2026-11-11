import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { safeNext } from '$lib/server/oauth-core';
import { startGoogle } from '$lib/server/googlelogin';

/** Start "Sign in with Google" (public: it is how someone who is not signed in gets in). Only sends the browser to Google; nothing changes here. */
export const GET: RequestHandler = ({ cookies, url }) => {
	if (!config.googleLogin) error(404, 'Sign in with Google is not set up on this server.');
	redirect(303, startGoogle(cookies, url, { next: safeNext(url.searchParams.get('next')) }));
};
