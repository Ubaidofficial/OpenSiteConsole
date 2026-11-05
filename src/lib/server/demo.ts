import type { GscClient, InspectionResult, QueryBody, SearchRow, SitemapInfo, SiteEntry } from './google';
import { addDays, eachDay, pacificToday } from './dates';

/** Deterministic 0..1 hash so demo data is identical across calls and restarts. */
export function h01(...parts: (string | number)[]): number {
	let h = 2166136261;
	for (const ch of parts.join('|')) {
		h ^= ch.charCodeAt(0);
		h = Math.imul(h, 16777619);
	}
	h ^= h >>> 15;
	h = Math.imul(h, 2246822507);
	h ^= h >>> 13;
	return (h >>> 0) / 4294967296;
}

export const DEMO_HISTORY_DAYS = 240;
const COUNTRIES: [string, number][] = [['usa', 0.5], ['gbr', 0.2], ['ind', 0.18], ['deu', 0.12]];
const DEVICES: [string, number][] = [['MOBILE', 0.62], ['DESKTOP', 0.34], ['TABLET', 0.04]];
const PATTERNS = ['best {t}', '{t} price', 'how to choose {t}', '{t} vs alternatives', '{t} reviews', 'buy {t} online', 'cheap {t}', '{t} guide', '{t} for beginners', 'top {t} 2026', 'what is {t}', '{t} near me', '{t} tutorial', '{t} comparison', '{t} checklist'];
const MODIFIERS = ['', 'pro', 'home', 'small business', 'budget', 'premium', 'eco'];

export interface DemoSite {
	siteUrl: string;
	topic: string;
	brand: string;
	scale: number;
}

export const DEMO_ACCOUNTS: { sub: string; email: string; label: string; sites: DemoSite[] }[] = [
	{
		sub: 'demo-a',
		email: 'agency@demo.example',
		label: 'Agency (demo)',
		sites: [
			{ siteUrl: 'sc-domain:greenleaf.example', topic: 'garden tools', brand: 'greenleaf', scale: 1.0 },
			{ siteUrl: 'https://www.pixelforge.example/', topic: 'icon packs', brand: 'pixelforge', scale: 0.6 },
			{ siteUrl: 'sc-domain:trailmaps.example', topic: 'hiking maps', brand: 'trailmaps', scale: 1.6 }
		]
	},
	{
		sub: 'demo-b',
		email: 'ventures@demo.example',
		label: 'Ventures (demo)',
		sites: [
			{ siteUrl: 'https://coffeelab.example/', topic: 'espresso machines', brand: 'coffeelab', scale: 0.9 },
			{ siteUrl: 'sc-domain:ledgerly.example', topic: 'invoice software', brand: 'ledgerly', scale: 0.45 },
			{ siteUrl: 'https://www.northwind-tools.example/', topic: 'power drills', brand: 'northwind', scale: 1.2 }
		]
	}
];

/** Share of web traffic each non-web type gets, per site (0 = the site has none). Deterministic. */
const TYPE_SHARE: Record<string, (siteUrl: string) => number> = {
	image: (u) => (h01(u, 'image') > 0.35 ? 0.05 + h01(u, 'image', 's') * 0.05 : 0),
	video: (u) => (h01(u, 'video') > 0.7 ? 0.015 : 0),
	news: () => 0,
	discover: (u) => (h01(u, 'discover') > 0.6 ? 0.08 : 0),
	googleNews: () => 0
};

interface Atom {
	query: string;
	page: string;
	country: string;
	device: string;
	clicks: number;
	impressions: number;
	position: number;
}

interface Profile {
	site: DemoSite;
	origin: string;
	queries: { q: string; pop: number; pos: number; pages: string[]; brand: boolean }[];
}

function originOf(siteUrl: string): string {
	return siteUrl.startsWith('sc-domain:') ? `https://${siteUrl.slice(10)}/` : siteUrl;
}

const profiles = new Map<string, Profile>();

function profile(siteUrl: string, sites: DemoSite[]): Profile {
	const cached = profiles.get(siteUrl);
	if (cached) return cached;
	const site = sites.find((s) => s.siteUrl === siteUrl) ?? sites[0];
	const origin = originOf(siteUrl);
	const pages = Array.from({ length: 14 }, (_, i) => `${origin}${i < 3 ? 'guides' : i < 8 ? 'products' : 'blog'}/${site.topic.replace(/\s+/g, '-')}-${i + 1}`);
	const queries: Profile['queries'] = [];
	let n = 0;
	for (const mod of MODIFIERS) {
		for (const pat of PATTERNS) {
			const t = (mod ? `${mod} ` : '') + site.topic;
			if (h01(siteUrl, 'keep', n++) > 0.62) continue;
			const i = queries.length;
			const primary = pages[Math.floor(h01(siteUrl, 'pg', i) * pages.length)];
			const second = h01(siteUrl, 'cn', i) < 0.14 ? pages[Math.floor(h01(siteUrl, 'pg2', i) * pages.length)] : null;
			queries.push({
				q: pat.replace('{t}', t),
				pop: 1 / (1 + i * 0.35),
				pos: 2 + h01(siteUrl, 'pos', i) * 17,
				pages: second && second !== primary ? [primary, second] : [primary],
				brand: false
			});
		}
	}
	for (const b of [site.brand, `${site.brand} login`, `${site.brand} reviews`, `www ${site.brand}`]) {
		queries.push({ q: b, pop: 0.9, pos: 1.2, pages: [origin], brand: true });
	}
	const p = { site, origin, queries };
	profiles.set(siteUrl, p);
	return p;
}

