import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createApiKey, deleteApiKey, listApiKeys } from '$lib/server/apikeys';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';
import { MCP_TOOL_NAMES } from '$lib/server/mcp';
import { oauthLabels } from '$lib/server/oauth';

export const load: PageServerLoad = () => {
	const signIns = oauthLabels(); // keys that exist because an app was approved with "Sign in", by app name
	return {
		keys: listApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.site_ids ? (JSON.parse(k.site_ids) as number[]) : null, createdAt: k.created_at, lastUsedAt: k.last_used_at, signInApp: signIns.get(k.id) ?? null })),
		sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })),
		mcpUrl: `${config.origin}/api/mcp`,
		tools: MCP_TOOL_NAMES
	};
};

export const actions: Actions = {
	create: async ({ request }) => {
		const f = await request.formData();
		const name = String(f.get('name') ?? '');
		const ids = f.getAll('site').map((v) => Number(v)).filter((n) => Number.isInteger(n));
		const { key } = createApiKey(name, ids);
		return { newKey: key };
	},
	remove: async ({ request }) => {
		try {
			deleteApiKey(intParam((await request.formData()).get('id')));
		} catch {
			return fail(400, { error: 'Invalid key' });
		}
	}
};
