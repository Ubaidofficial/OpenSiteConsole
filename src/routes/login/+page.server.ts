import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { clientKey } from '$lib/server/guard';
import { safeNext } from '$lib/server/oauth-core';
import { createSession, SESSION_COOKIE } from '$lib/server/sessions';
import { loginLimiter } from '$lib/server/attempts';
import { checkLogin } from '$lib/server/users';
import { GOOGLE_REFUSALS } from '$lib/server/googlelogin';

export const load: PageServerLoad = ({ locals, url }) => {
	const next = safeNext(url.searchParams.get('next')) ?? '/';
	if (locals.authed && config.hasPassword) redirect(303, next);
	if (!config.hasPassword) redirect(303, next);
	const g = url.searchParams.get('google');
	return {
		googleLogin: config.googleLogin,
		next: url.searchParams.get('next') ? next : null,
		googleError: g ? (GOOGLE_REFUSALS[g] ?? GOOGLE_REFUSALS.failed) : null
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const ip = clientKey(getClientAddress);
		if (loginLimiter.blocked(ip)) return fail(429, { error: 'Too many attempts. Try again in a few minutes.' });
		const f = await request.formData();
		const email = String(f.get('email') ?? '');
		const who = checkLogin(email, String(f.get('password') ?? ''));
		if (!who) {
			loginLimiter.fail(ip);
			// One message for every failure, so the form never tells whether an email belongs to a team member.
			return fail(401, { error: email.trim() ? 'Wrong email or password.' : 'Wrong password.', email: email.trim().slice(0, 254) });
		}
		loginLimiter.clear(ip);
		const session = createSession(Date.now(), who.kind === 'member' ? who.user.id : null);
		cookies.set(SESSION_COOKIE, session.id, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: session.maxAgeSeconds
		});
		redirect(303, safeNext(url.searchParams.get('next')) ?? '/');
	}
};
