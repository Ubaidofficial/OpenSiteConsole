import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getSite } from '$lib/server/clients';
import { brandTerms, periodFor, summary } from '$lib/server/queries';
import { linksFor } from '$lib/server/links';
import { isBranded, pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).bing;
	if (!link) return { linked: false as const };
	const p = periodFor(site, days);
	const d = db();
	const tot = (s: string, e: string) => d.prepare('SELECT COALESCE(SUM(clicks),0) clicks, COALESCE(SUM(impressions),0) impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ?').get(site.id, s, e) as { clicks: number; impressions: number };
	const now = tot(p.start, p.end);
	const prev = tot(p.prevStart, p.prevEnd);
	const g = summary(site.id, p.start, p.end);
	const brand = brandTerms(site);
	const terms = (kind: string) =>
		(d.prepare('SELECT term, SUM(clicks) clicks, SUM(impressions) impressions, AVG(click_pos) clickPos FROM bing_terms WHERE site_id = ? AND kind = ? AND date BETWEEN ? AND ? GROUP BY term ORDER BY clicks DESC, impressions DESC LIMIT 500').all(site.id, kind, p.start, p.end) as { term: string; clicks: number; impressions: number; clickPos: number | null }[]).map((r) => ({ ...r, ctr: r.impressions ? r.clicks / r.impressions : 0, branded: kind === 'query' && isBranded(r.term, brand) }));
	const range = d.prepare('SELECT MIN(date) a, MAX(date) b FROM bing_daily WHERE site_id = ?').get(site.id) as { a: string | null; b: string | null };
	return {
		linked: true as const,
		bingUrl: link.external_id,
		status: { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at },
		range,
		series: (d.prepare('SELECT date, clicks, impressions FROM bing_daily WHERE site_id = ? AND date BETWEEN ? AND ? ORDER BY date').all(site.id, p.start, p.end) as { date: string; clicks: number; impressions: number }[]).map((r) => ({ ...r, position: 0 })),
		kpi: { clicks: now.clicks, impressions: now.impressions, clicksDelta: pctChange(now.clicks, prev.clicks), impressionsDelta: pctChange(now.impressions, prev.impressions), googleClicks: g.clicks, shareOfGoogle: g.clicks ? now.clicks / g.clicks : null },
		queries: terms('query'),
		pages: terms('page')
	};
};
