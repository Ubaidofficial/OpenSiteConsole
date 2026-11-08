/**
 * robots.txt: parse it, decide whether Googlebot may fetch a URL, and say what changed between two versions. Pure functions, no I/O,
 * unit-tested.
 *
 * Matching follows RFC 9309 (the Robots Exclusion Protocol) as Google documents it, to the best of my understanding; verify edge cases
 * against Google's robots.txt documentation and its open-source parser before relying on them:
 *  - A group is one or more `user-agent` lines followed by rules. The crawler obeys the group(s) whose user agent equals its own token
 *    (case-insensitive); groups naming the same agent are merged. Only if none names it does it obey the `*` group(s).
 *  - Within the chosen rules the longest matching pattern wins; if an allow and a disallow are equally long, allow wins.
 *  - `*` matches any run of characters and a final `$` anchors the end. An empty `disallow:` blocks nothing.
 *  - /robots.txt itself is always allowed. Only the first 500 KiB are read (Google's documented limit, as I understand it).
 */

export const ROBOTS_MAX_BYTES = 500 * 1024;

export interface RobotsRule { allow: boolean; pattern: string }
export interface RobotsGroup { agents: string[]; rules: RobotsRule[] }
export interface ParsedRobots { groups: RobotsGroup[]; sitemaps: string[]; /** lines that are not comments, blanks or known fields */ unknown: number }

/** Parse a robots.txt body. Never throws; anything unrecognised is skipped, as crawlers do. */
export function parseRobots(text: string): ParsedRobots {
	const groups: RobotsGroup[] = [];
	const sitemaps: string[] = [];
	let unknown = 0;
	let current: RobotsGroup | null = null;
	// After a rule, the next user-agent line starts a new group; consecutive user-agent lines share one.
	let lastWasAgent = false;
	for (const raw of text.slice(0, ROBOTS_MAX_BYTES).replace(/^﻿/, '').split(/\r\n|\r|\n/)) {
		const line = raw.replace(/#.*$/, '').trim();
		if (!line) continue;
		const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
		if (!m) { unknown++; continue; }
		const key = m[1].toLowerCase();
		const value = m[2].trim();
		if (key === 'user-agent') {
			if (!current || !lastWasAgent) groups.push((current = { agents: [], rules: [] }));
			current.agents.push(value.toLowerCase());
			lastWasAgent = true;
			continue;
		}
		if (key === 'sitemap') { if (value) sitemaps.push(value); continue; }
		if (key === 'allow' || key === 'disallow') {
			lastWasAgent = false;
			if (!current) continue; // a rule before any user-agent line belongs to no group
			if (value) current.rules.push({ allow: key === 'allow', pattern: value });
			continue;
		}
		if (key === 'crawl-delay' || key === 'host' || key === 'noindex' || key === 'clean-param') { lastWasAgent = false; continue; }
		unknown++;
	}
	return { groups, sitemaps, unknown };
}

/** The rules a crawler with this product token (for example "googlebot") obeys, merged across the groups that name it. */
export function rulesFor(p: ParsedRobots, agent = 'googlebot'): { rules: RobotsRule[]; group: string } {
	const token = agent.toLowerCase();
	const named = p.groups.filter((g) => g.agents.includes(token));
	if (named.length) return { rules: named.flatMap((g) => g.rules), group: token };
	const star = p.groups.filter((g) => g.agents.includes('*'));
	return { rules: star.flatMap((g) => g.rules), group: star.length ? '*' : '' };
}

const decode = (s: string) => {
	// Compare percent-encoded and plain forms alike; a malformed escape is compared as written.
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** Does `pattern` (robots syntax: `*` and a final `$`) match the start of `path`? */
export function patternMatches(pattern: string, path: string): boolean {
	const anchored = pattern.endsWith('$');
	const body = decode(anchored ? pattern.slice(0, -1) : pattern);
	const re = body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*');
	try {
		return new RegExp('^' + re + (anchored ? '$' : ''), 's').test(decode(path));
	} catch {
		return false;
	}
}

export interface RobotsVerdict { allowed: boolean; /** the rule that decided, as written; null when no rule matched */ rule: string | null }

/** Whether a crawler may fetch `url` (a full URL or a path with its query) under these rules. */
export function isAllowed(rules: RobotsRule[], url: string): RobotsVerdict {
	let path: string;
	try {
		const u = new URL(url, 'http://x');
		path = (u.pathname || '/') + u.search;
	} catch {
		path = url;
	}
	if (path === '/robots.txt') return { allowed: true, rule: null };
	let best: RobotsRule | null = null;
	for (const r of rules) {
		if (!patternMatches(r.pattern, path)) continue;
		if (!best || r.pattern.length > best.pattern.length || (r.pattern.length === best.pattern.length && r.allow && !best.allow)) best = r;
	}
	return best ? { allowed: best.allow, rule: `${best.allow ? 'Allow' : 'Disallow'}: ${best.pattern}` } : { allowed: true, rule: null };
}

/**
 * The file as a set of lines that mean something ("user-agent * · Disallow: /cart/", "Sitemap: ..."), so that a change in comments,
 * blank lines, case of field names or the order of groups is not reported as a change.
 */
export function ruleLines(p: ParsedRobots): string[] {
	const out: string[] = [];
	for (const g of p.groups) {
		const who = [...g.agents].sort().join(', ');
		if (!g.rules.length) out.push(`user-agent ${who} · (no rules)`);
		for (const r of g.rules) out.push(`user-agent ${who} · ${r.allow ? 'Allow' : 'Disallow'}: ${r.pattern}`);
	}
	for (const s of p.sitemaps) out.push(`Sitemap: ${s}`);
	return [...new Set(out)].sort();
}

export interface RobotsDiff { added: string[]; removed: string[] }
export function diffRobots(before: ParsedRobots, after: ParsedRobots): RobotsDiff {
	const a = new Set(ruleLines(before)), b = new Set(ruleLines(after));
	return { added: [...b].filter((x) => !a.has(x)), removed: [...a].filter((x) => !b.has(x)) };
}

/**
 * What a robots.txt answer means for crawling, by HTTP status, as Google documents it (to the best of my understanding; check its
 * current documentation): 2xx is read; 4xx other than 429 counts as "no robots.txt", so everything may be crawled; 429, 5xx and no
 * answer at all are server errors, during which Google may stop crawling the site.
 */
export type RobotsState = 'ok' | 'missing' | 'error';
export const robotsState = (status: number, hasBody: boolean): RobotsState =>
	status >= 200 && status < 300 && hasBody ? 'ok' : status >= 400 && status < 500 && status !== 429 ? 'missing' : status >= 200 && status < 300 ? 'ok' : 'error';

/** A short fingerprint of what the file means (not how it is written), to tell a real change from a cosmetic one. */
export function robotsFingerprint(state: RobotsState, p: ParsedRobots | null): string {
	if (state !== 'ok' || !p) return state;
	let h = 2166136261;
	for (const ch of ruleLines(p).join('\n')) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
	return `ok:${h.toString(16)}`;
}
