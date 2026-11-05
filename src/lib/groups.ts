/**
 * Content groups (by URL folder), topic clusters (by shared words in queries), a month-by-month decay heatmap, and the
 * locale / country analysis. Pure functions, no I/O, unit-tested.
 */
import { computeCannibalization, sumMetrics, type CannibalGroup, type CtrCurve, type Metrics, type PRow, type QPRow } from './analytics';

// ── Content groups by URL path ───────────────────────────────────────────────
/**
 * The folder a page lives in: "/blog/post" -> "/blog/", "/shop/shoes/red" at depth 2 -> "/shop/shoes/".
 * Pages directly under the root ("/", "/about") share the group "/", so every top-level page is not its own group.
 */
export function urlSection(page: string, depth = 1): string {
	let path: string;
	try {
		path = new URL(page).pathname;
	} catch {
		path = page.startsWith('/') ? page : '/' + page;
	}
	const segs = path.split('/').filter(Boolean);
	const folders = path.endsWith('/') ? segs : segs.slice(0, -1);
	return folders.length ? '/' + folders.slice(0, depth).join('/') + '/' : '/';
}

export interface Group extends Metrics {
	key: string;
	pages: number;
	prevClicks: number;
	prevImpressions: number;
	/** null when the previous period had no clicks to compare with */
	deltaPct: number | null;
}

/** Merge page rows into URL-folder groups, with the previous period alongside. */
export function groupPages(now: PRow[], prev: PRow[], depth = 1): Group[] {
	const groups = new Map<string, { now: PRow[]; prev: PRow[] }>();
	const slot = (k: string) => groups.get(k) ?? (groups.set(k, { now: [], prev: [] }), groups.get(k)!);
	for (const r of now) slot(urlSection(r.page, depth)).now.push(r);
	for (const r of prev) slot(urlSection(r.page, depth)).prev.push(r);
	return [...groups]
		.map(([key, g]) => {
			const n = sumMetrics(g.now);
			const p = sumMetrics(g.prev);
			return { key, pages: g.now.length, ...n, prevClicks: p.clicks, prevImpressions: p.impressions, deltaPct: p.clicks ? (n.clicks - p.clicks) / p.clicks : null };
		})
		.sort((a, b) => b.clicks - a.clicks);
}

// ── Topic clusters ───────────────────────────────────────────────────────────
const STOP = new Set(
	'a an and are as at be by for from how i in is it its of on or that the this to was what when where which who why will with you your vs near me my our can do does did best top new cheap free online'.split(' ')
);
const stem = (w: string) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

export function queryTokens(q: string): string[] {
	return [...new Set(q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem))];
}

export interface TopicCluster extends Metrics {
	topic: string;
	queries: number;
	top: string[];
}

/**
 * Queries grouped by their most telling shared word. A word qualifies if it appears in at least `minQueries` queries but
 * not in more than 35% of all of them (a word in nearly every query is the site's subject, not a topic); each query goes
 * to its heaviest qualifying word, weighted by impressions. Brand terms are skipped. Transparent, not semantic: queries
 * that mean the same thing with different words are not merged.
 */
