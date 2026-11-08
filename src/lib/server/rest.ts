/**
 * The REST API: every MCP tool as a plain HTTP endpoint, for scripts, spreadsheets and dashboards that do not speak MCP.
 *
 *   GET  /api/v1                      the index: every endpoint, its parameters and the permission it needs
 *   GET  /api/v1/<tool>?site=1&days=28 a tool that only reads (query parameters, typed from the tool's own schema)
 *   POST /api/v1/<tool>               any tool, with a JSON body; tools that change something accept POST only
 *
 * Same API keys as MCP (`Authorization: Bearer osc_...` or `X-API-Key`), and the same rules, because both go through callTool: a key
 * sees only its sites, reads by default, changes nothing without the submit (or delete) permission, READ_ONLY=1 still applies,
 * 120 requests and 30 changes a minute per key (shared with MCP), and every change is in the audit log.
 */
import { authenticate } from './apikeys';
import { callTool, MCP_RATE_PER_MINUTE, rateLimited, toolCatalog, type ToolRefusal } from './mcp';

export const REST_BASE = '/api/v1';
const STATUS: Record<ToolRefusal, number> = { 'read-only': 403, 'write-rate': 429, permission: 403, failed: 400 };
const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra } });
const err = (status: number, code: string, message: string, extra: Record<string, string> = {}) => json(status, { error: { code, message } }, extra);

type Prop = { type?: string; items?: { type?: string } };

/** Turn query parameters into the arguments a tool expects, using its schema's types. Unknown names are refused, so a typo is not silently ignored. */
export function argsFromQuery(params: URLSearchParams, schema: Record<string, unknown>): { args: Record<string, unknown> } | { error: string } {
	const args: Record<string, unknown> = {};
	const scalar = (raw: string, type: string | undefined): unknown => {
		if (type === 'integer' || type === 'number') {
			const n = Number(raw);
			return raw.trim() !== '' && Number.isFinite(n) ? n : raw; // left as text: the tool explains what it wanted
		}
		if (type === 'boolean') return raw === 'true' || raw === '1' ? true : raw === 'false' || raw === '0' ? false : raw;
		return raw;
	};
	for (const name of new Set(params.keys())) {
		const prop = schema[name] as Prop | undefined;
		if (!prop) return { error: `Unknown parameter "${name}". This endpoint takes: ${Object.keys(schema).join(', ') || 'no parameters'}.` };
		const values = params.getAll(name);
		if (prop.type === 'array') {
			// Repeat the parameter (?urls=a&urls=b) or separate with commas (?urls=a,b).
			const items = values.length === 1 ? values[0].split(',').map((x) => x.trim()).filter(Boolean) : values;
			args[name] = items.map((x) => scalar(x, prop.items?.type));
		} else if (prop.type === 'object') {
			try {
				args[name] = JSON.parse(values[0]);
			} catch {
				return { error: `"${name}" must be JSON.` };
			}
		} else args[name] = scalar(values[values.length - 1], prop.type);
	}
	return { args };
}

export async function handleRest(request: Request, path: string): Promise<Response> {
	const auth = authenticate(request);
	if (!auth) return err(401, 'unauthorized', 'Missing or invalid API key. Create one on the MCP page and send it as "Authorization: Bearer osc_..." or "X-API-Key".', { 'www-authenticate': 'Bearer' });
	if (rateLimited(auth.id)) return err(429, 'rate_limited', `Too many requests: at most ${MCP_RATE_PER_MINUTE} a minute per key (shared with MCP).`, { 'retry-after': '60' });
	const name = path.replace(/^\/+|\/+$/g, '');
	const catalog = toolCatalog();
	if (!name) {
		if (request.method !== 'GET') return err(405, 'method_not_allowed', 'The index is read with GET.', { allow: 'GET' });
		return json(200, {
			version: 'v1',
			auth: 'Authorization: Bearer <API key> (or X-API-Key). Keys are made on the MCP page and are the same as for MCP.',
			yourKey: { name: auth.name, permission: auth.permission, limitedToSites: auth.scope },
			endpoints: catalog.map((t) => ({ path: `${REST_BASE}/${t.name}`, methods: t.needs === 'read' ? ['GET', 'POST'] : ['POST'], needs: t.needs, description: t.description, parameters: t.schema }))
		});
	}
	const tool = catalog.find((t) => t.name === name);
	if (!tool) return err(404, 'not_found', `No endpoint ${REST_BASE}/${name}. GET ${REST_BASE} lists them.`);
	let args: Record<string, unknown>;
	if (request.method === 'GET') {
		// GET never changes anything: a link, a prefetch or a crawler must not be able to submit URLs or delete a sitemap.
		if (tool.needs !== 'read') return err(405, 'method_not_allowed', `${name} changes things, so it takes POST with a JSON body.`, { allow: 'POST' });
		const a = argsFromQuery(new URL(request.url).searchParams, tool.schema);
		if ('error' in a) return err(400, 'bad_request', a.error);
		args = a.args;
	} else if (request.method === 'POST') {
		const text = await request.text();
		if (text.trim()) {
			// A JSON content type cannot be sent by a plain HTML form from another site.
			if (!/^application\/json\b/i.test(request.headers.get('content-type') ?? '')) return err(415, 'unsupported_media_type', 'Send the body as application/json.');
			let body: unknown;
			try {
				body = JSON.parse(text);
			} catch {
				return err(400, 'bad_request', 'The body is not valid JSON.');
			}
			if (body === null || typeof body !== 'object' || Array.isArray(body)) return err(400, 'bad_request', 'The body must be a JSON object of parameters.');
			args = body as Record<string, unknown>;
		} else args = {};
	} else return err(405, 'method_not_allowed', 'Use GET or POST.', { allow: tool.needs === 'read' ? 'GET, POST' : 'POST' });
	const r = await callTool(auth, name, args);
	if (r.kind === 'ok') return json(200, { data: r.data });
	if (r.kind === 'unknown') return err(404, 'not_found', `No endpoint ${REST_BASE}/${name}.`);
	return err(STATUS[r.reason], r.reason === 'failed' ? 'bad_request' : r.reason.replace('-', '_'), r.error, r.reason === 'write-rate' ? { 'retry-after': '60' } : {});
}
