import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { queueDepth } from '$lib/server/jobs';
import { ROLE_LABEL } from '$lib/server/roles';

export const load: LayoutServerLoad = ({ locals }) => {
	// Before sign-in the login page gets nothing about the installation (account counts, queue depth, whether Google is set up).
	if (config.hasPassword && !locals.authed) return { demo: false, readOnly: false, hasPassword: true, authed: false, user: null, accounts: 0, revoked: 0, googleConfigured: false, queue: { waiting: 0, active: 0 } };
	const u = locals.user;
	const accounts = (db().prepare('SELECT COUNT(*) n FROM accounts').get() as { n: number }).n;
	const revoked = (db().prepare("SELECT COUNT(*) n FROM accounts WHERE status = 'revoked'").get() as { n: number }).n;
	return {
		demo: config.demo,
		readOnly: config.readOnly,
		hasPassword: config.hasPassword,
		authed: locals.authed,
		/** Who is signed in, for the header and for leaving out links a role or a site limit cannot use (the server refuses them anyway). */
		user: u ? { name: u.name, email: u.email, role: u.role, roleLabel: ROLE_LABEL[u.role], scoped: u.siteIds !== null } : null,
		accounts,
		revoked,
		googleConfigured: !!(config.googleClientId && config.googleClientSecret),
		queue: queueDepth()
	};
};