export function topicClusters(rows: (Metrics & { query: string })[], o: { minQueries?: number; limit?: number; brandTerms?: string[] } = {}): { clusters: TopicCluster[]; unclusteredShare: number } {
	const { minQueries = 3, limit = 40, brandTerms = [] } = o;
	const skip = new Set(brandTerms.flatMap(queryTokens));
	const toks = rows.map((r) => queryTokens(r.query).filter((t) => !skip.has(t)));
	const docs = new Map<string, number>();
	const weight = new Map<string, number>();
	rows.forEach((r, i) => {
		for (const t of toks[i]) {
			docs.set(t, (docs.get(t) ?? 0) + 1);
			weight.set(t, (weight.get(t) ?? 0) + r.impressions);
		}
	});
	const maxDocs = rows.length >= 30 ? rows.length * 0.35 : Infinity;
	const ok = (t: string) => (docs.get(t) ?? 0) >= minQueries && (docs.get(t) ?? 0) <= maxDocs;
	const buckets = new Map<string, number[]>();
	rows.forEach((_r, i) => {
		const best = toks[i].filter(ok).sort((a, b) => (weight.get(b) ?? 0) - (weight.get(a) ?? 0) || a.localeCompare(b))[0];
		if (best) buckets.set(best, [...(buckets.get(best) ?? []), i]);
	});
	const clusters: TopicCluster[] = [...buckets]
		.filter(([, idx]) => idx.length >= minQueries)
		.map(([topic, idx]) => {
			const items = idx.map((i) => rows[i]);
			return { topic, queries: items.length, ...sumMetrics(items), top: [...items].sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions).slice(0, 3).map((x) => x.query) };
		})
		.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions)
		.slice(0, limit);
	const clusteredImp = clusters.reduce((a, c) => a + c.impressions, 0);
	const totalImp = rows.reduce((a, r) => a + r.impressions, 0);
	return { clusters, unclusteredShare: totalImp ? 1 - clusteredImp / totalImp : 0 };
}

// ── Decay heatmap ────────────────────────────────────────────────────────────
/** YYYY-MM keys of the complete calendar months inside [first, last]. A part-month would read as a collapse. */
export function completeMonths(first: string, last: string): string[] {
	const out: string[] = [];
	let [y, m] = first.slice(0, 7).split('-').map(Number);
	if (Number(first.slice(8, 10)) > 1) m++; // history starts mid-month: skip that month
	const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).getUTCDate();
	for (;; m++) {
		if (m > 12) (m = 1, y++);
		const key = `${y}-${String(m).padStart(2, '0')}`;
		if (key > last.slice(0, 7)) break;
		if (key === last.slice(0, 7) && Number(last.slice(8, 10)) < lastDay(y, m)) break; // newest month still in progress
		out.push(key);
	}
	return out;
}

export interface HeatRow {
	key: string;
	months: number[];
	total: number;
	/** index of the strongest month */
	peak: number;
	/** newest month vs the strongest one (negative = below peak); null if the peak is under 10 clicks */
	fromPeakPct: number | null;
	/** second half of the window vs the first half */
	trendPct: number | null;
}

export function buildHeatmap(cells: { key: string; month: string; clicks: number }[], months: string[], o: { limit?: number; minTotal?: number } = {}): HeatRow[] {
	const { limit = 40, minTotal = 30 } = o;
	const idx = new Map(months.map((m, i) => [m, i]));
	const rows = new Map<string, number[]>();
	for (const c of cells) {
		const i = idx.get(c.month);
		if (i === undefined) continue;
		const arr = rows.get(c.key) ?? new Array(months.length).fill(0);
		arr[i] += c.clicks;
		rows.set(c.key, arr);
	}
	const half = Math.floor(months.length / 2);
	return [...rows]
		.map(([key, arr]) => {
			const total = arr.reduce((a, b) => a + b, 0);
			const peakVal = Math.max(...arr);
			const first = arr.slice(0, half).reduce((a, b) => a + b, 0);
			const second = arr.slice(months.length - half).reduce((a, b) => a + b, 0);
			return {
				key,
				months: arr,
				total,
				peak: arr.indexOf(peakVal),
				fromPeakPct: peakVal >= 10 ? arr[arr.length - 1] / peakVal - 1 : null,
				trendPct: half >= 2 && first >= 10 ? second / first - 1 : null
			};
		})
		.filter((r) => r.total >= minTotal)
		.sort((a, b) => b.total - a.total)
		.slice(0, limit);
}

