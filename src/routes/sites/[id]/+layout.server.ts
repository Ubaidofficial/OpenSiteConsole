import { error } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { getSite, displayName } from '$lib/server/clients';
import { daysParam } from '$lib/server/params';
import { periodFor, summary } from '$lib/server/queries';
import { db } from '$lib/server/db';
import { ctrOf, pctChange } from '$lib/analytics';
import { config } from '$lib/server/config';
import { linksFor } from '$lib/server/links';
import { openSeoProjectUrl } from '$lib/server/connect';

export const load: LayoutServerLoad = ({ params, url }) => {
	const site = getSite(Number(params.id));
	if (!site) error(404, 'Unknown site');
	const acc = db().prepare('SELECT email, label, status FROM accounts WHERE id = ?').get(site.account_id) as { email: string; label: string | null; status: string };
	const days = daysParam(url);
	const period = periodFor(site, days);
	const now = summary(site.id, period.start, period.end);
	const prev = summary(site.id, period.prevStart, period.prevEnd);
	const links = linksFor(site.id);
	return {
		linked: { bing: !!links.bing, ga4: !!links.ga4, clarity: !!links.clarity },
		openseo: links.openseo ? { name: links.openseo.label, url: openSeoProjectUrl(links.openseo.integration_id, links.openseo.external_id) } : null,
		site: {
			id: site.id,
			url: site.site_url,
			name: displayName(site.site_url),
			label: site.label,
			tags: site.tags,
			brandTerms: site.brand_terms,
			hidden: !!site.hidden,
			permission: site.permission,
			syncStatus: site.sync_status,
			syncMessage: site.sync_message,
			lastSync: site.last_sync_at,
			syncedThrough: site.synced_through,
			backfilledTo: site.backfilled_to,
			backfillDone: !!site.backfill_done
		},
		account: acc,
		days,
		period,
		readOnly: config.readOnly,
		kpis: {
			clicks: now.clicks,
			impressions: now.impressions,
			ctr: ctrOf(now),
			position: now.position,
			clicksDelta: pctChange(now.clicks, prev.clicks),
			impressionsDelta: pctChange(now.impressions, prev.impressions),
			ctrDelta: pctChange(ctrOf(now), ctrOf(prev)),
			positionDelta: pctChange(now.position, prev.position)
		}
	};
};
