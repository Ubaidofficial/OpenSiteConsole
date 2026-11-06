import type { PageServerLoad } from './$types';
import { getSite } from '$lib/server/clients';
import { linksFor } from '$lib/server/links';
import { gtmSnapshot, trackingHealth } from '$lib/server/tracking';
import { tagTypeLabel } from '$lib/server/gtm';

export const load: PageServerLoad = async ({ params, parent }) => {
	const { days } = await parent();
	const site = getSite(Number(params.id))!;
	const link = linksFor(site.id).gtm;
	const health = trackingHealth(site, days);
	const snap = link ? gtmSnapshot(site.id) : null;
	return {
		linked: !!link,
		container: link ? link.label ?? link.external_id : null,
		status: link ? { state: link.sync_status, message: link.sync_message, lastSync: link.last_sync_at } : null,
		findings: health.findings,
		window: { days, clicks: health.input.traffic.gscClicks, ga4: health.input.traffic.ga4OrganicSessions },
		sources: health.sources,
		snapshot: snap && {
			publicId: snap.publicId,
			published: snap.published,
			versionName: snap.versionName,
			versionId: snap.versionId,
			counts: { tags: snap.tags.length, triggers: snap.triggers.length, variables: snap.variables.length },
			tags: snap.tags.map((t) => ({ ...t, typeLabel: tagTypeLabel(t.type) }))
		}
	};
};
