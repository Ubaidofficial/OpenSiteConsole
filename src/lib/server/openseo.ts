/**
 * Minimal MCP-over-HTTP client for an OpenSEO deployment (Streamable HTTP, JSON-RPC 2.0).
 * OpenSEO documents `/mcp` and API keys (prefix `oseo_`, sent as `x-api-key` or Bearer).
 * The tool `list_projects` output shape was confirmed against the live instance; the wire
 * handshake follows the MCP spec but has only been tested against a local mock server.
 */
export class OpenSeoError extends Error {
	constructor(message: string, readonly status = 0) {
		super(message);
	}
}

export interface OpenSeoProject { id: string; name: string; domain: string | null; url?: string }

let rpcId = 0;

/** How long one request to OpenSEO may take. A hung server must not hang a page load or a sync. */
const REQUEST_TIMEOUT_MS = 30_000;

async function readRpc(res: Response, id: number): Promise<{ result?: unknown; error?: { message?: string } }> {
	const type = res.headers.get('content-type') ?? '';
	const text = await res.text();
	if (type.includes('text/event-stream')) {
		for (const block of text.split(/\n\n/)) {
			// Per the SSE format, several `data:` lines in one event are one payload joined by newlines.
			const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n').trim();
			if (!data) continue;
			try {
				const msg = JSON.parse(data);
				if (msg.id === id) return msg;
			} catch { /* ignore keep-alives */ }
		}
		throw new OpenSeoError('No matching response in event stream');
	}
	try {
		return JSON.parse(text || '{}');
	} catch {
		// A proxy or login page answering instead of OpenSEO: say so, rather than leaking a SyntaxError.
		throw new OpenSeoError('OpenSEO answered with something that is not JSON. Check the address ends at your OpenSEO root, with no extra path.');
	}
}

export async function mcpSession(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch) {
	const url = baseUrl.replace(/\/$/, '') + '/mcp';
	let sessionId: string | null = null;
	let protocolVersion: string | null = null;
	const post = async (body: object, expectReply: boolean, id?: number) => {
		let res: Response;
		try {
			res = await fetchImpl(url, {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					accept: 'application/json, text/event-stream',
					'x-api-key': apiKey,
					...(sessionId ? { 'mcp-session-id': sessionId } : {}),
					// The MCP spec asks for this header on every request after initialize.
					...(protocolVersion ? { 'mcp-protocol-version': protocolVersion } : {})
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
			});
		} catch (e) {
			if (e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new OpenSeoError('OpenSEO did not answer in time');
			throw new OpenSeoError('Could not reach OpenSEO');
		}
		if (res.status === 401 || res.status === 403) throw new OpenSeoError('OpenSEO rejected the API key', res.status);
		if (!res.ok) throw new OpenSeoError(`OpenSEO returned ${res.status}`, res.status);
		sessionId = res.headers.get('mcp-session-id') ?? sessionId;
		return expectReply ? readRpc(res, id!) : (await res.text(), null);
	};
	const init = ++rpcId;
	const ir = await post({ jsonrpc: '2.0', id: init, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'seoconsole', version: '0.2.0' } } }, true, init);
	if (ir?.error) throw new OpenSeoError(ir.error.message ?? 'initialize failed');
	const negotiated = (ir?.result as { protocolVersion?: unknown } | undefined)?.protocolVersion;
	protocolVersion = typeof negotiated === 'string' && negotiated ? negotiated : '2025-03-26';
	await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, false);
	return {
		async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
			const id = ++rpcId;
			const r = await post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, true, id);
			if (r?.error) throw new OpenSeoError(r.error.message ?? `${name} failed`);
			const result = r?.result as { isError?: boolean; structuredContent?: unknown; content?: { type: string; text?: string }[] };
			if (result?.isError) throw new OpenSeoError(result.content?.[0]?.text ?? `${name} returned an error`);
			if (result?.structuredContent) return result.structuredContent;
			const text = result?.content?.find((c) => c.type === 'text')?.text;
			try {
				return text ? JSON.parse(text) : null;
			} catch {
				return text ?? null;
			}
		}
	};
}

export async function listOpenSeoProjects(baseUrl: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<OpenSeoProject[]> {
	const s = await mcpSession(baseUrl, apiKey, fetchImpl);
	const out = (await s.callTool('list_projects')) as { projects?: { id: string; name: string; domain: string | null; url?: string }[] } | null;
	return (out?.projects ?? []).map((p) => ({ id: p.id, name: p.name, domain: p.domain, url: p.url }));
}
