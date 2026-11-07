import type { allSites } from './queries';
import { hostKey } from './hosts';

/** Shared by the MCP server and its tool modules (kept apart so the tool modules can import it without a cycle). */
export type Site = ReturnType<typeof allSites>[number];
export interface ToolContext {
	keyId: number;
	keyName: string;
}
export interface Tool {
	name: string;
	description: string;
	schema: Record<string, unknown>;
	/** true for a tool that changes something: it refuses unless the key may make changes, and is recorded in the audit log */
	write?: boolean;
	run: (args: Record<string, unknown>, sites: Site[], ctx: ToolContext) => unknown | Promise<unknown>;
}

export const siteArg = { site: { type: 'string', description: 'Site id (from list_sites), domain such as example.com, or property URL' } };
export const daysArg = { days: { type: 'integer', enum: [7, 28, 90, 180, 480], description: 'Window length in days (default 28). Compared with the equally long previous window.' } };

export function resolveSite(sites: Site[], ref: unknown): Site {
	const s = String(ref ?? '').trim();
	if (!s) throw new Error('`site` is required (use list_sites)');
	const byId = sites.find((x) => String(x.id) === s);
	if (byId) return byId;
	const hits = sites.filter((x) => hostKey(x.site_url) === hostKey(s));
	if (hits.length === 1) return hits[0];
	if (hits.length > 1) throw new Error(`"${s}" matches ${hits.length} properties; use the numeric id: ${hits.map((h) => h.id).join(', ')}`);
	throw new Error(`No accessible site matches "${s}"`);
}

export const days = (a: Record<string, unknown>) => ([7, 28, 90, 180, 480].includes(Number(a.days)) ? Number(a.days) : 28);
export const limit = (a: Record<string, unknown>, d = 25) => Math.min(200, Math.max(1, Number(a.limit) || d));
export const r2 = (n: number) => Math.round(n * 100) / 100;
