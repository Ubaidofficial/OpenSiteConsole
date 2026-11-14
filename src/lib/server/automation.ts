import { audit, db } from './db';
import { config } from './config';

/**
 * The per-site automations that are off until someone switches them on, one site at a time. This is the one place to set them for
 * every site at once, and to choose what a site found later starts with. Nothing here is on by default: choosing is the point.
 * IndexNow auto-submit is not here on purpose: it needs a key file uploaded to each site and checked first, so it cannot be bulk-set.
 */
export const SWITCHES = [
	{
		key: 'indexMonitor',
		column: 'index_monitor',
		label: 'Indexing monitor',
		what: 'Once a day, checks a rotating sample of each site\'s top pages with Google (URL Inspection) and records what changed: dropped from the index, newly indexed, blocked.',
		cost: 'Uses Google\'s URL Inspection quota, which is limited per property: up to INDEX_MONITOR_URLS (default 40) pages per site per day.',
		needsWrite: false
	},
	{
		key: 'requestAuto',
		column: 'request_auto',
		label: 'Daily Request list',
		what: 'Builds each morning the list of pages worth asking Google to index. It only prepares the list; pressing Request indexing in Search Console stays your click.',
		cost: 'Uses URL Inspection quota to check the candidates.',
		needsWrite: false
	},
	{
		key: 'sitemapAuto',
		column: 'sitemap_auto',
		label: 'Resubmit sitemaps when pages change',
		what: 'When the daily sitemap read finds new or changed pages, sends the sitemaps to Search Console again (at most once a day per site). A nudge: Google decides when it reads them.',
		cost: 'Needs write access to Search Console, so it does nothing in READ_ONLY mode.',
		needsWrite: true
	}
] as const;

export type SwitchKey = (typeof SWITCHES)[number]['key'];
const byKey = (k: string) => SWITCHES.find((s) => s.key === k);
export const isSwitchKey = (k: unknown): k is SwitchKey => typeof k === 'string' && !!byKey(k);

const KV = 'automation_defaults';
/** Sites the dashboard shows and that Google lets us read: hidden, removed and unverified ones are left out. */
const ELIGIBLE = "hidden = 0 AND permission NOT IN ('siteUnverifiedUser','none')";

/** What a site found later starts with. Everything off until chosen. */
export function getDefaults(): Record<SwitchKey, boolean> {
	let stored: Partial<Record<SwitchKey, unknown>> = {};
	try {
		const v = (db().prepare('SELECT value FROM kv WHERE key = ?').get(KV) as { value: string } | undefined)?.value;
		if (v) stored = JSON.parse(v);
	} catch {
		/* unreadable: everything stays off */
	}
	return Object.fromEntries(SWITCHES.map((s) => [s.key, stored[s.key] === true])) as Record<SwitchKey, boolean>;
}

export function setDefault(key: SwitchKey, on: boolean) {
	const next = { ...getDefaults(), [key]: on };
	db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(KV, JSON.stringify(next));
	audit('automation.default', { detail: `${byKey(key)!.label}: ${on ? 'on' : 'off'} for new sites` });
}

/** Whether a switch can be set at all right now (writing to Search Console is refused in READ_ONLY mode). */
export const available = (key: SwitchKey) => !(byKey(key)!.needsWrite && config.readOnly);

export function counts(): { total: number; on: Record<SwitchKey, number> } {
	const d = db();
	const total = (d.prepare(`SELECT COUNT(*) n FROM sites WHERE ${ELIGIBLE}`).get() as { n: number }).n;
	const on = Object.fromEntries(SWITCHES.map((s) => [s.key, (d.prepare(`SELECT COUNT(*) n FROM sites WHERE ${ELIGIBLE} AND ${s.column} = 1`).get() as { n: number }).n])) as Record<SwitchKey, number>;
	return { total, on };
}

/** Set one switch on (or off) for every eligible site. Returns how many sites actually changed. */
export function applyToAll(key: SwitchKey, on: boolean): number {
	const s = byKey(key)!;
	if (on && !available(key)) return 0;
	const r = db().prepare(`UPDATE sites SET ${s.column} = ? WHERE ${ELIGIBLE} AND ${s.column} != ?`).run(on ? 1 : 0, on ? 1 : 0);
	audit('automation.apply', { detail: `${s.label}: ${on ? 'on' : 'off'} for ${r.changes} site(s)` });
	return r.changes;
}

/** A site seen for the first time starts with the chosen defaults. Never touches a site that already existed. */
export function applyDefaultsToNewSite(siteId: number) {
	const d = getDefaults();
	const sets = SWITCHES.filter((s) => d[s.key] && available(s.key)).map((s) => `${s.column} = 1`);
	if (!sets.length) return;
	const r = db().prepare(`UPDATE sites SET ${sets.join(', ')} WHERE id = ? AND ${ELIGIBLE}`).run(siteId);
	if (r.changes) audit('automation.new_site', { siteId, detail: `started with: ${SWITCHES.filter((s) => d[s.key] && available(s.key)).map((s) => s.label).join(', ')}` });
}
