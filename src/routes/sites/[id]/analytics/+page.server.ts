import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getSite } from '$lib/server/clients';
import { dailySeries, periodFor } from '$lib/server/queries';
import { linksFor } from '$lib/server/links';
import { pctChange } from '$lib/analytics';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).ga4;
	if (!link) return { linked: false as const };
	const p = periodFor(site, days);
	const d = db();
	type R = { channel: string; sessions: number; engaged: number; users: number; keyEvents: number; pageviews: number };
	const byChannel = (s: string, e: string) => d.prepare('SELECT channel, SUM(sessions) sessions, SUM(engaged_sessions) engaged, SUM(users) users, SUM(key_events) keyEvents, SUM(pageviews) pageviews FROM ga4_daily WHERE site_id = ? AND date BETWEEN ? AND ? GROUP BY channel ORDER BY sessions DESC').all(site.id, s, e) as R[];
	const prev = new Map(byChannel(p.prevStart, p.prevEnd).map((r) => [r.channel, r]));
	const organic = new Map((d.prepare("SELECT date, sessions FROM ga4_daily WHERE site_id = ? AND channel = 'Organic Search' AND date BETWEEN ? AND ?").all(site.id, p.start, p.end) as { date: string; sessions: number }[]).map((r) => [r.date, r.sessions]));
	return {
		linked: true as const,
		property: link.label ?? link.external_id,
		status: { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at },
		series: dailySeries(site.id, p.start, p.end).map((g) => ({ date: g.date, clicks: organic.get(g.date) ?? 0, impressions: g.clicks, position: 0 })),
		channels: byChannel(p.start, p.end).map((r) => ({ channel: r.channel, sessions: r.sessions, sessionsDelta: pctChange(r.sessions, prev.get(r.channel)?.sessions ?? 0), engagementRate: r.sessions ? r.engaged / r.sessions : 0, users: r.users, keyEvents: Math.round(r.keyEvents * 10) / 10, pageviews: r.pageviews }))
	};
};
