import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { profileLimiter } from '$lib/server/attempts';
import { createSession, SESSION_COOKIE } from '$lib/server/sessions';
import { changeOwnEmail, changeOwnName, changeOwnPassword, googleLinked, unlinkGoogle } from '$lib/server/selfservice';
import { startGoogle, GOOGLE_REFUSALS } from '$lib/server/googlelogin';
import { MIN_MEMBER_PASSWORD_LENGTH, TeamError, getUser } from '$lib/server/users';
import { ROLE_LABEL } from '$lib/server/roles';

export const load: PageServerLoad = ({ locals, url }) => {
	const me = locals.user!;
	const g = url.searchParams.get('google');
	if (me.id === null) return { owner: true as const, name: me.name, hasPassword: config.hasPassword, googleLogin: config.googleLogin, ownerEmails: config.ownerGoogleEmails, googleNote: null };
	const u = getUser(me.id);
	return {
		owner: false as const,
		name: u?.name ?? me.name,
		email: u?.email ?? me.email ?? '',
		roleLabel: ROLE_LABEL[me.role],
		minPassword: MIN_MEMBER_PASSWORD_LENGTH,
		googleLogin: config.googleLogin,
		googleLinked: googleLinked(me.id),
		googleNote: g === 'linked' ? { ok: true, text: 'Google account linked. You can now sign in with Google.' } : g ? { ok: false, text: GOOGLE_REFUSALS[g] ?? 'Google could not link that account.' } : null
	};
};

const msg = (e: unknown) => (e instanceof TeamError ? e.message : 'Something went wrong.');
/** A team member only: the owner has no row, and their password is ADMIN_PASSWORD in the environment. */
function member(locals: App.Locals) {
	const me = locals.user;
	if (!me || me.id === null) return null;
	return me.id;
}
const NOT_MEMBER = 'The owner password is set with ADMIN_PASSWORD (or ADMIN_PASSWORD_HASH) in the server’s environment. Change it there.';
const tooMany = (id: number) => profileLimiter.blocked(`member:${id}`);
const TOO_MANY = 'Too many wrong passwords. Try again in a few minutes.';

export const actions: Actions = {
	name: async ({ request, locals }) => {
		const id = member(locals);
		if (id === null) return fail(400, { error: NOT_MEMBER, section: 'name' });
		try {
			const u = changeOwnName(id, (await request.formData()).get('name'));
			return { ok: `Your name is now ${u.name}.`, section: 'name' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'name' });
		}
	},
	email: async ({ request, locals }) => {
		const id = member(locals);
		if (id === null) return fail(400, { error: NOT_MEMBER, section: 'email' });
		if (tooMany(id)) return fail(429, { error: TOO_MANY, section: 'email' });
		const f = await request.formData();
		const hadGoogle = googleLinked(id);
		try {
			const u = changeOwnEmail(id, f.get('current'), f.get('email'));
			profileLimiter.clear(`member:${id}`);
			return { ok: `Your sign-in email is now ${u.email}.${hadGoogle ? ' Your Google link was dropped: link it again below.' : ''}`, section: 'email' };
		} catch (e) {
			if (e instanceof TeamError && /current password/.test(e.message)) profileLimiter.fail(`member:${id}`);
			return fail(400, { error: msg(e), section: 'email' });
		}
	},
	password: async ({ request, locals, cookies, url }) => {
		const id = member(locals);
		if (id === null) return fail(400, { error: NOT_MEMBER, section: 'password' });
		if (tooMany(id)) return fail(429, { error: TOO_MANY, section: 'password' });
		const f = await request.formData();
		if (String(f.get('password') ?? '') !== String(f.get('confirm') ?? '')) return fail(400, { error: 'The two new passwords are not the same.', section: 'password' });
		try {
			changeOwnPassword(id, f.get('current'), f.get('password'));
		} catch (e) {
			if (e instanceof TeamError && /current password/.test(e.message)) profileLimiter.fail(`member:${id}`);
			return fail(400, { error: msg(e), section: 'password' });
		}
		profileLimiter.clear(`member:${id}`);
		// Every session of theirs ended with the old password; this browser gets a new one so they stay signed in here.
		const session = createSession(Date.now(), id);
		cookies.set(SESSION_COOKIE, session.id, { path: '/', httpOnly: true, sameSite: 'lax', secure: url.protocol === 'https:', maxAge: session.maxAgeSeconds });
		return { ok: 'Password changed. You were signed out of every other browser.', section: 'password' };
	},
	/** Send the member to Google to prove which account to link. A form (POST), so another site cannot start it for them. */
	linkGoogle: async ({ locals, cookies, url }) => {
		const id = member(locals);
		if (id === null) return fail(400, { error: NOT_MEMBER, section: 'google' });
		if (!config.googleLogin) return fail(400, { error: 'Sign in with Google is not set up on this server.', section: 'google' });
		redirect(303, startGoogle(cookies, url, { linkUserId: id }));
	},
	unlinkGoogle: async ({ locals }) => {
		const id = member(locals);
		if (id === null) return fail(400, { error: NOT_MEMBER, section: 'google' });
		try {
			unlinkGoogle(id);
			return { ok: 'Google account unlinked. Sign in with your email and password.', section: 'google' };
		} catch (e) {
			return fail(400, { error: msg(e), section: 'google' });
		}
	}
};
