import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { clientKey } from '$lib/server/guard';
import { resetLimiter } from '$lib/server/attempts';
import { createSession, endSession, SESSION_COOKIE } from '$lib/server/sessions';
import { completePasswordReset, findReset } from '$lib/server/selfservice';
import { MIN_MEMBER_PASSWORD_LENGTH, TeamError } from '$lib/server/users';

const TOO_MANY = 'Too many invalid reset links from your address. Try again in a few minutes.';

/** Public (no session needed): the link itself is the credential. Unknown, used, replaced and expired links all count against the visitor's limit. */
export const load: PageServerLoad = ({ params, getClientAddress }) => {
	if (!config.hasPassword) return { valid: false as const, reason: 'Password resets need ADMIN_PASSWORD to be set.' };
	const ip = clientKey(getClientAddress);
	if (resetLimiter.blocked(ip)) error(429, TOO_MANY);
	const r = findReset(params.token);
	if (!r) {
		resetLimiter.fail(ip);
		return { valid: false as const, reason: 'This reset link is not valid: it was used, replaced or has expired. Ask an admin for a new one.' };
	}
	return { valid: true as const, email: r.email, expiresAt: r.expiresAt, minLength: MIN_MEMBER_PASSWORD_LENGTH };
};

export const actions: Actions = {
	default: async ({ params, request, cookies, getClientAddress, url }) => {
		if (!config.hasPassword) return fail(400, { error: 'Password resets need ADMIN_PASSWORD to be set.' });
		const ip = clientKey(getClientAddress);
		if (resetLimiter.blocked(ip)) return fail(429, { error: TOO_MANY });
		if (!findReset(params.token)) {
			resetLimiter.fail(ip);
			return fail(400, { error: 'This reset link is not valid: it was used, replaced or has expired.' });
		}
		const f = await request.formData();
		if (String(f.get('password') ?? '') !== String(f.get('confirm') ?? '')) return fail(400, { error: 'The two passwords are not the same.' });
		let userId: number;
		try {
			userId = completePasswordReset(params.token, f.get('password')).id;
		} catch (e) {
			if (e instanceof TeamError) return fail(400, { error: e.message });
			throw e;
		}
		resetLimiter.clear(ip);
		endSession(cookies.get(SESSION_COOKIE)); // whoever was signed in on this browser is signed out first
		const session = createSession(Date.now(), userId);
		cookies.set(SESSION_COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: session.maxAgeSeconds });
		redirect(303, '/');
	}
};
