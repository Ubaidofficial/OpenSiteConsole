import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { createApiKey, deleteApiKey, listApiKeys } from '$lib/server/apikeys';
import { allSites } from '$lib/server/queries';
import { displayName } from '$lib/server/clients';
import { intParam } from '$lib/server/params';

export const load: PageServerLoad = () => ({
	keys: listApiKeys().map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, scope: k.site_ids ? (JSON.parse(k.site_ids) as number[]) : null, createdAt: k.created_at, lastUsedAt: k.last_used_at })),
	sites: allSites().map((s) => ({ id: s.id, name: displayName(s.site_url) })),
	mcpUrl: `${config.origin}/api/mcp`
});

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
