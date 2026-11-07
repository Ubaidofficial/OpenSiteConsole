import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createApiKey, deleteApiKey, listApiKeys, setKeyCanWrite } from '$lib/server/apikeys';
import { audit, db } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';
import { MCP_TOOL_NAMES, MCP_WRITE_TOOL_NAMES } from '$lib/server/mcp';
import { oauthLabels } from '$lib/server/oauth';

export const load: PageServerLoad = () => {
	const signIns = oauthLabels(); // keys that exist because an app was approved with "Sign in", by app name
	return {
		keys: listApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.site_ids ? (JSON.parse(k.site_ids) as number[]) : null, createdAt: k.created_at, lastUsedAt: k.last_used_at, canWrite: k.can_write === 1, signInApp: signIns.get(k.id) ?? null })),
		sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })),
		mcpUrl: `${config.origin}/api/mcp`,
		tools: MCP_TOOL_NAMES,
		changeTools: MCP_WRITE_TOOL_NAMES,
		/** What agents changed, and who allowed what: the newest 40 entries. Detail text can contain URLs, so the page treats it as private. */
		activity: (db().prepare("SELECT at, action, site_id AS siteId, detail FROM audit_log WHERE action LIKE 'mcp.%' OR action IN ('apikey.created', 'apikey.changes', 'oauth.approve') ORDER BY id DESC LIMIT 40").all() as { at: number; action: string; siteId: number | null; detail: string | null }[])
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const f = await request.formData();
		const name = String(f.get('name') ?? '');
		const ids = f.getAll('site').map((v) => Number(v)).filter((n) => Number.isInteger(n));
		const canWrite = f.get('changes') === 'on';
		const { key } = createApiKey(name, ids, null, canWrite);
		audit('apikey.created', { detail: `${name.trim().slice(0, 60) || 'API key'} (${canWrite ? 'changes allowed' : 'read-only'})` });
		return { newKey: key, newKeyCanWrite: canWrite };
	},
	/** Turn "may make changes" on or off for a key you already have. */
	changes: async ({ request }) => {
		const f = await request.formData();
		try {
			const id = intParam(f.get('id'));
			const on = f.get('on') === '1';
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
