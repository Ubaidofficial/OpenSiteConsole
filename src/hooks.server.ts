import type { Handle, ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { ensureDemoAccounts } from '$lib/server/accounts';
import { startScheduler } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { validSession, SESSION_COOKIE } from '$lib/server/sessions';
import { isLocalRequest } from '$lib/server/guard';
import { securityHeaders } from '$lib/server/headers';

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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const gate: Handle = async ({ event, resolve }) => {
	await boot();
	const path = event.url.pathname;

	// Cross-site requests that change state are refused outright. SvelteKit's own check only covers form content types, so a
	// request with no content type (a bare POST) would otherwise get through. The MCP endpoint is for programs, not browsers,
	// and authenticates with its own API key.
	if (!SAFE_METHODS.has(event.request.method) && path !== '/api/mcp') {
		const origin = event.request.headers.get('origin');
		if ((origin && origin !== event.url.origin) || event.request.headers.get('sec-fetch-site') === 'cross-site') {
			return new Response('Cross-site requests are not allowed.', { status: 403 });
		}
	}

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
		// No password configured: only serve to this machine, demo mode included (it exposes the same settings and integrations).
		// Never expose an open instance.
		let peer: string | null = null;
		try {
			peer = event.getClientAddress();
		} catch {
			/* unknown peer: treated as not local */
		}
		if (!isLocalRequest(event.request.headers.get('host'), peer, event.request.headers)) {
			return new Response('OpenSiteConsole refuses remote requests until ADMIN_PASSWORD is set. See .env.example.', { status: 503 });
		}
		event.locals.authed = true;
	}

	return resolve(event);
};

export const handle: Handle = async (input) => {
	const res = await gate(input);
	// Every response gets the headers, early refusals and the MCP endpoint included.
	for (const [k, v] of Object.entries(securityHeaders({ https: input.event.url.protocol === 'https:', hasCacheControl: res.headers.has('cache-control') }))) res.headers.set(k, v);
	return res;
};