// ── Locale folders and country-level analysis ────────────────────────────────
/** ISO 3166 alpha-2 -> alpha-3, the form Search Console uses for countries (lowercase there). Common ones only. */
export const A2_TO_A3: Record<string, string> = {
	us: 'usa', gb: 'gbr', de: 'deu', fr: 'fra', es: 'esp', it: 'ita', nl: 'nld', ca: 'can', au: 'aus', in: 'ind', br: 'bra', mx: 'mex',
	jp: 'jpn', cn: 'chn', ru: 'rus', pl: 'pol', pt: 'prt', se: 'swe', no: 'nor', dk: 'dnk', fi: 'fin', ie: 'irl', nz: 'nzl', ch: 'che',
	at: 'aut', be: 'bel', tr: 'tur', za: 'zaf', ar: 'arg', kr: 'kor', sg: 'sgp', ae: 'are'
};
const LANGS = new Set('en de fr es it nl pt sv no da fi pl ru ja zh ko tr ar hi'.split(' '));

export interface Locale { folder: string; lang: string; region: string | null }

/** "/en-gb/page" -> en-GB; "/de/page" -> de; anything else (including "/ai/") is not treated as a locale folder. */
export function localeOf(page: string): Locale | null {
	let path: string;
	try {
		path = new URL(page).pathname;
	} catch {
		path = page;
	}
	const seg = path.split('/').filter(Boolean)[0]?.toLowerCase();
	if (!seg) return null;
	const m = /^([a-z]{2})[-_]([a-z]{2})$/.exec(seg);
	if (m) return { folder: `/${seg}/`, lang: m[1], region: m[2] };
	return LANGS.has(seg) && path.split('/').filter(Boolean).length > 1 ? { folder: `/${seg}/`, lang: seg, region: null } : null;
}

export interface LocaleRow {
	folder: string;
	lang: string;
	region: string | null;
	clicks: number;
	impressions: number;
	topCountries: { country: string; share: number }[];
	/** Share of clicks from the country the folder is for; null when the folder names no region we know */
	homeShare: number | null;
	/** A region folder that earns under 40% of its clicks (50+ clicks) from its own country: check hreflang */
	mismatch: boolean;
}

export function localeReport(rows: { page: string; country: string; clicks: number; impressions: number }[]): LocaleRow[] {
	const by = new Map<string, { loc: Locale; clicks: number; impressions: number; countries: Map<string, number> }>();
	for (const r of rows) {
		const loc = localeOf(r.page);
		if (!loc) continue;
		const slot = by.get(loc.folder) ?? { loc, clicks: 0, impressions: 0, countries: new Map() };
		slot.clicks += r.clicks;
		slot.impressions += r.impressions;
		slot.countries.set(r.country, (slot.countries.get(r.country) ?? 0) + r.clicks);
		by.set(loc.folder, slot);
	}
	return [...by.values()]
		.map(({ loc, clicks, impressions, countries }) => {
			const home = loc.region ? A2_TO_A3[loc.region] : undefined;
			const homeShare = home && clicks > 0 ? (countries.get(home) ?? 0) / clicks : null;
			return {
				folder: loc.folder,
				lang: loc.lang,
				region: loc.region,
				clicks,
				impressions,
				topCountries: [...countries].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([country, c]) => ({ country, share: clicks ? c / clicks : 0 })),
				homeShare,
				mismatch: homeShare !== null && clicks >= 50 && homeShare < 0.4
			};
		})
		.sort((a, b) => b.clicks - a.clicks);
}

export type CountryCannibal = CannibalGroup & { country: string };

/**
 * Cannibalization inside each country: the same query served by two or more pages to people in the same country. The
 * same query answered by different pages in different countries is normal for a localised site and is not flagged.
 */
export function countryCannibalization(rows: (QPRow & { country: string })[], curve: CtrCurve, o: { limit?: number; minQueryImpressions?: number } = {}): CountryCannibal[] {
	const { limit = 100, minQueryImpressions = 40 } = o;
	const byCountry = new Map<string, QPRow[]>();
	for (const r of rows) byCountry.set(r.country, [...(byCountry.get(r.country) ?? []), r]);
	const out: CountryCannibal[] = [];
	for (const [country, list] of byCountry) for (const g of computeCannibalization(list, curve, { limit, minQueryImpressions })) out.push({ ...g, country });
	return out.sort((a, b) => b.potentialClicks - a.potentialClicks).slice(0, limit);
}
