/**
 * The digest: what changed this week and what to do first, as data and as text. Pure functions, unit-tested.
 * The first screen of it is the point: a director should be able to read the headline and the top actions and stop.
 */
import type { ActionItem } from './actions';

export interface MoverLite { key: string; change: number }
export interface SiteDigest {
	siteId: number;
	name: string;
	week: { start: string; end: string };
	/** false while the previous week is still downloading or empty: no changes are claimed then */
	comparable: boolean;
	clicks: { now: number; prev: number; change: number | null; significant: boolean };
	impressions: { now: number; prev: number; change: number | null };
	position: { now: number; prev: number };
	queryWinners: MoverLite[];
	queryLosers: MoverLite[];
	pageWinners: MoverLite[];
	pageLosers: MoverLite[];
	events: { kind: string; url: string; detail: string | null }[];
	/** pages dropped from Google's index this week, counted before `events` is cut to 10 (absent in digests stored earlier) */
	droppedPages?: number;
	updates: { name: string; kind: string; begin: string; end: string | null; startedThisWeek: boolean; endedThisWeek: boolean }[];
	decidedTests: { name: string; verdict: 'positive' | 'negative'; lift: number | null }[];
	openActions: number;
	blockingActions: number;
	topActions: (Pick<ActionItem, 'key' | 'type' | 'title' | 'blocking' | 'impact' | 'confidence' | 'href'>)[];
}

export interface Digest {
	createdAt: number;
	weekEnd: string;
	headline: string[];
	sites: SiteDigest[];
	/** the most important open actions across all the sites, blocking first */
	top: (Pick<ActionItem, 'key' | 'type' | 'title' | 'blocking' | 'impact' | 'confidence' | 'href'> & { site: string; siteId: number })[];
}

/**
 * Text that came from a website or from searchers (page paths, queries, test names) goes into a chat message. Slack treats
 * <!channel>, <@user> and <http://x|label> in text as markup and mentions; escape those characters as Slack documents, and
 * break up @everyone / @here / @channel so no text can ping a room.
 */
export const chatSafe = (s: string) =>
	String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/@(everyone|here|channel)/gi, '@\u200b$1');

const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const n0 = (x: number) => Math.round(x).toLocaleString('en-US');

/** Poisson-style test on the difference of two counts, as used elsewhere: small wobbles are not "news". */
export function clicksSignificant(now: number, prev: number): boolean {
	if (now + prev === 0) return false;
	return Math.abs(now - prev) / Math.sqrt(now + prev) >= 2 && Math.abs(now - prev) >= Math.max(10, 0.1 * prev);
}

