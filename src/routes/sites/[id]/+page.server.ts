import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { anonymisedShare, annotationsFor, dailySeries, experiment, periodFor } from '$lib/server/queries';
import { detectAnomalies, relativeLift } from '$lib/analytics';
import { db, audit } from '$lib/server/db';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const period = periodFor(site, days);
	// Anomaly baseline needs weeks of history before the period, so look further back.
	const long = dailySeries(site.id, addDays(period.end, -(days + 90)), period.end);
	const anomalies = detectAnomalies(long.map((d) => ({ date: d.date, value: d.clicks })))
		.filter((a) => a.date >= period.start)
		.reverse();
	const annotations = annotationsFor(site.id).map((a) => {
		const e = experiment(site, a);
		return {
			...a,
			result: {
				tooEarly: e.tooEarly,
				afterDays: e.afterDays,
				clicksBefore: e.before.clicksPerDay,
				clicksAfter: e.after.clicksPerDay,
				posBefore: e.before.position,
				posAfter: e.after.position,
				lift: relativeLift(e.before.clicksPerDay, e.after.clicksPerDay, e.controlBeforeClicksPerDay, e.controlAfterClicksPerDay),
				rawChange: e.before.clicksPerDay ? e.after.clicksPerDay / e.before.clicksPerDay - 1 : null
			}
		};
	});
	return {
		series: dailySeries(site.id, period.start, period.end),
		anomalies,
		annotations,
		anonShare: anonymisedShare(site.id, period.start, period.end)
	};
};

export const actions: Actions = {
	addNote: async ({ request, params }) => {
		const f = await request.formData();
		const date = String(f.get('date') ?? '');
		const title = String(f.get('title') ?? '').trim();
		if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !title) return fail(400, { error: 'Date and title are required.' });
		const prefix = String(f.get('prefix') ?? '').trim() || null;
		db()
			.prepare('INSERT INTO annotations (site_id, date, title, note, kind, page_prefix, created_at) VALUES (?,?,?,?,?,?,?)')
			.run(Number(params.id), date, title.slice(0, 200), String(f.get('note') ?? '').slice(0, 2000) || null, String(f.get('kind') ?? 'change'), prefix, Date.now());
		audit('annotation.added', { siteId: Number(params.id), detail: title });
	},
	deleteNote: async ({ request, params }) => {
		const id = Number((await request.formData()).get('id'));
		db().prepare('DELETE FROM annotations WHERE id = ? AND site_id = ?').run(id, Number(params.id));
	}
};
