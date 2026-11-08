/**
 * Cross-source tracking audit: does the traffic Search Console sees show up in GA4, and is Tag Manager sending it there?
 * Pure functions, no I/O, so the rules are unit-tested.
 */
import { clarityInstall, type ClarityInstallInput } from './clarityinstall';

export type Severity = 'critical' | 'warning' | 'info';

export interface Finding {
	id: string;
	severity: Severity;
	title: string;
	detail: string;
}

export interface TrackingTag {
	name: string;
	type: string;
	paused: boolean;
	firing: string[];
	measurementId: string | null;
}

export interface TrackingInput {
	/** null = no Tag Manager container linked / synced. */
	gtm: {
		publicId: string;
		/** false when the container has never been published. */
		published: boolean;
		tags: TrackingTag[];
	} | null;
	/** null = no GA4 property linked. measurementIds is empty when Google did not tell us. */
	ga4: { measurementIds: string[] } | null;
	/** Window totals; ga4OrganicSessions is null when GA4 is not linked or has not synced. */
	traffic: { days: number; gscClicks: number; ga4OrganicSessions: number | null };
	/** Is Clarity's script on the pages? Omitted or null = not checked. */
	clarity?: ClarityInstallInput | null;
}

const GA4_TYPES = new Set(['googtag', 'gaawc', 'gaawe']);
const list = (xs: string[], n = 5) => xs.slice(0, n).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');

/**
 * GA4 sessions vs Search Console clicks. Sessions and clicks are different measurements, so a gap is a prompt to look,
 * not proof. The 0.4 threshold and the 100-click floor are my own heuristics, not Google figures.
 */
export const GAP_RATIO = 0.4;
export const GAP_MIN_CLICKS = 100;

export function auditTracking(input: TrackingInput): Finding[] {
	const out: Finding[] = [];
	const { gtm, ga4, traffic } = input;

	if (gtm && !gtm.published) {
		out.push({ id: 'gtm-unpublished', severity: 'critical', title: 'The container has no published version', detail: `${gtm.publicId} has never been published, so none of its tags run on the site.` });
	}

	if (gtm?.published) {
		const gaTags = gtm.tags.filter((t) => GA4_TYPES.has(t.type));
		const ids = [...new Set(gaTags.map((t) => t.measurementId).filter((m): m is string => !!m))];
		if (!gaTags.length) {
			out.push({ id: 'gtm-no-ga4-tag', severity: 'warning', title: 'No Google tag or GA4 tag in the live container', detail: 'GA4 may be installed on the site some other way (a gtag.js snippet or a plugin). If it is meant to load through Tag Manager, nothing is sending data.' });
		} else if (ga4 && ga4.measurementIds.length && ids.length) {
			if (!ids.some((m) => ga4.measurementIds.includes(m))) {
				out.push({ id: 'ga4-id-mismatch', severity: 'critical', title: 'Tag Manager sends to a different GA4 property', detail: `The container's GA4 tags use ${list(ids)}, but the linked GA4 property's web stream is ${list(ga4.measurementIds)}. Data may be going to another property.` });
			}
		} else if (ga4 && ids.length && !ga4.measurementIds.length) {
			out.push({ id: 'ga4-id-unknown', severity: 'info', title: 'Could not compare measurement IDs', detail: `The container sends to ${list(ids)}; Google did not return the linked property's measurement ID, so the match could not be checked.` });
		} else if (ga4 && !ids.length) {
			out.push({ id: 'ga4-id-hidden', severity: 'info', title: 'GA4 tag IDs could not be read', detail: 'The container has GA4 tags, but their measurement IDs are not literal values or constant variables, so the match could not be checked.' });
		}

		const ua = gtm.tags.filter((t) => t.type === 'ua');
		if (ua.length) out.push({ id: 'gtm-ua', severity: 'warning', title: 'Universal Analytics tags are still in the container', detail: `${list(ua.map((t) => t.name))}. Universal Analytics no longer processes data; these tags do nothing useful.` });

		const paused = gtm.tags.filter((t) => t.paused);
		if (paused.length) out.push({ id: 'gtm-paused', severity: 'warning', title: `${paused.length} paused tag${paused.length > 1 ? 's' : ''}`, detail: `${list(paused.map((t) => t.name))}. Paused tags are published but never fire.` });

		const idle = gtm.tags.filter((t) => !t.paused && !t.firing.length);
		if (idle.length) out.push({ id: 'gtm-no-trigger', severity: 'info', title: `${idle.length} tag${idle.length > 1 ? 's' : ''} with no firing trigger`, detail: `${list(idle.map((t) => t.name))}. They never fire on their own; that is fine only if they run through tag sequencing.` });
	}

	if (!ga4) {
		if (gtm) out.push({ id: 'ga4-not-linked', severity: 'info', title: 'No GA4 property is linked to this site', detail: 'Link one on the Connect page to cross-check the container and the traffic.' });
	} else if (traffic.ga4OrganicSessions != null && traffic.gscClicks >= GAP_MIN_CLICKS) {
		if (traffic.ga4OrganicSessions === 0) {
			out.push({ id: 'ga4-no-organic', severity: 'critical', title: 'GA4 recorded no organic sessions', detail: `Search Console shows ${traffic.gscClicks.toLocaleString('en-US')} Google clicks in the last ${traffic.days} days, but GA4 has no Organic Search sessions. Tracking is probably broken or pointed at the wrong property.` });
		} else if (traffic.ga4OrganicSessions < traffic.gscClicks * GAP_RATIO) {
			out.push({ id: 'ga4-gap', severity: 'warning', title: 'GA4 sees far fewer organic sessions than Google sent', detail: `${traffic.ga4OrganicSessions.toLocaleString('en-US')} GA4 organic sessions against ${traffic.gscClicks.toLocaleString('en-US')} Search Console clicks in ${traffic.days} days. Consent banners, blockers and tags that do not fire on every page all cause a gap; this is a prompt to check, not proof.` });
		}
	}

	if (input.clarity) out.push(...clarityInstall(input.clarity).findings);

	const rank = { critical: 0, warning: 1, info: 2 } as const;
	return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
