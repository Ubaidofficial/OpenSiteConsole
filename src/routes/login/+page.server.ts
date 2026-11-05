import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { safeEqual, signValue } from '$lib/server/crypto';

const attempts = new Map<string, { n: number; reset: number }>();

export const load: PageServerLoad = ({ locals }) => {
	if (locals.authed && config.adminPassword) redirect(303, '/');
	if (!config.adminPassword) redirect(303, '/');
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const ip = getClientAddress();
		const a = attempts.get(ip);
		if (a && a.reset > Date.now() && a.n >= 5) return fail(429, { error: 'Too many attempts. Try again in a few minutes.' });
		const pw = String((await request.formData()).get('password') ?? '');
		if (!config.adminPassword || !safeEqual(pw, config.adminPassword)) {
			const cur = a && a.reset > Date.now() ? a : { n: 0, reset: Date.now() + 15 * 60_000 };
			attempts.set(ip, { n: cur.n + 1, reset: cur.reset });
			return fail(401, { error: 'Wrong password.' });
		}
		attempts.delete(ip);
		cookies.set('osc_session', signValue('ok'), {
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: url.protocol === 'https:',
			maxAge: 60 * 60 * 24 * 14
		});
		redirect(303, '/');
	}
};
