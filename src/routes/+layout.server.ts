import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { db } from '$lib/server/db';
import { queueDepth } from '$lib/server/jobs';

export const load: LayoutServerLoad = ({ locals }) => {
	const accounts = (db().prepare('SELECT COUNT(*) n FROM accounts').get() as { n: number }).n;
	const revoked = (db().prepare("SELECT COUNT(*) n FROM accounts WHERE status = 'revoked'").get() as { n: number }).n;
	return {
		demo: config.demo,
		readOnly: config.readOnly,
		hasPassword: !!config.adminPassword,
		authed: locals.authed,
		accounts,
		revoked,
		googleConfigured: !!(config.googleClientId && config.googleClientSecret),
		queue: queueDepth()
	};
};
