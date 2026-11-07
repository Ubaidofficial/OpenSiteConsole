import type { Handle, ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { ensureDemoAccounts } from '$lib/server/accounts';
import { startScheduler } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { validSession, SESSION_COOKIE } from '$lib/server/sessions';
import { crossSiteRefused, isLocalRequest } from '$lib/server/guard';
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

/**
 * OAuth endpoints that programs (an MCP client's servers) call without a browser session: they carry no cookie and grant nothing by
 * themselves, so neither the login gate nor the cross-site check applies. /oauth/authorize is NOT here: it needs the owner signed in.
 */
const OAUTH_PROGRAM_ENDPOINTS = new Set(['/oauth/register', '/oauth/token']);
const isDiscovery = (path: string) => path.startsWith('/.well-known/oauth-');
/** The privacy policy and terms are public: Google's OAuth verification and anyone about to sign in must be able to read them. They show no data about the installation. */
const isLegal = (path: string) => path === '/privacy' || path === '/terms';

const gate: Handle = async ({ event, resolve }) => {
	await boot();
	const path = event.url.pathname;

	// Cross-site requests that change state are refused outright (see crossSiteRefused: it also stands in for SvelteKit's own form check, which is
	// switched off in svelte.config.js because it cannot exempt the server-to-server endpoints). The MCP endpoint and the two OAuth endpoints are for
	// programs, not browsers, and authenticate with their own credentials.
	if (
		crossSiteRefused({
			method: event.request.method,
			origin: event.request.headers.get('origin'),
			secFetchSite: event.request.headers.get('sec-fetch-site'),
			contentType: event.request.headers.get('content-type'),
			urlOrigin: event.url.origin,
			programEndpoint: path === '/api/mcp' || OAUTH_PROGRAM_ENDPOINTS.has(path)
		})
	) {
		return new Response('Cross-site requests are not allowed.', { status: 403 });
	}

	if (path === '/api/mcp' || OAUTH_PROGRAM_ENDPOINTS.has(path) || isDiscovery(path)) {
		event.locals.authed = false;
		return resolve(event);
	}

	if (config.hasPassword) {
		event.locals.authed = validSession(event.cookies.get(SESSION_COOKIE));
		if (!event.locals.authed && path !== '/login' && !isLegal(path)) {
			// Someone sent here to approve an app is returned to that request after signing in (and only to that page).
			const back = path === '/oauth/authorize' && event.request.method === 'GET' ? `/login?next=${encodeURIComponent(path + event.url.search)}` : '/login';
			return new Response(null, { status: 303, headers: { location: back } });
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
			return new Response('SEOConsole refuses remote requests until ADMIN_PASSWORD is set. See .env.example.', { status: 503 });
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
