import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { addManualUpdate, importGoogleUpdates, lastUpdatesCheck, listUpdates, removeManualUpdate } from '$lib/server/gupdates';

export const load: PageServerLoad = () => ({ updates: listUpdates(), checkedAt: lastUpdatesCheck() });

export const actions: Actions = {
	import: async () => {
		const r = await importGoogleUpdates();
		return r.ok ? { ok: `Checked Google's Search Status Dashboard: ${r.total} ranking update${r.total === 1 ? '' : 's'} listed, ${r.added} new, ${r.updated} changed.` } : fail(502, { error: r.error });
	},
	add: async ({ request }) => {
		const f = await request.formData();
		try {
			addManualUpdate(String(f.get('name') ?? ''), String(f.get('begin') ?? ''), String(f.get('end') ?? '') || null);
			return { ok: 'Added.' };
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not add it.' });
		}
	},
	remove: async ({ request }) => {
		removeManualUpdate(String((await request.formData()).get('id') ?? ''));
		return { ok: 'Removed.' };
	}
};
