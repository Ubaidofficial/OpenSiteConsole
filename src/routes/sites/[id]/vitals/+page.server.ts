import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { cruxIntegration, cruxLatest, FORM_FACTORS } from '$lib/server/crux';
import { rate, VITALS } from '$lib/vitals';

export const load: PageServerLoad = async ({ params }) => {
	const site = getSite(Number(params.id))!;
	const connected = !!cruxIntegration();
	const { latest, history } = cruxLatest(site.id);
	const days = new Set(history.map((h) => h.date)).size;
	return {
		connected,
		snapshots: days,
		devices: FORM_FACTORS.map((ff) => {
			const r = latest.get(ff);
			if (!r) return { formFactor: ff, has: false as const };
			const good = { lcp: r.lcp_good, inp: r.inp_good, cls: r.cls_good } as Record<string, number | null>;
			return {
				formFactor: ff,
				has: true as const,
				origin: r.origin,
				date: r.date,
				metrics: VITALS.map((v) => ({ ...v, value: r[v.key], rating: rate(v.key, r[v.key]), goodShare: good[v.key] ?? null }))
			};
		})
	};
};