/** The few sentences that open the digest. Facts only; nothing is claimed about a site whose comparison is not trustworthy. */
export function headlineOf(sites: SiteDigest[], top: Digest['top']): string[] {
	const out: string[] = [];
	const blocking = top.filter((t) => t.blocking);
	const open = sites.reduce((a, s) => a + s.openActions, 0);
	const blockingN = sites.reduce((a, s) => a + s.blockingActions, 0);
	if (blockingN) out.push(`${blockingN} blocking issue${blockingN === 1 ? '' : 's'} need attention first${blocking.length ? `: ${blocking.slice(0, 3).map((b) => `${b.site}: ${b.title}`).join('; ')}` : ''}.`);
	else out.push(open ? `Nothing is blocking. ${open} open action${open === 1 ? '' : 's'} across ${sites.length} site${sites.length === 1 ? '' : 's'}.` : `Nothing needs doing across ${sites.length} site${sites.length === 1 ? '' : 's'}.`);
	const cmp = sites.filter((s) => s.comparable);
	if (cmp.length) {
		const now = cmp.reduce((a, s) => a + s.clicks.now, 0), prev = cmp.reduce((a, s) => a + s.clicks.prev, 0);
		if (prev > 0) out.push(`Clicks across ${cmp.length} site${cmp.length === 1 ? '' : 's'}: ${n0(now)} this week against ${n0(prev)} the week before (${pct((now - prev) / prev)}).`);
		const moved = cmp.filter((s) => s.clicks.significant && s.clicks.change != null);
		const up = [...moved].filter((s) => s.clicks.change! > 0).sort((a, b) => b.clicks.now - b.clicks.prev - (a.clicks.now - a.clicks.prev))[0];
		const down = [...moved].filter((s) => s.clicks.change! < 0).sort((a, b) => a.clicks.now - a.clicks.prev - (b.clicks.now - b.clicks.prev))[0];
		if (down) out.push(`Biggest real decline: ${down.name} ${pct(down.clicks.change!)} (${n0(down.clicks.prev)} → ${n0(down.clicks.now)} clicks).`);
		if (up) out.push(`Biggest real gain: ${up.name} ${pct(up.clicks.change!)} (${n0(up.clicks.prev)} → ${n0(up.clicks.now)} clicks).`);
	}
	const waiting = sites.filter((s) => !s.comparable).length;
	if (waiting) out.push(`${waiting} site${waiting === 1 ? ' is' : 's are'} not compared yet: the previous week is still downloading or has no data.`);
	const upd = new Map<string, SiteDigest['updates'][number]>();
	for (const s of sites) for (const u of s.updates) upd.set(u.name, u);
	for (const u of upd.values()) out.push(u.startedThisWeek ? `Google started the ${u.name} this week. Expect movement and avoid sweeping changes until it finishes.` : u.endedThisWeek ? `Google finished the ${u.name} this week. Give it about two weeks, then compare.` : `Google's ${u.name} is still rolling out.`);
	const decided = sites.flatMap((s) => s.decidedTests.map((t) => ({ ...t, site: s.name })));
	for (const t of decided.slice(0, 3)) out.push(`Test “${t.name}” (${t.site}) likely ${t.verdict === 'positive' ? 'worked' : 'hurt'}${t.lift != null ? ` (${pct(t.lift)} vs control)` : ''}.`);
	const gone = sites.reduce((a, s) => a + (s.droppedPages ?? s.events.filter((e) => e.kind === 'deindexed').length), 0);
	if (gone) out.push(`${gone} page${gone === 1 ? ' was' : 's were'} dropped from Google's index this week.`);
	return out;
}

/**
 * Plain text for a chat message (Slack-style *bold*), short enough to read in one go. `base` makes the links absolute.
 */
export function renderText(d: Digest, base = ''): string {
	const lines: string[] = [`*SEO digest, week ending ${d.weekEnd}*`, ''];
	for (const h of d.headline) lines.push(`• ${chatSafe(h)}`);
	if (d.top.length) {
		lines.push('', '*Do this first*');
		d.top.slice(0, 8).forEach((t, i) => lines.push(`${i + 1}. ${t.blocking ? '🛑 ' : ''}${chatSafe(t.site)}: ${chatSafe(t.title)}${t.impact != null ? ` (≈${n0(t.impact)} clicks / 28d, ${t.confidence} confidence)` : ''}${base ? `\n    ${base}${t.href}` : ''}`));
	}
	lines.push('', `Estimates come from each site's own data; they are not promises and not additive.${base ? ` Full list: ${base}/actions` : ''}`);
	return lines.join('\n');
}

/** Shorter message for a problem that should not wait for Monday. */
export const URGENT_SHOWN = 8;
/** `more` = issues that exist but are not in this message (they are sent in the next one). */
export function renderUrgent(items: { site: string; title: string; why: string; href: string }[], base = '', more = 0): string {
	const total = items.length + more;
	const lines = [`*SEO alert: ${total} blocking issue${total === 1 ? '' : 's'}*`, ''];
	for (const i of items) lines.push(`🛑 *${chatSafe(i.site)}*: ${chatSafe(i.title)}\n    ${chatSafe(i.why)}${base ? `\n    ${base}${i.href}` : ''}`);
	if (more) lines.push(`…and ${more} more, to follow.`);
	return lines.join('\n');
}
