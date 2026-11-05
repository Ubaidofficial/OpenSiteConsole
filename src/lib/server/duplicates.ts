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
