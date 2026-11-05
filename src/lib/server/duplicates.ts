import { db } from './db';
import { allSites } from './queries';
import { coverageMap, isRootPrefix } from '../property';

/** Root-path URL-prefix properties that a visible Domain property already covers. */
export function hideableDuplicates() {
	const sites = allSites();
	const cover = coverageMap(sites);
	return sites.filter((s) => cover.has(s.id) && isRootPrefix(s.site_url)).map((s) => ({ id: s.id, url: s.site_url, coveredBy: cover.get(s.id)! }));
}

/** Hide them: hidden properties are excluded from totals and stop syncing, which also saves API calls. */
export function hideCoveredDuplicates(): number {
	const ids = hideableDuplicates().map((d) => d.id);
	const hide = db().prepare('UPDATE sites SET hidden = 1 WHERE id = ?');
	db().transaction(() => ids.forEach((id) => hide.run(id)))();
	return ids.length;
}

/**
 * Delete the stored data of a property Search Console no longer lists (permission 'none'). Refuses anything else, so a
 * live property can never be deleted from here. Returns whether a property was deleted.
 */
export function purgeRemovedSite(id: number): boolean {
	const row = db().prepare('SELECT permission FROM sites WHERE id = ?').get(id) as { permission: string } | undefined;
	if (!row || row.permission !== 'none') return false;
	db().prepare('DELETE FROM sites WHERE id = ?').run(id); // child tables cascade
	return true;
}
