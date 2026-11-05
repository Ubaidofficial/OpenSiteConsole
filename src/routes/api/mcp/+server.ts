import type { RequestHandler } from './$types';
import { handleMcp } from '$lib/server/mcp';

export const POST: RequestHandler = ({ request }) => handleMcp(request);
// Streamable HTTP allows GET for server-initiated streams; this server is request/response only.
export const GET: RequestHandler = () => new Response('OpenSiteConsole MCP: POST JSON-RPC here', { status: 405, headers: { allow: 'POST' } });
