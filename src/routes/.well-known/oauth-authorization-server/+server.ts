import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { authorizationServerMetadata } from '$lib/server/oauth';
import { oauthJson } from '$lib/server/oauth-http';

/** RFC 8414: where to register, sign in and get tokens. Public by design. */
export const GET: RequestHandler = () => oauthJson(authorizationServerMetadata(config.origin), 200, { 'cache-control': 'public, max-age=300' });
