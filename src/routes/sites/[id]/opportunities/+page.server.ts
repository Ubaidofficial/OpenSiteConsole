import { fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { config } from '$lib/server/config';
import { openSeoFor, trackCandidates, trackedCount, trackerUrl, trackPreview, trackSend, volumeOf, volumesFor, TRACK_MAX } from '$lib/server/openseolink';
import { getSite } from '$lib/server/clients';
import { brandTerms, fittedCurve, periodFor, queryPageRows, topQueries } from '$lib/server/queries';
import { computeCtrGaps, computeStriking, isBranded } from '$lib/analytics';
import { hiddenReport } from '$lib/server/hidden';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const qp = queryPageRows(site.id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	// Scale thresholds with the window so a 7-day view is not starved of rows.
	const minImpr = Math.max(10, Math.round((days / 28) * 30));
	const striking = computeStriking(topQueries(site.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: minImpr });
	const ctrGaps = computeCtrGaps(qp.filter((r) => !isBranded(r.query, terms)), curve, { minImpressions: Math.max(50, minImpr * 3) });
	const vol = volumesFor(site.id);
	const os = openSeoFor(site.id);
	return {
		hidden: hiddenReport(site, days),
		striking: striking.map((r) => ({ ...r, volume: volumeOf(vol, r.query)?.volume ?? null, kd: volumeOf(vol, r.query)?.kd ?? null })),
		hasVolumes: vol.size > 0,
		openseo: os ? { tracked: trackedCount(site.id), candidates: trackCandidates(site, 25).length, max: TRACK_MAX, project: os.projectName } : null,
		ctrGaps,
		curve: { values: curve.curve.slice(1, 11), fitted: curve.fitted.slice(1, 11), source: curve.source }
	};
};

const countOf = (v: FormDataEntryValue | null) => Math.min(TRACK_MAX, Math.max(1, Number(v) || 25));

export const actions: Actions = {
	/** What sending the top striking-distance searches to OpenSEO would do and cost. Changes nothing (OpenSEO's estimate is free). */
	oseoPreview: async ({ params, request }) => {
		const site = getSite(Number(params.id))!;
		const kws = trackCandidates(site, countOf((await request.formData()).get('n'))).map((r) => r.query);
		if (!kws.length) return fail(400, { error: 'No striking-distance searches left to send.' });
		try {
			return { plan: await trackPreview(site.id, kws) };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'OpenSEO failed.' });
		}
	},
	/** Send them, with exactly the cost ceiling the preview showed. */
	oseoTrack: async ({ params, request }) => {
		if (config.readOnly) return fail(403, { error: 'READ_ONLY=1: sending searches to OpenSEO is disabled.' });
		const f = await request.formData();
		const kws = String(f.get('keywords') ?? '').split('\n').map((k) => k.trim()).filter(Boolean).slice(0, TRACK_MAX);
		const credits = f.get('credits') ? Number(f.get('credits')) : null;
		try {
			const r = await trackSend(Number(params.id), kws, credits);
			const os = openSeoFor(Number(params.id))!;
			return { ok: `Sent ${r.requested} searches; OpenSEO added ${r.added} new ones${r.created ? ' to a new manual tracker (no recurring cost: run a check in OpenSEO when you want positions)' : ''}.`, trackerUrl: trackerUrl(os, r.trackerId) };
		} catch (e) {
			return fail(502, { error: e instanceof Error ? e.message : 'OpenSEO failed.' });
		}
	}
};
