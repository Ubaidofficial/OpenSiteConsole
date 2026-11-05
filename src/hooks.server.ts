import type { Handle, ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { verifySigned } from '$lib/server/crypto';
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

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const handle: Handle = async ({ event, resolve }) => {
	await boot();
	const path = event.url.pathname;

	// The MCP endpoint authenticates every request with its own API key, so it skips the browser-session gate.
	if (path === '/api/mcp') {
		event.locals.authed = false;
		return resolve(event);
	}

	if (config.adminPassword) {
		event.locals.authed = verifySigned(event.cookies.get('osc_session')) === 'ok';
		if (!event.locals.authed && path !== '/login') {
			return new Response(null, { status: 303, headers: { location: '/login' } });
		}
	} else {
		// No password configured: only serve to this machine (or in demo mode). Never expose an open instance.
		const local = LOOPBACK.has(event.url.hostname);
		if (!local && !config.demo) {
			return new Response('OpenSiteConsole refuses remote requests until ADMIN_PASSWORD is set. See .env.example.', { status: 503 });
		}
		event.locals.authed = true;
	}

	const res = await resolve(event);
	res.headers.set('x-frame-options', 'DENY');
	res.headers.set('referrer-policy', 'same-origin');
	res.headers.set('x-content-type-options', 'nosniff');
	return res;
};
