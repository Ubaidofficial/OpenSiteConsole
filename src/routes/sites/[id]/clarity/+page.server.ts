import type { PageServerLoad } from './$types';
import { db } from '$lib/server/db';
import { getSite } from '$lib/server/clients';
import { linksFor } from '$lib/server/links';
import { callsLeft, type ClarityMetric } from '$lib/server/clarity';

export const load: PageServerLoad = ({ params }) => {
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).clarity;
	if (!link) return { linked: false as const };
	const d = db();
	const snap = (dim: string) => {
		const r = d.prepare('SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = ? ORDER BY day DESC LIMIT 1').get(site.id, dim) as { day: string; payload: string } | undefined;
		return r ? { day: r.day, metrics: JSON.parse(r.payload) as ClarityMetric[] } : null;
	};
	// Sessions per stored day (Clarity only exposes 1-3 days, so history exists only because we keep it).
	const history = (d.prepare("SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = '' ORDER BY day DESC LIMIT 60").all(site.id) as { day: string; payload: string }[])
		.map((r) => {
			const traffic = (JSON.parse(r.payload) as ClarityMetric[]).find((m) => m.metricName === 'Traffic')?.information ?? [];
			const sum = (k: string) => traffic.reduce((a, x) => a + Number(x[k] ?? 0), 0);
			return { day: r.day, sessions: sum('totalSessionCount'), botSessions: sum('totalBotSessionCount'), users: sum('distantUserCount') };
		})
		.reverse();
	return {
		linked: true as const,
		status: { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at },
		callsLeft: callsLeft(link.integration_id!),
		totals: snap(''),
		byUrl: snap('URL'),
		byDevice: snap('Device'),
		history
	};
};
