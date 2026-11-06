/**
 * Pure helpers for the MCP `get_performance` tool: validate the date windows an agent asks for, and join a window with the one
 * it is compared against. Unit-tested.
 */
export interface Range { start: string; end: string }
export interface Windows { main: Range; compare: Range | null; compareKind: 'none' | 'previous' | 'custom'; notes: string[] }
export interface WindowInput { start?: unknown; end?: unknown; days?: unknown; compare?: unknown; compareStart?: unknown; compareEnd?: unknown }

export const MAX_SPAN_DAYS = 500;
const DAY = 86_400_000;
const parse = (d: string) => Date.parse(d + 'T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
export const shift = (d: string, n: number) => iso(parse(d) + n * DAY);
export const span = (r: Range) => Math.round((parse(r.end) - parse(r.start)) / DAY) + 1;
/** A real calendar date in YYYY-MM-DD (2026-02-30 is not one). */
export const isRealDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(parse(s)) && iso(parse(s)) === s;

/**
 * `dataEnd` is the newest day stored for the site. A window that runs past it is cut back (with a note), and a window that
 * starts after it is refused, so an agent never reads "no traffic" where there is only no data yet.
 */
export function resolveWindows(i: WindowInput, dataEnd: string): Windows | { error: string } {
	const notes: string[] = [];
	let main: Range;
	if (i.start != null || i.end != null) {
		if (!isRealDate(i.start) || !isRealDate(i.end)) return { error: '`start` and `end` must both be real dates in YYYY-MM-DD form.' };
		if (i.start > i.end) return { error: '`start` is after `end`.' };
		if (i.start > dataEnd) return { error: `No data after ${dataEnd}: the site is synced through that day.` };
		main = { start: i.start, end: i.end };
		if (main.end > dataEnd) {
			main.end = dataEnd;
			notes.push(`The window was cut back to ${dataEnd}, the newest day stored.`);
		}
	} else {
		const n = i.days == null ? 28 : Number(i.days);
		if (!Number.isInteger(n) || n < 1 || n > MAX_SPAN_DAYS) return { error: `\`days\` must be a whole number from 1 to ${MAX_SPAN_DAYS}.` };
		main = { start: shift(dataEnd, -(n - 1)), end: dataEnd };
	}
	if (span(main) > MAX_SPAN_DAYS) return { error: `A window can be at most ${MAX_SPAN_DAYS} days.` };

	const kind = i.compare == null || i.compare === '' ? 'none' : String(i.compare);
	if (kind === 'none') return { main, compare: null, compareKind: 'none', notes };
	if (kind === 'previous') {
		const n = span(main);
		return { main, compare: { start: shift(main.start, -n), end: shift(main.start, -1) }, compareKind: 'previous', notes };
	}
	if (kind === 'custom') {
		if (!isRealDate(i.compareStart) || !isRealDate(i.compareEnd)) return { error: 'compare "custom" needs `compare_start` and `compare_end` as real dates in YYYY-MM-DD form.' };
		if (i.compareStart > i.compareEnd) return { error: '`compare_start` is after `compare_end`.' };
		const c = { start: i.compareStart, end: i.compareEnd };
		if (span(c) > MAX_SPAN_DAYS) return { error: `A window can be at most ${MAX_SPAN_DAYS} days.` };
		if (c.end > dataEnd) return { error: `The comparison window runs past ${dataEnd}, the newest day stored.` };
		if (c.start <= main.end && c.end >= main.start) notes.push('The two windows overlap, so the changes below partly compare the same days with themselves.');
		if (span(c) !== span(main)) notes.push(`The windows differ in length (${span(main)} and ${span(c)} days): clicks and impressions are totals and are not directly comparable; CTR and position are.`);
		return { main, compare: c, compareKind: 'custom', notes };
	}
	return { error: '`compare` must be "none", "previous" or "custom".' };
}

export interface Row { key: string; clicks: number; impressions: number; position: number }
export interface Joined extends Row {
	prev: { clicks: number; impressions: number; position: number } | null;
	/** (now - before) / before; null when there was nothing before */
	clicksChange: number | null;
	impressionsChange: number | null;
	/** now - before, in positions: negative means the page or query moved up */
	positionChange: number | null;
}
const rel = (a: number, b: number) => (b > 0 ? (a - b) / b : null);

/**
 * Every key from either window. A key missing from one side counts as zero clicks and impressions there (it appeared or
 * disappeared), with no position on that side.
 */
export function joinWindows(now: Row[], before: Row[]): Joined[] {
	const p = new Map(before.map((r) => [r.key, r]));
	const n = new Map(now.map((r) => [r.key, r]));
	const out: Joined[] = [];
	for (const key of new Set([...n.keys(), ...p.keys()])) {
		const a = n.get(key);
		const b = p.get(key);
		const prev = b ? { clicks: b.clicks, impressions: b.impressions, position: b.position } : null;
		const clicks = a?.clicks ?? 0;
		const impressions = a?.impressions ?? 0;
		out.push({
			key, clicks, impressions, position: a?.position ?? 0, prev,
			clicksChange: rel(clicks, b?.clicks ?? 0),
			impressionsChange: rel(impressions, b?.impressions ?? 0),
			positionChange: a && b && a.position > 0 && b.position > 0 ? a.position - b.position : null
		});
	}
	return out;
}

export type SortBy = 'clicks' | 'impressions' | 'ctr' | 'position' | 'clicks_change' | 'key';
const ctr = (r: { clicks: number; impressions: number }) => (r.impressions ? r.clicks / r.impressions : 0);

/** Sort descending by the measure (position ascending: the best positions first); ties by clicks, then key. */
export function sortRows<T extends Row & { clicksChange?: number | null }>(rows: T[], by: SortBy): T[] {
	const val = (r: T): number | null =>
		by === 'clicks' ? r.clicks : by === 'impressions' ? r.impressions : by === 'ctr' ? ctr(r) : by === 'position' ? (r.position > 0 ? -r.position : null) : by === 'clicks_change' ? (r.clicksChange ?? null) : 0;
	return [...rows].sort((a, b) => {
		if (by === 'key') return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
		const x = val(a), y = val(b);
		if (x === null && y !== null) return 1; // unknowns last
		if (y === null && x !== null) return -1;
		return (y ?? 0) - (x ?? 0) || b.clicks - a.clicks || (a.key < b.key ? -1 : 1);
	});
}
