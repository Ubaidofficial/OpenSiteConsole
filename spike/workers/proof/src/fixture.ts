/**
 * A deterministic stand-in for Google Search Console, implementing the parts of the real `GscClient` that sync.ts uses.
 * It runs unchanged in Node (against the ORIGINAL better-sqlite3 code) and in workerd (against the PORT on D1), so both
 * sides see byte-identical input. Only integer PRNG math and exact float division are used, so V8 in Node and in workerd
 * generate identical numbers.
 *
 * Deliberately awkward data: unicode, quotes, backslashes, LIKE wildcards (% and _) in queries; full-precision doubles for
 * `position` (to catch REAL round-trip loss); days with no traffic; one day with 26,000 rows (> the 25,000 API page, so
 * paging runs); one duplicate-key pair (to check INSERT OR REPLACE ordering); a type filter that is "ignored" for `video`
 * (to drive the safety-net branch in pullTypeTotals).
 */
import type { GscClient, SearchRow, QueryBody } from '../../../../src/lib/server/google';
import { addDays, eachDay } from '../../../../src/lib/server/dates';

function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
function hash(s: string): number {
	let h = 2166136261;
	for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
	return h >>> 0;
}

const WORDS = ['seo', 'café', 'près', 'de', 'moi', '日本語', '検索', '🔥', 'deal', "it's", '"quoted"', 'back\\slash', '50%', 'off', 'under_score', 'best', 'cheap', 'guide', 'how', 'to', 'crm', 'login', 'pricing', 'review', 'vs', 'alternatives', 'tutorial', 'near', 'me', 'ü', 'ß', 'naïve'];
const COUNTRIES = ['usa', 'gbr', 'deu', 'fra', 'jpn', 'ind'];
const DEVICES = ['DESKTOP', 'MOBILE', 'TABLET'];

export interface FixtureOptions {
	today: string;
	/** how many days of history exist (the property is "younger" than the 16-month horizon) */
	historyDays?: number;
	/** site_url -> rows on the big day (default: only the first site that asks gets one) */
	bigDayRows?: number;
}

export class FixtureClient implements GscClient {
	private cache = new Map<string, SearchRow[]>();
	readonly calls: { dims: string; type?: string; start: string; end: string }[] = [];
	constructor(private o: FixtureOptions) {}

	private get firstDay() {
		return addDays(this.o.today, -(this.o.historyDays ?? 130));
	}
	private get lastDay() {
		return addDays(this.o.today, -2);
	}
	private hasTraffic(site: string, date: string) {
		return hash(site + date) % 11 !== 0; // every ~11th day has no rows at all
	}
	/** Which day carries the 26,000-row load, for sites that have one. */
	bigDay() {
		return addDays(this.o.today, -3);
	}
	private rowCount(site: string, date: string): number {
		if (/greenleaf/.test(site) && date === this.bigDay()) return this.o.bigDayRows ?? 26_000;
		return 25 + (hash(site + date + 'n') % 60);
	}

	private detail(site: string, date: string): SearchRow[] {
		const key = site + '|' + date;
		const hit = this.cache.get(key);
		if (hit) return hit;
		const rnd = mulberry32(hash(key));
		const n = this.rowCount(site, date);
		const seen = new Set<string>();
		const rows: SearchRow[] = [];
		while (rows.length < n) {
			const q = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => WORDS[Math.floor(rnd() * WORDS.length)]).join(' ') + (n > 1000 ? ' ' + Math.floor(rnd() * 5000) : '');
			const page = `https://${site.replace(/^sc-domain:/, '').replace(/^https?:\/\//, '').replace(/\/$/, '')}/p/${Math.floor(rnd() * 400)}`;
			const country = COUNTRIES[Math.floor(rnd() * COUNTRIES.length)];
			const device = DEVICES[Math.floor(rnd() * DEVICES.length)];
			const k = [q, page, country, device].join('\u0000');
			if (seen.has(k)) continue;
			seen.add(k);
			const impressions = 1 + Math.floor(rnd() * 400);
			const clicks = Math.floor(impressions * rnd() * 0.2);
			rows.push({ keys: [q, page, country, device], clicks, impressions, ctr: clicks / impressions, position: 1 + rnd() * 60 }); // full-precision double
		}
		// one deliberate duplicate primary key with different numbers: INSERT OR REPLACE must keep the LAST one
		if (n < 100 && hash(key) % 7 === 0) rows.push({ ...rows[0], keys: [...rows[0].keys], clicks: rows[0].clicks + 1, position: rows[0].position + 0.123456789 });
		this.cache.set(key, rows);
		return rows;
	}

	private totals(site: string, date: string): SearchRow | null {
		if (!this.hasTraffic(site, date)) return null;
		const rows = this.detail(site, date);
		let clicks = 0, impressions = 0, pos = 0;
		for (const r of rows) {
			clicks += r.clicks;
			impressions += r.impressions;
			pos += r.position * r.impressions;
		}
		return { keys: [date], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: impressions ? pos / impressions : 0 };
	}

	async query(siteUrl: string, body: QueryBody): Promise<SearchRow[]> {
		const dims = (body.dimensions ?? []).join(',');
		const type = body.type ?? body.searchType ?? 'web';
		this.calls.push({ dims, type, start: body.startDate, end: body.endDate });
		if (dims === 'searchAppearance') {
			return ['AMP_BLUE_LINK', 'RICH_RESULT', 'VIDEO'].map((a, i) => ({ keys: [a], clicks: 10 * (i + 1), impressions: 100 * (i + 1), ctr: 0.1, position: 4.2 + i / 3 }));
		}
		if (dims === 'date') {
			const out: SearchRow[] = [];
			for (const d of eachDay(body.startDate < this.firstDay ? this.firstDay : body.startDate, body.endDate > this.lastDay ? this.lastDay : body.endDate)) {
				const t = this.totals(siteUrl, d);
				if (!t) continue;
				if (type === 'web' || type === 'video') out.push(t); // 'video' ignores the filter on purpose (safety-net branch)
				else if (type === 'image' || type === 'discover') {
					const impressions = Math.round(t.impressions * 0.3);
					const clicks = Math.round(t.clicks * 0.1);
					out.push({ keys: [d], clicks, impressions, ctr: impressions ? clicks / impressions : 0, position: t.position + 1.5 });
				}
			}
			return out;
		}
		if (dims === 'query,page,country,device') {
			if (body.startDate !== body.endDate || body.startDate < this.firstDay || body.startDate > this.lastDay || !this.hasTraffic(siteUrl, body.startDate)) return [];
			const all = this.detail(siteUrl, body.startDate);
			const start = body.startRow ?? 0;
			return all.slice(start, start + (body.rowLimit ?? 25_000));
		}
		throw new Error('fixture: unsupported query ' + dims);
	}

	async listSites() { return []; }
	async addSite() {}
	async deleteSite() {}
	async listSitemaps() { return []; }
	async submitSitemap() {}
	async deleteSitemap() {}
	async inspectUrl(): Promise<never> { throw new Error('fixture: not implemented'); }
}

/** The fixture world: one account, three properties (a Domain property, a URL-prefix property it covers, an unrelated one). */
export const FIXTURE_SITES = ['sc-domain:greenleaf.example', 'https://blog.greenleaf.example/', 'https://other.example/'];