function ctrAt(pos: number): number {
	return Math.min(0.35, 0.3 * Math.exp(-0.42 * (pos - 1)) + 0.004);
}

const atomCache = new Map<string, Atom[]>();

function atomsFor(siteUrl: string, sites: DemoSite[], date: string, lastDay: string): Atom[] {
	const key = siteUrl + date;
	const hit = atomCache.get(key);
	if (hit) return hit;
	const p = profile(siteUrl, sites);
	const dow = new Date(date + 'T00:00:00Z').getUTCDay();
	const weekday = dow === 0 || dow === 6 ? 0.72 : 1.05;
	const age = (Date.parse(lastDay) - Date.parse(date)) / 86_400_000;
	const trend = 1 + (DEMO_HISTORY_DAYS - age) / DEMO_HISTORY_DAYS * 0.25; // gentle growth
	const anomaly = age === 17 ? 0.42 : 1; // a bad day
	const out: Atom[] = [];
	p.queries.forEach((q, qi) => {
		q.pages.forEach((page, pi) => {
			const pageIdx = Number(page.split('-').pop());
			// decay: pages 1-2 slide ~40% over the last 5 weeks
			const decay = !q.brand && (pageIdx === 1 || pageIdx === 2) && age < 35 ? 1 - 0.4 * (1 - age / 35) : 1;
			const split = q.pages.length === 1 ? 1 : pi === 0 ? 0.6 : 0.4; // cannibalizing pages split visibility
			for (const [country, cs] of COUNTRIES) {
				for (const [device, ds] of DEVICES) {
					const noise = 0.75 + h01(siteUrl, date, qi, pi, country, device) * 0.5;
					const impressions = Math.round(
						260 * p.site.scale * q.pop * cs * ds * weekday * trend * anomaly * decay * split * noise * (q.brand ? 1.4 : 1)
					);
					if (impressions < 1) continue;
					const position = Math.max(1, q.pos + (pi ? 2.5 : 0) + (h01(siteUrl, date, 'p', qi, pi) - 0.5) * 1.6 + (decay < 1 ? (1 - decay) * 4 : 0));
					const clicks = Math.round(impressions * ctrAt(position) * (0.8 + h01(siteUrl, date, 'c', qi, pi, country, device) * 0.4));
					out.push({ query: q.q, page, country, device, clicks, impressions, position });
				}
			}
		});
	});
	atomCache.set(key, out);
	if (atomCache.size > 3000) atomCache.delete(atomCache.keys().next().value as string);
	return out;
}

const ANON_FACTOR = 1.17; // totals include queries Google anonymises

export class DemoClient implements GscClient {
	private sitemaps = new Map<string, SitemapInfo[]>();
	constructor(private sub: string) {}

	private get def() {
		return DEMO_ACCOUNTS.find((a) => a.sub === this.sub) ?? DEMO_ACCOUNTS[0];
	}
	private lastDay() {
		return addDays(pacificToday(), -2); // Search Console lags ~2 days
	}

	async listSites(): Promise<SiteEntry[]> {
		return this.def.sites.map((s) => ({ siteUrl: s.siteUrl, permissionLevel: 'siteOwner' }));
	}
	async addSite() {}
	async deleteSite() {}

