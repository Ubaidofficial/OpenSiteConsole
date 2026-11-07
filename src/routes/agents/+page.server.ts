import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { asPermission, createApiKey, deleteApiKey, listApiKeys, setKeyCanWrite, setKeyPermission } from '$lib/server/apikeys';
import { audit, db } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';
import { MCP_TOOL_NAMES, MCP_WRITE_TOOLS, MCP_WRITE_TOOL_NAMES } from '$lib/server/mcp';
import { oauthLabels } from '$lib/server/oauth';

export const load: PageServerLoad = () => {
	const signIns = oauthLabels(); // keys that exist because an app was approved with "Sign in", by app name
	return {
		keys: listApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.site_ids ? (JSON.parse(k.site_ids) as number[]) : null, createdAt: k.created_at, lastUsedAt: k.last_used_at, permission: k.permission, canWrite: k.permission !== 'read', signInApp: signIns.get(k.id) ?? null })),
		sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })),
		mcpUrl: `${config.origin}/api/mcp`,
		tools: MCP_TOOL_NAMES,
		writeTools: MCP_WRITE_TOOLS,
		changeTools: MCP_WRITE_TOOL_NAMES,
		readOnly: config.readOnly,
		/** What agents changed, and who allowed what: the newest 40 entries. Detail text can contain URLs, so the page treats it as private. */
		activity: (db().prepare("SELECT at, action, site_id AS siteId, detail FROM audit_log WHERE action LIKE 'mcp.%' OR action IN ('apikey.created', 'apikey.changes', 'oauth.approve') ORDER BY id DESC LIMIT 40").all() as { at: number; action: string; siteId: number | null; detail: string | null }[])
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const f = await request.formData();
		const name = String(f.get('name') ?? '');
		const ids = f.getAll('site').map((v) => Number(v)).filter((n) => Number.isInteger(n));
		// Submitting and deleting are opt-in per key and never the default; READ_ONLY=1 servers cannot make such keys at all.
		// (The older single "changes" checkbox is still understood, as the submit level.)
		const asked = f.get('permission') ?? (f.get('changes') === 'on' ? 'submit' : 'read');
		const perm = config.readOnly ? 'read' : asPermission(asked);
		const { key } = createApiKey(name, ids, null, perm);
		audit('apikey.created', { detail: `${name.trim().slice(0, 60) || 'API key'} (${perm === 'read' ? 'read-only' : perm === 'delete' ? 'submit and delete allowed' : 'changes allowed'})` });
		return { newKey: key, newKeyPermission: perm, newKeyCanWrite: perm !== 'read' };
	},
	/** Change what a key you already have may do: read, submit or delete. */
	permission: async ({ request }) => {
		const f = await request.formData();
		try {
			const id = intParam(f.get('id'));
			const perm = config.readOnly ? 'read' : asPermission(f.get('level'));
			if (setKeyPermission(id, perm)) audit('apikey.changes', { detail: `key ${id}: ${perm === 'read' ? 'read-only' : perm === 'delete' ? 'submit and delete allowed' : 'changes allowed'}` });
		} catch {
			return fail(400, { error: 'Invalid key' });
		}
	},
	/** Turn "may make changes" on or off for a key you already have (the submit level, or read). */
	changes: async ({ request }) => {
		const f = await request.formData();
		try {
			const id = intParam(f.get('id'));
			const on = f.get('on') === '1' && !config.readOnly;
			if (setKeyCanWrite(id, on)) audit('apikey.changes', { detail: `key ${id}: ${on ? 'changes allowed' : 'read-only'}` });
		} catch {
			return fail(400, { error: 'Invalid key' });
		}
	},
	remove: async ({ request }) => {
		try {
			deleteApiKey(intParam((await request.formData()).get('id')));
		} catch {
			return fail(400, { error: 'Invalid key' });
		}
	}
};
