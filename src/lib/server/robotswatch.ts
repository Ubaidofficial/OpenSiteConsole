/**
 * The robots.txt watch: once a day, read robots.txt on each host the site earns clicks on, keep what changed, and test the pages that
 * earn clicks against the rules Googlebot obeys. A robots.txt edit that blocks a section is then caught the next day, before Google's
 * URL Inspection (which only ever samples pages) sees it, and before the clicks go.
 */
import { db, audit } from './db';
import { getSite, type SiteRow } from './clients';
import { fetchBytes } from './onpage';
import { homeUrl } from './clarityscan';
import { pageTotals, periodFor } from './queries';
import { demoRobotsFetch } from './demo-channels';
import { diffRobots, isAllowed, parseRobots, robotsFingerprint, robotsState, rulesFor, ROBOTS_MAX_BYTES, type RobotsState } from '../robots';

/** Hosts checked per site: the property's own, plus those of its biggest pages (a domain property can span www and others). */
const MAX_ORIGINS = 3;
export const ROBOTS_RECHECK_MS = 24 * 3600_000;
/** Reads in the error state in a row before it is raised as blocking: one failed read can be this server's own network. */
export const ERROR_STREAK = 2;
/** How long a change stays in the action queue as something to review. */
export const CHANGE_REVIEW_DAYS = 14;

const originOf = (u: string) => {
	try {
		const x = new URL(u);
		return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : null;
	} catch {
		return null;
	}
};

export function originsFor(site: SiteRow): string[] {
	const out = new Set<string>();
	const home = originOf(homeUrl(site.site_url));
	if (home) out.add(home);
	try {
		const p = periodFor(site, 28);
		for (const r of pageTotals(site.id, p.start, p.end, 200)) {
			if (out.size >= MAX_ORIGINS) break;
			const o = originOf(r.page);
			if (o) out.add(o);
		}
	} catch {
		/* no Search Console data yet: the home host alone */
	}
	return [...out].slice(0, MAX_ORIGINS);
}

export interface RobotsHost {
	origin: string;
	checkedAt: number;
	status: number;
	state: RobotsState;
	body: string | null;
	changedAt: number | null;
	failStreak: number;
	error: string | null;
	/** which group Googlebot obeys: "googlebot", "*", or "" when no group applies */
	group: string;
	rules: number;
	sitemaps: string[];
}
export interface RobotsChange { id: number; origin: string; at: number; beforeState: string; afterState: string; added: string[]; removed: string[]; beforeBody: string | null }

type CheckRow = { origin: string; checked_at: number; status: number; state: RobotsState; body: string | null; fingerprint: string; changed_at: number | null; fail_streak: number; error: string | null };

const isDemoSite = (site: SiteRow) => !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;