	async query(siteUrl: string, body: QueryBody): Promise<SearchRow[]> {
		const dimsIn = body.dimensions ?? [];
		if (dimsIn.length === 1 && dimsIn[0] === 'searchAppearance') return this.appearance(siteUrl, body);
		const type = body.type ?? body.searchType ?? 'web';
		// Other search types: a deterministic share of web traffic, present only for some sites, with Discover and
		// Images showing the usual shape (lots of impressions, few clicks).
		const share = type === 'web' ? 1 : TYPE_SHARE[type]?.(siteUrl) ?? 0;
		if (share === 0) return [];
		if (type !== 'web') {
			const rows = await this.query(siteUrl, { ...body, type: 'web', searchType: undefined });
			const ctrScale = type === 'discover' ? 0.35 : type === 'image' ? 0.5 : 0.8;
			return rows.map((r) => {
				const impressions = Math.round(r.impressions * share * (type === 'discover' ? 1.5 : 1));
				const clicks = Math.round(r.clicks * share * ctrScale);
				return { ...r, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: type === 'image' ? r.position + 4 : r.position };
			});
		}
		const last = this.lastDay();
		const end = body.endDate > last ? last : body.endDate;
		const first = addDays(last, -DEMO_HISTORY_DAYS);
		const start = body.startDate < first ? first : body.startDate;
		if (start > end) return [];
		const dims = body.dimensions ?? [];
		const agg = new Map<string, { k: string[]; c: number; i: number; pw: number }>();
		for (const date of eachDay(start, end)) {
			for (const a of atomsFor(siteUrl, this.def.sites, date, last)) {
				const v: Record<string, string> = { date, query: a.query, page: a.page, country: a.country, device: a.device };
				const keys = dims.map((d) => v[d]);
				const id = keys.join('\u0000');
				const cur = agg.get(id) ?? { k: keys, c: 0, i: 0, pw: 0 };
				cur.c += a.clicks;
				cur.i += a.impressions;
				cur.pw += a.position * a.impressions;
				agg.set(id, cur);
			}
		}
		const scale = dims.includes('query') || dims.includes('page') ? 1 : ANON_FACTOR;
		const rows: SearchRow[] = [...agg.values()].map((r) => {
			const impressions = Math.round(r.i * scale);
			const clicks = Math.round(r.c * scale);
			return { keys: r.k, clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: r.i ? r.pw / r.i : 0 };
		});
		rows.sort((a, b) => (dims[0] === 'date' ? a.keys[0].localeCompare(b.keys[0]) : b.clicks - a.clicks));
		const from = body.startRow ?? 0;
		return rows.slice(from, from + (body.rowLimit ?? 1000));
	}

	/** Demo search-appearance report: a couple of codes per site, as a small share of web traffic in the window. */
	private async appearance(siteUrl: string, body: QueryBody): Promise<SearchRow[]> {
		const days = await this.query(siteUrl, { startDate: body.startDate, endDate: body.endDate, dimensions: ['date'], rowLimit: 25000 });
		const clicks = days.reduce((a, r) => a + r.clicks, 0);
		const impressions = days.reduce((a, r) => a + r.impressions, 0);
		const pos = impressions ? days.reduce((a, r) => a + r.position * r.impressions, 0) / impressions : 0;
		const kinds: [string, number][] = [['RICH_RESULT', 0.06], ['REVIEW_SNIPPET', 0.04], ['VIDEO', 0.02]];
		return kinds
			.filter(([k]) => h01(siteUrl, 'appearance', k) > 0.4)
			.map(([k, f]) => ({ keys: [k], clicks: Math.round(clicks * f), impressions: Math.round(impressions * f * 1.2), ctr: 0, position: Math.max(1, pos - 1) }));
	}

	async listSitemaps(siteUrl: string) {
		let list = this.sitemaps.get(siteUrl);
		if (!list) {
			const origin = originOf(siteUrl);
			list = [
				{
					path: `${origin}sitemap.xml`,
					lastSubmitted: new Date(Date.now() - 12 * 86_400_000).toISOString(),
					lastDownloaded: new Date(Date.now() - 2 * 86_400_000).toISOString(),
					isPending: false,
					isSitemapsIndex: false,
					warnings: h01(siteUrl, 'w') < 0.4 ? 3 : 0,
					errors: 0,
					contents: [{ type: 'web', submitted: 140, indexed: 120 + Math.floor(h01(siteUrl, 'idx') * 20) }]
				}
			];
			this.sitemaps.set(siteUrl, list);
		}
		return list;
	}
	async submitSitemap(siteUrl: string, feedpath: string) {
		const list = await this.listSitemaps(siteUrl);
		const now = new Date().toISOString();
		const existing = list.find((s) => s.path === feedpath);
		if (existing) existing.lastSubmitted = now;
		else list.push({ path: feedpath, lastSubmitted: now, isPending: true, warnings: 0, errors: 0 });
	}
	async deleteSitemap(siteUrl: string, feedpath: string) {
		const list = await this.listSitemaps(siteUrl);
		this.sitemaps.set(siteUrl, list.filter((s) => s.path !== feedpath));
	}
	async inspectUrl(siteUrl: string, url: string): Promise<InspectionResult> {
		const r = h01(siteUrl, url);
		const good = r > 0.25;
		return {
			inspectionResultLink: 'https://search.google.com/search-console/inspect',
			indexStatusResult: {
				verdict: good ? 'PASS' : r > 0.1 ? 'NEUTRAL' : 'FAIL',
				coverageState: good ? 'Submitted and indexed' : r > 0.1 ? 'Crawled - currently not indexed' : 'Server error (5xx)',
				robotsTxtState: 'ALLOWED',
				indexingState: 'INDEXING_ALLOWED',
				lastCrawlTime: new Date(Date.now() - 3 * 86_400_000).toISOString(),
				pageFetchState: good ? 'SUCCESSFUL' : 'SOFT_404',
				googleCanonical: url,
				userCanonical: url,
				crawledAs: 'MOBILE'
			},
			mobileUsabilityResult: { verdict: 'PASS' }
		};
	}
}
