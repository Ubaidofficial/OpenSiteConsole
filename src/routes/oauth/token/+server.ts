import type { RequestHandler } from './$types';
import { clientKey } from '$lib/server/guard';
import { parseForm } from '$lib/server/oauth-core';
import { redeemCode, refreshTokens, withinLimit } from '$lib/server/oauth';
import { oauthError, oauthJson } from '$lib/server/oauth-http';

/** RFC 6749 token endpoint: trades a code (with its PKCE verifier) for tokens, or a refresh token for new ones. Form-encoded, as the standard says. */
export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	if (!withinLimit('oauth-token', clientKey(getClientAddress), 120, 60_000)) return oauthError('temporarily_unavailable', 'Too many requests.', 429, { 'retry-after': '60' });
	if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get('content-type') ?? '')) return oauthError('invalid_request', 'Send the request as application/x-www-form-urlencoded.');
	const text = await request.text();
	if (text.length > 4000) return oauthError('invalid_request', 'The request is too large.');
	const f = parseForm(text);
	if (!f) return oauthError('invalid_request', 'A parameter was repeated.');
	const grant = f.get('grant_type');
	const result =
		grant === 'authorization_code'
			? redeemCode({ code: f.get('code') ?? '', clientId: f.get('client_id') ?? '', redirectUri: f.get('redirect_uri') ?? '', verifier: f.get('code_verifier') ?? '' })
			: grant === 'refresh_token'
				? refreshTokens({ refreshToken: f.get('refresh_token') ?? '', clientId: f.get('client_id') ?? '' })
				: { ok: false as const, error: 'unsupported_grant_type' as const, description: 'Use authorization_code or refresh_token.' };
	return result.ok ? oauthJson(result.body) : oauthError(result.error, result.description);
};