/** Read robots.txt on every host of the site now, store it, and record a change when what it means differs from the last read. */
export async function runRobotsCheck(siteId: number, o: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<RobotsHost[]> {
	const site = getSite(siteId)!;
	const fetchImpl = o.fetchImpl ?? (isDemoSite(site) ? demoRobotsFetch(site.site_url) : undefined);
	const now = o.now ?? Date.now();
	const d = db();
	for (const origin of originsFor(site)) {
		const r = await fetchBytes(`${origin}/robots.txt`, site.site_url, { fetchImpl, max: ROBOTS_MAX_BYTES, accept: 'text/plain,*/*' });
		const body = r.body ? r.body.toString('utf8') : null;
		const state = robotsState(r.status, body != null);
		const parsed = state === 'ok' ? parseRobots(body ?? '') : null;
		const fingerprint = robotsFingerprint(state, parsed);
		const prev = d.prepare('SELECT * FROM robots_checks WHERE site_id = ? AND origin = ?').get(siteId, origin) as CheckRow | undefined;
		// A server error is not a change of rules: Google keeps using what it last read for a while, so only the streak is counted.
		// The stored fingerprint is the last *good* meaning (it is kept through errors), so a change made while the file was
		// erroring is still caught when it comes back. With no good read yet (fingerprint "error") there is nothing to compare.
		const prevKind = prev?.fingerprint.startsWith('ok') ? 'ok' : prev?.fingerprint;
		const changed = !!prev && state !== 'error' && prevKind !== 'error' && prev.fingerprint !== fingerprint;
		if (changed) {
			const before = prevKind === 'ok' ? parseRobots(prev.body ?? '') : { groups: [], sitemaps: [], unknown: 0 };
			const diff = diffRobots(before, parsed ?? { groups: [], sitemaps: [], unknown: 0 });
			d.prepare('INSERT INTO robots_changes (site_id, origin, at, before_state, after_state, added, removed, before_body) VALUES (?,?,?,?,?,?,?,?)').run(siteId, origin, now, prevKind, state, JSON.stringify(diff.added), JSON.stringify(diff.removed), prevKind === 'ok' ? prev.body : null);
			// Keep the last 50 changes per site.
			d.prepare('DELETE FROM robots_changes WHERE site_id = ? AND id NOT IN (SELECT id FROM robots_changes WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT 50)').run(siteId, siteId);
			audit('robots.changed', { siteId, detail: `${origin}: +${diff.added.length} −${diff.removed.length}` });
		}
		// While the file answers with errors, the last good copy is kept (it is what Google is likely still using).
		const keep = state === 'error' && prev;
		d.prepare(
			`INSERT INTO robots_checks (site_id, origin, checked_at, status, state, body, fingerprint, changed_at, fail_streak, error) VALUES (?,?,?,?,?,?,?,?,?,?)
			 ON CONFLICT(site_id, origin) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, state = excluded.state, body = excluded.body,
			 fingerprint = excluded.fingerprint, changed_at = excluded.changed_at, fail_streak = excluded.fail_streak, error = excluded.error`
		).run(
			siteId, origin, now, r.status, state,
			keep ? prev.body : state === 'ok' ? body : null,
			keep ? prev.fingerprint : fingerprint,
			changed ? now : (prev?.changed_at ?? null),
			state === 'error' ? (prev?.fail_streak ?? 0) + 1 : 0,
			state === 'error' ? (r.error ?? `It answered ${r.status}.`) : null
		);
	}
	// A host that is no longer one of the site's is forgotten, so it cannot raise stale alarms.
	const live = originsFor(site);
	for (const row of d.prepare('SELECT origin FROM robots_checks WHERE site_id = ?').all(siteId) as { origin: string }[]) if (!live.includes(row.origin)) d.prepare('DELETE FROM robots_checks WHERE site_id = ? AND origin = ?').run(siteId, row.origin);
	return robotsHosts(siteId);
}

export function robotsHosts(siteId: number): RobotsHost[] {
	return (db().prepare('SELECT * FROM robots_checks WHERE site_id = ? ORDER BY origin').all(siteId) as CheckRow[]).map((r) => {
		// The rules shown are those of the last good copy, which is kept while the file errors.
		const p = r.body != null && r.fingerprint.startsWith('ok') ? parseRobots(r.body) : null;
		const g = p ? rulesFor(p) : { rules: [], group: '' };
		return { origin: r.origin, checkedAt: r.checked_at, status: r.status, state: r.state, body: r.body, changedAt: r.changed_at, failStreak: r.fail_streak, error: r.error, group: g.group, rules: g.rules.length, sitemaps: p?.sitemaps ?? [] };
	});
}

export function robotsChanges(siteId: number, limit = 10): RobotsChange[] {
	return (db().prepare('SELECT * FROM robots_changes WHERE site_id = ? ORDER BY at DESC, id DESC LIMIT ?').all(siteId, limit) as { id: number; origin: string; at: number; before_state: string; after_state: string; added: string; removed: string; before_body: string | null }[]).map((r) => ({
		id: r.id, origin: r.origin, at: r.at, beforeState: r.before_state, afterState: r.after_state, added: JSON.parse(r.added), removed: JSON.parse(r.removed), beforeBody: r.before_body
	}));
}

export interface RobotsBlockedPage { url: string; clicks: number; rule: string }

/**
 * Pages with clicks that the stored robots.txt of their host disallows for Googlebot, most clicks first. Only hosts whose file was
 * read (or whose last good copy is kept) are judged; a missing file blocks nothing.
 */
export function robotsBlockedPages(siteId: number, pages: { page: string; clicks: number }[]): RobotsBlockedPage[] {
	const rules = new Map<string, ReturnType<typeof rulesFor>['rules']>();
	for (const h of db().prepare('SELECT origin, body, fingerprint FROM robots_checks WHERE site_id = ?').all(siteId) as { origin: string; body: string | null; fingerprint: string }[]) {
		if (h.body != null && h.fingerprint.startsWith('ok')) rules.set(h.origin, rulesFor(parseRobots(h.body)).rules);
	}
	if (!rules.size) return [];
	const out: RobotsBlockedPage[] = [];
	for (const p of pages) {
		if (p.clicks <= 0) continue;
		const r = rules.get(originOf(p.page) ?? '');
		if (!r?.length) continue;
		const v = isAllowed(r, p.page);
		if (!v.allowed) out.push({ url: p.page, clicks: p.clicks, rule: v.rule ?? 'Disallow' });
	}
	return out.sort((a, b) => b.clicks - a.clicks);
}

/** Everything the Sitemaps tab shows about robots.txt. */
export function robotsReport(site: SiteRow, days = 28) {
	let blocked: RobotsBlockedPage[] = [];
	try {
		const p = periodFor(site, days);
		blocked = robotsBlockedPages(site.id, pageTotals(site.id, p.start, p.end, 5000));
	} catch {
		/* no data yet */
	}
	return { hosts: robotsHosts(site.id), changes: robotsChanges(site.id), blocked, errorStreak: ERROR_STREAK };
}

/** Whether the daily check is due for a site. */
export function robotsCheckDue(siteId: number, now = Date.now()): boolean {
	const r = db().prepare('SELECT MIN(checked_at) t FROM robots_checks WHERE site_id = ?').get(siteId) as { t: number | null };
	return r.t == null || now - r.t > ROBOTS_RECHECK_MS;
}
