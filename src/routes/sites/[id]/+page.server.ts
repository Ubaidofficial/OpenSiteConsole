import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { addDays } from '$lib/server/dates';
import { anonymisedShare, annotationsFor, brandTerms, dailySeries, experiment, historyCoversPrevious, periodFor, topQueries } from '$lib/server/queries';
import { isBranded } from '$lib/analytics';
import { detectAnomalies, relativeLift } from '$lib/analytics';
import { db, audit } from '$lib/server/db';
import { updatesBetween } from '$lib/server/gupdates';
import { enqueueGa4Pages } from '$lib/server/jobs';
import { createTest, evaluateTestCached, mainResult, suggestControlMatched, testsByAnnotation } from '$lib/server/seotests';
import { queueFor } from '$lib/server/actions';
import { planFrom, positionBuckets } from '$lib/plan';

/**
 * Clicks from searches that contain the brand against all the others, now and in the period before. Non-brand clicks are the ones
 * SEO work moves; brand clicks follow brand demand. Only counts queries Google lists (anonymised ones cannot be classed).
 */
function brandSplit(site: Parameters<typeof brandTerms>[0] & { id: number; backfill_done: number; backfilled_to: string | null }, p: { start: string; end: string; prevStart: string; prevEnd: string }) {
	const terms = brandTerms(site);
	if (!terms.length) return null;
	const sum = (start: string, end: string) => {
		let brand = 0, other = 0;
		for (const r of topQueries(site.id, start, end, {}, 50_000)) isBranded(r.query, terms) ? (brand += r.clicks) : (other += r.clicks);
		return { brand, other };
	};
	return { now: sum(p.start, p.end), prev: historyCoversPrevious(site as never, p.prevStart) ? sum(p.prevStart, p.prevEnd) : null, terms };
}

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
				const r = mainResult(o);
				return [aid, { testId: t.id, verdict: r.verdict, lift: r.lift, p: r.p, detectable: r.calibration.detectable, postDays: o.postDays }];
			} catch {
				return [aid, { testId: t.id, verdict: 'too-little-data' as const, lift: null, p: null, detectable: null, postDays: 0 }];
			}
		})
	);
	return {
		plan: planFrom(queueFor(site, days)),
		brand: brandSplit(site, period),
		// where the site's searches rank now, and in the period before (only when that period is really stored)
		positions: {
			now: positionBuckets(topQueries(site.id, period.start, period.end, {}, 50_000), Math.max(5, Math.round((days / 28) * 10))),
				prev: historyCoversPrevious(site, period.prevStart) ? positionBuckets(topQueries(site.id, period.prevStart, period.prevEnd, {}, 50_000), Math.max(5, Math.round((days / 28) * 10))) : null,
				// the same buckets week by week for the last 12 weeks, oldest first; weeks before the stored history starts are left out
				weeks: Array.from({ length: 12 }, (_, i) => {
					const end = addDays(period.end, -7 * (11 - i));
					const start = addDays(end, -6);
					return { start, end, counts: positionBuckets(topQueries(site.id, start, end, {}, 50_000), 3) };
				}).filter((w) => w.counts.some((c) => c > 0))
			},
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
