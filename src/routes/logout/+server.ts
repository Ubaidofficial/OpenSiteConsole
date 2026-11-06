import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { endSession, SESSION_COOKIE } from '$lib/server/sessions';

export const POST: RequestHandler = ({ cookies }) => {
	// End the session on the server too: deleting the cookie alone would leave a copy of it valid.
	endSession(cookies.get(SESSION_COOKIE));
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/login');
};
