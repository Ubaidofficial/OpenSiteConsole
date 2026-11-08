import type { RequestHandler } from './$types';
import { handleRest } from '$lib/server/rest';

// The REST API (see src/lib/server/rest.ts). It authenticates with an API key, not a session, like /api/mcp.
export const GET: RequestHandler = ({ request, params }) => handleRest(request, params.path ?? '');
export const POST: RequestHandler = ({ request, params }) => handleRest(request, params.path ?? '');
