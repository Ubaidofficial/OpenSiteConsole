import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { clientForSite, displayName, getSite } from '$lib/server/clients';
import { config } from '$lib/server/config';
import { audit, db } from '$lib/server/db';
import { enqueueSiteSync } from '$lib/server/jobs';

export const load: PageServerLoad = ({ params }) => {
	const id = Number(params.id);
	const d = db();
	return {
		runs: d.prepare('SELECT mode, started_at, finished_at, days, rows, truncated_days, error FROM sync_runs WHERE site_id = ? ORDER BY id DESC LIMIT 12').all(id) as {
			mode: string; started_at: number; finished_at: number | null; days: number; rows: number; truncated_days: number; error: string | null;
		}[],
		stored: d.prepare('SELECT (SELECT COUNT(*) FROM sa_rows WHERE site_id = ?) AS detail, (SELECT COUNT(*) FROM site_daily WHERE site_id = ?) AS days').get(id, id) as { detail: number; days: number },
		log: d.prepare('SELECT at, action, detail FROM audit_log WHERE site_id = ? ORDER BY id DESC LIMIT 10').all(id) as { at: number; action: string; detail: string | null }[],
		maxRowsPerDay: config.maxRowsPerDay
	};
};

export const actions: Actions = {
	save: async ({ params, request }) => {
		const f = await request.formData();
		const tags = String(f.get('tags') ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean).join(',');
		db().prepare('UPDATE sites SET label = ?, tags = ?, brand_terms = ?, hidden = ? WHERE id = ?').run(
			String(f.get('label') ?? '').trim() || null,
			tags,
			String(f.get('brand') ?? '').trim(),
			f.get('hidden') === 'on' ? 1 : 0,
			Number(params.id)
		);
		return { ok: 'Saved.' };
	},
	resync: async ({ params }) => {
		const id = Number(params.id);
		db().transaction(() => {
			db().prepare('DELETE FROM sa_rows WHERE site_id = ?').run(id);
			db().prepare('DELETE FROM site_daily WHERE site_id = ?').run(id);
			db().prepare('UPDATE sites SET synced_through = NULL, backfilled_to = NULL, backfill_done = 0, last_sync_at = NULL WHERE id = ?').run(id);
		})();
		audit('site.reset', { siteId: id });
		enqueueSiteSync(id, 'auto');
		return { ok: 'Local data cleared; re-pulling history from Google.' };
	},
	removeProperty: async ({ params, request }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: property removal is disabled.' });
		const site = getSite(Number(params.id))!;
		const typed = String((await request.formData()).get('confirm') ?? '').trim();
		if (typed !== displayName(site.site_url)) return fail(400, { error: `Type ${displayName(site.site_url)} exactly to confirm.` });
		try {
			await clientForSite(site.id).client.deleteSite(site.site_url);
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'Google refused the removal.' });
		}
		audit('site.removed_from_google', { accountId: site.account_id, detail: site.site_url });
		db().prepare('DELETE FROM sites WHERE id = ?').run(site.id);
		redirect(303, '/');
	}
};
