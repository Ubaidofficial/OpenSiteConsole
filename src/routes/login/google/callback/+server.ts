import { error, redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { clientKey } from '$lib/server/guard';
import { createSession, endSession, SESSION_COOKIE } from '$lib/server/sessions';
import { finishGoogle } from '$lib/server/googlelogin';

/** Where Google sends the browser back to. Public, like the sign-in form: the state cookie ties it to the browser that started it. */
export const GET: RequestHandler = async ({ url, cookies, locals, getClientAddress }) => {
	if (!config.googleLogin) error(404, 'Sign in with Google is not set up on this server.');
	const r = await finishGoogle(cookies, url, locals.user, clientKey(getClientAddress));
	if (!r.ok) redirect(303, r.link ? `/profile?google=${encodeURIComponent(r.code)}` : `/login?google=${encodeURIComponent(r.code)}`);
	if (r.kind === 'linked') redirect(303, '/profile?google=linked');
	endSession(cookies.get(SESSION_COOKIE)); // whoever was signed in on this browser is signed out first
	const session = createSession(Date.now(), r.userId);
	cookies.set(SESSION_COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: session.maxAgeSeconds });
	redirect(303, r.next ?? '/');
};
