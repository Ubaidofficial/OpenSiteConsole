import type { Handle, ServerInit } from '@sveltejs/kit';
import { config } from '$lib/server/config';
import { ensureDemoAccounts } from '$lib/server/accounts';
import { startScheduler } from '$lib/server/jobs';
import { db } from '$lib/server/db';
import { sessionUser, SESSION_COOKIE } from '$lib/server/sessions';
import { OWNER, accessRefusal, refusalText } from '$lib/server/roles';
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
/** The privacy policy, terms and comparison pages are public: Google's OAuth verification and anyone about to sign in must be able to read them. They show no data about the installation. */
const isLegal = (path: string) => path === '/privacy' || path === '/terms' || path === '/compare' || path.startsWith('/compare/');
/** Reachable without a session: the sign-in form and invite links (each with its own attempt limit), and the public pages above. */
const isPublic = (path: string) => path === '/login' || path === '/login/__data.json' || /^\/invite\/[^/]+(\/__data\.json)?$/.test(path) || isLegal(path);

/**
 * A refusal the page can show. A form posted with `use:enhance` expects SvelteKit's action result (JSON, with the data devalue-encoded), so it
 * gets a failure whose `error` the layout turns into a toast; anything else gets plain text.
 */
function refuse(request: Request, status: number, message: string): Response {
	const wantsActionJson = request.method === 'POST' && (request.headers.get('x-sveltekit-action') === 'true' || /^application\/json/i.test(request.headers.get('accept') ?? ''));
	if (wantsActionJson) return Response.json({ type: 'failure', status, data: JSON.stringify([{ error: 1 }, message]) });
	return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

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
		event.locals.user = null;
		return resolve(event);
	}

	if (config.hasPassword) {
		event.locals.user = sessionUser(event.cookies.get(SESSION_COOKIE));
		event.locals.authed = event.locals.user !== null;
		if (!event.locals.authed && !isPublic(path)) {
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
		// Only this machine gets here, and it is the owner's.
		event.locals.authed = true;
		event.locals.user = OWNER;
	}

	// Roles and site scope, for every page, form action and endpoint (see roles.ts). The public pages carry no session to judge.
	const user = event.locals.user;
	if (user && !isPublic(path)) {
		const no = accessRefusal(user, event.request.method, new URL(event.request.url));
		if (no?.kind === 'not-found') return refuse(event.request, 404, 'Unknown site');
		if (no?.kind === 'cross-site') return refuse(event.request, 403, 'Your access is limited to some sites, and this covers every site. Open one of your sites from the Dashboard.');
		if (no?.kind === 'role') return refuse(event.request, 403, refusalText(no.need!));
	}

	return resolve(event);
};

export const handle: Handle = async (input) => {
	const res = await gate(input);
	// Every response gets the headers, early refusals and the MCP endpoint included.
	for (const [k, v] of Object.entries(securityHeaders({ https: input.event.url.protocol === 'https:', hasCacheControl: res.headers.has('cache-control') }))) res.headers.set(k, v);
	return res;
};
