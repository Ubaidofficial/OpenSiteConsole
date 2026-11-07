import type { RequestHandler } from './$types';
import { clientKey } from '$lib/server/guard';
import { parseRegistration } from '$lib/server/oauth-core';
import { registerClient, withinLimit } from '$lib/server/oauth';
import { allowedExtraRedirects, oauthError, oauthJson } from '$lib/server/oauth-http';

/** RFC 7591 dynamic client registration. Anyone can call it, so it only accepts what is harmless: public clients with allowed callback addresses, a few per hour. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!withinLimit('oauth-register', clientKey(getClientAddress), 20, 3600_000)) return oauthError('temporarily_unavailable', 'Too many registrations. Try again later.', 429, { 'retry-after': '3600' });
	if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return oauthError('invalid_client_metadata', 'Send the registration as application/json.');
	const text = await request.text();
	if (text.length > 10_000) return oauthError('invalid_client_metadata', 'The registration is too large.');
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return oauthError('invalid_client_metadata', 'The registration is not valid JSON.');
	}
	const r = parseRegistration(body, allowedExtraRedirects());
	if (!r.ok) return oauthError(r.error, r.description);
	const client = registerClient(r.name, r.redirectUris);
	if (!client) return oauthError('temporarily_unavailable', 'Too many apps are registered. Try again later.', 503);
	return oauthJson(
		{ client_id: client.id, client_name: client.name, redirect_uris: client.redirectUris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', client_id_issued_at: Math.floor(Date.now() / 1000) },
		201
	);
};
