import type { Handle, ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { validSession, SESSION_COOKIE } from '$lib/server/sessions';
import { isLocalRequest } from '$lib/server/guard';
import { securityHeaders } from '$lib/server/headers';
import { ensureDemoAccounts } from '$lib/server/accounts';
import { startScheduler } from '$lib/server/jobs';
import { db } from '$lib/server/db';

let booted: Promise<void> | null = null;
function boot() {
	return (booted ??= (async () => {
		db();
		if (config.demo) await ensureDemoAccounts();
		startScheduler();
	})());
}

/** Runs once at server start, so the scheduler does not wait for the first visitor. */
export const init: ServerInit = async () => {
	await boot();
};

export const handle: Handle = async ({ event, resolve }) => {
	await boot();
	const path = event.url.pathname;

	// The MCP endpoint authenticates every request with its own API key, so it skips the browser-session gate.
	if (path === '/api/mcp') {
		event.locals.authed = false;
		return resolve(event);
	}

	if (config.adminPassword) {
		event.locals.authed = validSession(event.cookies.get(SESSION_COOKIE));
		if (!event.locals.authed && path !== '/login') {
			return new Response(null, { status: 303, headers: { location: '/login' } });
		}
	} else {
		// No password configured: only serve to this machine (or in demo mode). Never expose an open instance.
		let peer: string | null = null;
		try {
			peer = event.getClientAddress();
		} catch {
			/* unknown peer: treated as not local */
		}
		const local = isLocalRequest(event.url.hostname, peer, event.request.headers);
		if (!local && !config.demo) {
			return new Response('OpenSiteConsole refuses remote requests until ADMIN_PASSWORD is set. See .env.example.', { status: 503 });
		}
		event.locals.authed = true;
	}

	const res = await resolve(event);
	for (const [k, v] of Object.entries(securityHeaders({ https: event.url.protocol === 'https:', hasCacheControl: res.headers.has('cache-control') }))) res.headers.set(k, v);
	return res;
};
