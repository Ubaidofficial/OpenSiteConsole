import type { RequestHandler } from './$types';
import { config } from '$lib/server/config';
import { protectedResourceMetadata } from '$lib/server/oauth';
import { oauthJson } from '$lib/server/oauth-http';

/** RFC 9728: tells a client which authorization server protects the MCP endpoint. Public by design. */
export const GET: RequestHandler = () => oauthJson(protectedResourceMetadata(config.origin), 200, { 'cache-control': 'public, max-age=300' });
