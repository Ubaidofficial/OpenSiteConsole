import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { db } from '$lib/server/db';
import { config } from '$lib/server/config';
import { indexSummary, recentEvents } from '$lib/server/indexmon';
import { urlClassesReport } from '$lib/server/insights';
import { enqueueIndexMonitor } from '$lib/server/jobs';
import { EVENT_SEVERITY } from '$lib/indexing';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const u = urlClassesReport(site, days);
	return {
		days,
		monitoring: !!site.index_monitor,
		checkedOn: site.index_checked_on,
		perRun: config.indexMonitorUrls,
		summary: indexSummary(site.id),
		events: recentEvents(site.id, 60).map((e) => ({ ...e, severity: EVENT_SEVERITY[e.kind as keyof typeof EVENT_SEVERITY] ?? 'warn' })),
		classes: { counts: u.counts, lost: u.lostClicks, rows: u.rows.slice(0, 500) }
	};
};

export const actions: Actions = {
	toggle: async ({ params, request }) => {
		const on = (await request.formData()).get('on') === '1';
		db().prepare('UPDATE sites SET index_monitor = ? WHERE id = ?').run(on ? 1 : 0, Number(params.id));
		if (on) enqueueIndexMonitor(Number(params.id));
		return { ok: on ? 'Monitoring switched on. The first check is running in the background.' : 'Monitoring switched off. Stored results are kept.' };
	},
	check: async ({ params }) => {
		if (!enqueueIndexMonitor(Number(params.id))) return fail(409, { error: 'A check is already running for this site.' });
		return { ok: 'Checking in the background. Reload in a minute.' };
	}
};
