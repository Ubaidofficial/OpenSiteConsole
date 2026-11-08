import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { clientKey } from '$lib/server/guard';
import { inviteLimiter } from '$lib/server/attempts';
import { createSession, endSession, SESSION_COOKIE } from '$lib/server/sessions';
import { acceptInvite, findInvite, MIN_MEMBER_PASSWORD_LENGTH, TeamError } from '$lib/server/users';
import { ROLE_LABEL } from '$lib/server/roles';

const TOO_MANY = 'Too many invalid invite links from your address. Try again in a few minutes.';

/** Public (no session needed): the link itself is the credential. Unknown, used, revoked and expired links all count against the visitor's limit. */
export const load: PageServerLoad = ({ params, getClientAddress, locals }) => {
	if (!config.hasPassword) return { valid: false as const, reason: 'Invites need ADMIN_PASSWORD to be set: without it SEOConsole only answers this machine.' };
	const ip = clientKey(getClientAddress);
	if (inviteLimiter.blocked(ip)) error(429, TOO_MANY);
	const inv = findInvite(params.token);
	if (!inv) {
		inviteLimiter.fail(ip);
		return { valid: false as const, reason: 'This invite link is not valid: it was used, revoked or has expired. Ask whoever invited you for a new one.' };
	}
	return { valid: true as const, email: inv.email, role: ROLE_LABEL[inv.role], expiresAt: inv.expires_at, minLength: MIN_MEMBER_PASSWORD_LENGTH, signedInAs: locals.user?.name ?? null };
};

export const actions: Actions = {
	default: async ({ params, request, cookies, getClientAddress, url }) => {
		if (!config.hasPassword) return fail(400, { error: 'Invites need ADMIN_PASSWORD to be set.' });
		const ip = clientKey(getClientAddress);
		if (inviteLimiter.blocked(ip)) return fail(429, { error: TOO_MANY });
		if (!findInvite(params.token)) {
			inviteLimiter.fail(ip);
			return fail(400, { error: 'This invite link is not valid: it was used, revoked or has expired.' });
		}
		const f = await request.formData();
		let userId: number;
		try {
			userId = acceptInvite(params.token, { name: f.get('name'), password: f.get('password') }).id;
		} catch (e) {
			if (e instanceof TeamError) return fail(400, { error: e.message, name: String(f.get('name') ?? '').slice(0, 80) });
			throw e;
		}
		inviteLimiter.clear(ip);
		endSession(cookies.get(SESSION_COOKIE)); // whoever was signed in on this browser is signed out first
		const session = createSession(Date.now(), userId);
		cookies.set(SESSION_COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: session.maxAgeSeconds });
		redirect(303, '/');
	}
};
