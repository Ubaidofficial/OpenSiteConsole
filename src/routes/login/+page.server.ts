import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { safeEqual } from '$lib/server/crypto';
import { createSession, SESSION_COOKIE } from '$lib/server/sessions';

const attempts = new Map<string, { n: number; reset: number }>();
const MAX_TRACKED = 5000;
/** Forget expired entries; if an attacker still fills the table, start over rather than grow without bound. */
function prune(now: number) {
	if (attempts.size < MAX_TRACKED) return;
	for (const [k, v] of attempts) if (v.reset <= now) attempts.delete(k);
	if (attempts.size >= MAX_TRACKED) attempts.clear();
}

export const load: PageServerLoad = ({ locals }) => {
	if (locals.authed && config.adminPassword) redirect(303, '/');
	if (!config.adminPassword) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const ip = getClientAddress();
		prune(Date.now());
		const a = attempts.get(ip);
		if (a && a.reset > Date.now() && a.n >= 5) return fail(429, { error: 'Too many attempts. Try again in a few minutes.' });
		const pw = String((await request.formData()).get('password') ?? '');
		if (!config.adminPassword || !safeEqual(pw, config.adminPassword)) {
			const cur = a && a.reset > Date.now() ? a : { n: 0, reset: Date.now() + 15 * 60_000 };
			attempts.set(ip, { n: cur.n + 1, reset: cur.reset });
			return fail(401, { error: 'Wrong password.' });
		}
		attempts.delete(ip);
		const session = createSession();
		cookies.set(SESSION_COOKIE, session.id, {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: session.maxAgeSeconds
		});
		redirect(303, '/');
	}
};
