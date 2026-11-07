import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createApiKey, deleteApiKey, listApiKeys } from '$lib/server/apikeys';
import { audit } from '$lib/server/db';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';
import { MCP_SUBMIT_TOOL_NAMES, MCP_TOOL_NAMES } from '$lib/server/mcp';
import { oauthLabels } from '$lib/server/oauth';

export const load: PageServerLoad = () => {
	const signIns = oauthLabels(); // keys that exist because an app was approved with "Sign in", by app name
	return {
		keys: listApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.site_ids ? (JSON.parse(k.site_ids) as number[]) : null, createdAt: k.created_at, lastUsedAt: k.last_used_at, permission: k.permission, signInApp: signIns.get(k.id) ?? null })),
		sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })),
		mcpUrl: `${config.origin}/api/mcp`,
		tools: MCP_TOOL_NAMES,
		submitTools: MCP_SUBMIT_TOOL_NAMES,
		readOnly: config.readOnly
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const f = await request.formData();
		const name = String(f.get('name') ?? '');
		const ids = f.getAll('site').map((v) => Number(v)).filter((n) => Number.isInteger(n));
		// Submitting is opt-in per key and never on by default; READ_ONLY=1 servers cannot make such keys at all.
		const submit = f.get('permission') === 'submit' && !config.readOnly;
		const { key, id } = createApiKey(name, ids, null, submit ? 'submit' : 'read');
		if (submit) audit('apikey.created_submit', { detail: `key ${id}` });
		return { newKey: key, newKeyCanSubmit: submit };
	},
	remove: async ({ request }) => {
		try {
			deleteApiKey(intParam((await request.formData()).get('id')));
		} catch {
			return fail(400, { error: 'Invalid key' });
		}
	}
};
