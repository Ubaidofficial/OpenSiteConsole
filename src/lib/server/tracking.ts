import { db } from './db';
import { linksFor } from './links';
import { auditTracking, type Finding, type TrackingInput } from '../tracking';
import type { GtmTag, GtmTrigger, GtmVariable } from './gtm';
import { periodFor, summary } from './queries';
import type { SiteRow } from './clients';
import { clarityInstallInput } from './clarityscan';

export interface GtmSnapshot {
	containerPath: string;
	publicId: string | null;
	name: string | null;
	domains: string[];
	published: boolean;
	versionId: string | null;
	versionName: string | null;
	ga4MeasurementIds: string[];
	tags: GtmTag[];
	triggers: GtmTrigger[];
	variables: GtmVariable[];
	fetchedAt: number;
}

/** The stored Tag Manager snapshot for a site, or null if none has been synced. */
export function gtmSnapshot(siteId: number): GtmSnapshot | null {
	const r = db().prepare('SELECT * FROM gtm_snapshots WHERE site_id = ?').get(siteId) as
		| { container_path: string; public_id: string | null; name: string | null; domains: string; live_version_id: string | null; live_version_name: string | null; ga4_measurement_ids: string; payload: string; fetched_at: number }
		| undefined;
	if (!r) return null;
	const p = JSON.parse(r.payload) as { tags: GtmTag[]; triggers: GtmTrigger[]; variables: GtmVariable[] };
	return {
		containerPath: r.container_path,
		publicId: r.public_id,
		name: r.name,
		domains: JSON.parse(r.domains),
		published: r.live_version_id != null,
		versionId: r.live_version_id,
		versionName: r.live_version_name,
		ga4MeasurementIds: JSON.parse(r.ga4_measurement_ids),
		tags: p.tags,
		triggers: p.triggers,
		variables: p.variables,
		fetchedAt: r.fetched_at
	};
}

/** Combine Search Console, GA4 and Tag Manager for one site and run the audit over them. */
export function trackingHealth(site: Pick<SiteRow, 'id' | 'synced_through'>, days: number): { findings: Finding[]; input: TrackingInput; sources: { gtm: boolean; ga4: boolean } } {
	const links = linksFor(site.id);
	const snap = links.gtm ? gtmSnapshot(site.id) : null;
	const p = periodFor(site, days);
	const ga4Linked = !!links.ga4;
	const ga4Sessions = ga4Linked
		? ((db().prepare("SELECT SUM(sessions) s FROM ga4_daily WHERE site_id = ? AND channel = 'Organic Search' AND date BETWEEN ? AND ?").get(site.id, p.start, p.end) as { s: number | null }))
		: null;
	// A property that has never synced has no rows at all; that is "unknown", not "zero sessions".
	const synced = ga4Linked && (db().prepare('SELECT 1 FROM ga4_daily WHERE site_id = ? LIMIT 1').get(site.id) != null);
	const input: TrackingInput = {
		gtm: snap ? { publicId: snap.publicId ?? snap.containerPath, published: snap.published, tags: snap.tags } : null,
		ga4: ga4Linked ? { measurementIds: snap?.ga4MeasurementIds ?? [] } : null,
		traffic: { days, gscClicks: summary(site.id, p.start, p.end).clicks, ga4OrganicSessions: synced ? (ga4Sessions?.s ?? 0) : null },
		clarity: clarityInstallInput(site.id)
	};
	return { findings: auditTracking(input), input, sources: { gtm: !!snap, ga4: ga4Linked } };
}
