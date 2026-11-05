/** Pure helpers for Search Console property identifiers (domain vs URL-prefix). Safe to unit test. */
import { hostKey } from './server/hosts';

export const isDomainProperty = (siteUrl: string) => siteUrl.startsWith('sc-domain:');

/** `example.com` for a domain property; `example.com (URL prefix)` / `www.example.com/blog (URL prefix)` otherwise. */
export function propertyLabel(siteUrl: string): string {
	if (isDomainProperty(siteUrl)) return siteUrl.slice('sc-domain:'.length);
	try {
		const u = new URL(siteUrl);
		const path = u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '');
		return `${u.protocol === 'http:' ? 'http://' : ''}${u.host}${path} (URL prefix)`;
	} catch {
		return siteUrl;
	}
}

/** The unlabelled name, used where the user must type it to confirm something. */
export const bareName = (siteUrl: string) => siteUrl.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '');

/** A URL-prefix property for the site root (https://example.com/), not a sub-path. */
export function isRootPrefix(siteUrl: string): boolean {
	if (isDomainProperty(siteUrl)) return false;
	try {
		return new URL(siteUrl).pathname === '/';
	} catch {
		return false;
	}
}

/**
 * A domain property already contains the data of any URL-prefix property on the same host or a subdomain.
 * Returns url-prefix property id -> id of the covering domain property.
 */
export function coverageMap<T extends { id: number; site_url: string }>(sites: T[]): Map<number, number> {
	const domains = sites.filter((s) => isDomainProperty(s.site_url)).map((s) => ({ id: s.id, host: hostKey(s.site_url) }));
	const out = new Map<number, number>();
	for (const s of sites) {
		if (isDomainProperty(s.site_url)) continue;
		const h = hostKey(s.site_url);
		const d = domains.find((x) => h === x.host || h.endsWith('.' + x.host));
		if (d) out.set(s.id, d.id);
	}
	return out;
}
