import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { anonymisedShare, annotationsFor, dailySeries, experiment, periodFor } from '$lib/server/queries';
import { detectAnomalies, relativeLift } from '$lib/analytics';
import { db, audit } from '$lib/server/db';
import { updatesBetween } from '$lib/server/gupdates';
import { enqueueGa4Pages } from '$lib/server/jobs';
import { createTest, evaluateTestCached, suggestControlMatched, testsByAnnotation } from '$lib/server/seotests';

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
	const linked = testsByAnnotation(site.id);
	const annotationTests = Object.fromEntries(
		[...linked].map(([aid, t]) => {
			try {
				const o = evaluateTestCached(site, t);
				return [aid, { testId: t.id, verdict: o.clicks.verdict, lift: o.clicks.lift, p: o.clicks.p, detectable: o.clicks.calibration.detectable, postDays: o.postDays }];
			} catch {
				return [aid, { testId: t.id, verdict: 'too-little-data' as const, lift: null, p: null, detectable: null, postDays: 0 }];
			}
		})
	);
	return {
		annotationTests,
		series: dailySeries(site.id, period.start, period.end),
		anomalies,
		googleUpdates: updatesBetween(period.start, period.end),
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
	/** A logged change becomes a proper test: calibrated, against a matched control, with a verdict. */
	makeTest: async ({ request, params }) => {
		const id = Number((await request.formData()).get('id'));
		const site = getSite(Number(params.id))!;
		const a = db().prepare('SELECT id, date, title, note, page_prefix FROM annotations WHERE id = ? AND site_id = ?').get(id, site.id) as { id: number; date: string; title: string; note: string | null; page_prefix: string | null } | undefined;
		if (!a) return fail(404, { error: 'That entry no longer exists.' });
		if (!a.page_prefix) return fail(400, { error: 'A test needs to know which pages changed. Edit the entry with a URL prefix, or create the test on the Tests tab.' });
		if (testsByAnnotation(site.id).has(a.id)) return fail(409, { error: 'This change already has a test.' });
		const treatment = { prefixes: [a.page_prefix], urls: [] as string[] };
		const s = suggestControlMatched(site, treatment, a.date);
		try {
			createTest(site.id, { name: a.title, kind: 'before_after', startDate: a.date, treatment, control: s.urls.length ? { prefixes: [], urls: s.urls } : undefined, controlNote: s.urls.length ? s.note : `${s.note} Compared against the rest of the site instead.`, controlMethod: s.urls.length ? (s.method === 'sections' ? 'sections' : 'traffic') : 'rest', annotationId: a.id, note: a.note ?? undefined });
		} catch (e) {
			return fail(400, { error: e instanceof Error ? e.message : 'Could not create the test.' });
		}
		audit('seo_test.from_annotation', { siteId: site.id, detail: a.title });
		enqueueGa4Pages(site.id);
		return { ok: 'Test created. Results firm up as days pass; see the Tests tab.' };
	},
	deleteNote: async ({ request, params }) => {
		const id = Number((await request.formData()).get('id'));
		db().prepare('DELETE FROM annotations WHERE id = ? AND site_id = ?').run(id, Number(params.id));
	}
};
