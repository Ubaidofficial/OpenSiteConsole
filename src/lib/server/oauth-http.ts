import { extraRedirects } from './oauth-core';

/** JSON for the OAuth endpoints. Tokens and errors must never be cached (RFC 6749 section 5.1). */
export const oauthJson = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', pragma: 'no-cache', ...headers } });

export const oauthError = (error: string, description: string, status = 400, headers: Record<string, string> = {}) => oauthJson({ error, error_description: description }, status, headers);

/** Extra callback addresses an owner has allowed (MCP_OAUTH_REDIRECTS), read each time so a change needs no restart in tests. */
export const allowedExtraRedirects = () => extraRedirects(process.env.MCP_OAUTH_REDIRECTS);
