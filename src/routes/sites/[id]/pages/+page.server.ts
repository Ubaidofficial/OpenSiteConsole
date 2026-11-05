import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { periodFor, topPages } from '$lib/server/queries';
import { ctrOf, pctChange } from '$lib/analytics';
import { db } from '$lib/server/db';
import { linksFor } from '$lib/server/links';
import { landingPath } from '$lib/server/ga4';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const p = periodFor(site, days);
	const prev = new Map(topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000).map((r) => [r.page, r]));
	// GA4 sessions for Google-organic landing pages, matched to Search Console pages by URL path.
	const linked = !!linksFor(site.id).ga4;
	const ga = new Map(
		(linked ? (db().prepare('SELECT page, sessions, engaged_sessions e, key_events k, pulled_on FROM ga4_landing WHERE site_id = ? AND days = ?').all(site.id, days) as { page: string; sessions: number; e: number; k: number; pulled_on: string }[]) : []).map((r) => [r.page, r])
	);
	const pathOf = (u: string) => {
		try {
			return landingPath(new URL(u).pathname);
		} catch {
			return u;
		}
	};
	return {
		ga4: { linked, hasData: ga.size > 0 },
		rows: topPages(site.id, p.start, p.end, {}, 5000).map((r) => ({
			ga4Sessions: ga.size ? (ga.get(pathOf(r.page))?.sessions ?? 0) : null,
			ga4Engaged: ga.size && ga.get(pathOf(r.page))?.sessions ? ga.get(pathOf(r.page))!.e / ga.get(pathOf(r.page))!.sessions : null,
			ga4KeyEvents: ga.size ? Math.round((ga.get(pathOf(r.page))?.k ?? 0) * 10) / 10 : null,
			page: r.page,
			clicks: r.clicks,
			impressions: r.impressions,
			ctr: ctrOf(r),
			position: r.position,
			clicksDelta: pctChange(r.clicks, prev.get(r.page)?.clicks ?? 0)
		}))
	};
};
