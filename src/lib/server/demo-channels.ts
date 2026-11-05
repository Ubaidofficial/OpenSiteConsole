import type { BingClient, BingDay, BingSite, BingTermRow } from './bing';
import type { Ga4Day, Ga4Property } from './ga4';
import type { ClarityMetric } from './clarity';
import type { GtmContainer, GtmLive } from './gtm';
import { DEMO_ACCOUNTS, DEMO_HISTORY_DAYS, DemoClient, h01 } from './demo';
import { addDays, eachDay, pacificToday } from './dates';
import { hostKey } from './hosts';

const sites = DEMO_ACCOUNTS.flatMap((a) => a.sites);
const siteOf = (urlOrHost: string) => sites.find((s) => hostKey(s.siteUrl) === hostKey(urlOrHost)) ?? sites[0];
const lastDay = () => addDays(pacificToday(), -2);
const dayFactor = (date: string, end: string, seed: string) => {
	const age = (Date.parse(end) - Date.parse(date)) / 86_400_000;
	const dow = new Date(date + 'T00:00:00Z').getUTCDay();
	return (dow === 0 || dow === 6 ? 0.72 : 1.05) * (0.85 + h01(seed, date) * 0.3) * (age === 17 ? 0.5 : 1);
};

export class DemoBing implements BingClient {
	async listSites(): Promise<BingSite[]> {
		// Five of six demo sites exist in Bing; one does not, so the "unmatched" path is visible in the UI.
		return sites.filter((s) => !s.siteUrl.includes('ledgerly')).map((s) => ({ url: s.siteUrl.startsWith('sc-domain:') ? `https://www.${s.siteUrl.slice(10)}/` : s.siteUrl, isVerified: true }));
	}
	async dailyStats(siteUrl: string): Promise<BingDay[]> {
		const s = siteOf(siteUrl);
		const end = lastDay();
		return eachDay(addDays(end, -DEMO_HISTORY_DAYS), end).map((date) => {
			const f = dayFactor(date, end, s.brand + 'bing');
			return { date, clicks: Math.round(95 * s.scale * f), impressions: Math.round(2100 * s.scale * f) };
		});
	}
	private terms(siteUrl: string, words: string[]): BingTermRow[] {
		const s = siteOf(siteUrl);
		const end = lastDay();
		const out: BingTermRow[] = [];
		// Bing's query/page endpoints update weekly, so emit weekly rows.
		for (let d = addDays(end, -(Math.floor(DEMO_HISTORY_DAYS / 7) * 7)); d <= end; d = addDays(d, 7)) {
			words.forEach((w, i) => {
				const impressions = Math.round((220 * s.scale) / (1 + i * 0.5) * (0.8 + h01(s.brand, d, w) * 0.4));
				out.push({ date: d, term: w, clicks: Math.round(impressions * 0.04), impressions, clickPos: 4 + (i % 9) + h01(w, d), imprPos: 5 + (i % 9) });
			});
		}
		return out;
	}
	async queryStats(siteUrl: string) {
		const s = siteOf(siteUrl);
		return this.terms(siteUrl, [`${s.brand}`, `best ${s.topic}`, `${s.topic} price`, `how to choose ${s.topic}`, `${s.topic} reviews`, `buy ${s.topic} online`, `${s.topic} guide`]);
	}
	async pageStats(siteUrl: string) {
		const s = siteOf(siteUrl);
		const o = s.siteUrl.startsWith('sc-domain:') ? `https://${s.siteUrl.slice(10)}/` : s.siteUrl;
		return this.terms(siteUrl, [o, `${o}guides/${s.topic.replace(/\s+/g, '-')}-1`, `${o}products/${s.topic.replace(/\s+/g, '-')}-5`, `${o}blog/${s.topic.replace(/\s+/g, '-')}-10`]);
	}
}

export const DEMO_GA4_PROPERTIES = (accountSub: string): { prop: Ga4Property; url: string }[] =>
	(DEMO_ACCOUNTS.find((a) => a.sub === accountSub)?.sites ?? []).map((s, i) => ({
		prop: { property: `properties/${accountSub === 'demo-a' ? 1000 : 2000}${i}`, displayName: `${s.brand} (GA4)`, account: 'Demo account' },
		url: s.siteUrl.startsWith('sc-domain:') ? `https://www.${s.siteUrl.slice(10)}` : s.siteUrl
	}));

/** A GA4 measurement ID for a demo property. Real ones are "G-" plus ten letters and digits. */
export const demoGa4MeasurementId = (property: string) => `G-DEMO${property.replace(/\D/g, '')}`;

const gtmId = (brand: string) => 'GTM-' + brand.slice(0, 7).toUpperCase().padEnd(7, 'X');
const hostOfDemo = (siteUrl: string) => (siteUrl.startsWith('sc-domain:') ? siteUrl.slice(10) : new URL(siteUrl).hostname.replace(/^www\./, ''));

/**
 * Demo Tag Manager containers, one per demo site except northwind (no container, so the "unmatched" path is visible).
 * Planted problems, like the other demo data: pixelforge sends to the wrong GA4 ID and has a paused tag, trailmaps was
 * never published, ledgerly still has a Universal Analytics tag and no GA4 tag, coffeelab has a tag with no trigger.
 */
export function demoGtmContainers(): GtmContainer[] {
	return sites
		.filter((s) => s.brand !== 'northwind')
		.map((s, i) => ({
			path: `accounts/60000/containers/${7000 + i}`,
			publicId: gtmId(s.brand),
			name: hostOfDemo(s.siteUrl),
			// Domain names are optional in real containers; leave them empty for one so name-based matching is exercised too.
			domains: s.brand === 'coffeelab' ? [] : [hostOfDemo(s.siteUrl)],
			usage: ['web'],
			accountName: 'Demo Tag Manager account'
		}));
}

export function demoGtmLive(containerPath: string): GtmLive | null {
	const c = demoGtmContainers().find((x) => x.path === containerPath);
	if (!c) return null;
	const brand = sites.find((s) => hostOfDemo(s.siteUrl) === c.name)?.brand ?? '';
	if (brand === 'trailmaps') return null;
	const props = DEMO_ACCOUNTS.flatMap((a) => DEMO_GA4_PROPERTIES(a.sub));
	const prop = props.find((p) => p.prop.displayName.toLowerCase().startsWith(brand));
	const mid = brand === 'pixelforge' ? 'G-OLDSITE01' : prop ? demoGa4MeasurementId(prop.prop.property) : null;
	const trig = [
		{ id: '1', name: 'All Pages', type: 'pageview' },
		{ id: '2', name: 'Click: outbound link', type: 'linkClick' },
		{ id: '3', name: 'Form submit', type: 'formSubmission' }
	];
	const tag = (id: string, name: string, type: string, o: Partial<GtmLive['tags'][number]> = {}) => ({ id, name, type, paused: false, firing: ['All Pages'], blocking: [], measurementId: null, eventName: null, ...o });
	const tags: GtmLive['tags'] =
		brand === 'ledgerly'
			? [tag('1', 'UA - pageview', 'ua'), tag('2', 'Cookie banner', 'html')]
			: [
					tag('1', 'Google tag', 'googtag', { measurementId: mid }),
					tag('2', 'GA4 - outbound click', 'gaawe', { firing: ['Click: outbound link'], measurementId: mid, eventName: 'outbound_click' }),
					tag('3', 'GA4 - lead form', 'gaawe', { firing: ['Form submit'], measurementId: mid, eventName: 'generate_lead' }),
					...(brand === 'pixelforge' ? [tag('4', 'Old remarketing', 'sp', { paused: true })] : []),
					...(brand === 'coffeelab' ? [tag('4', 'Heatmap script', 'html', { firing: [] })] : [])
				];
	return {
		versionId: '12',
		versionName: 'Demo live version',
		tags,
		triggers: trig,
		variables: [
			{ id: '1', name: 'GA4 measurement ID', type: 'c' },
			{ id: '2', name: 'Page path', type: 'u' }
		]
	};
}

export function demoGa4Daily(property: string, startDate: string, endDate: string): Ga4Day[] {
	const all = DEMO_ACCOUNTS.flatMap((a) => DEMO_GA4_PROPERTIES(a.sub).map((p, i) => ({ p, s: a.sites[i] })));
	const s = all.find((x) => x.p.prop.property === property)?.s ?? sites[0];
	const end = lastDay();
	const channels: [string, number][] = [['Organic Search', 0.62], ['Direct', 0.2], ['Referral', 0.08], ['Organic Social', 0.06], ['Email', 0.04]];
	const out: Ga4Day[] = [];
	for (const date of eachDay(startDate < addDays(end, -DEMO_HISTORY_DAYS) ? addDays(end, -DEMO_HISTORY_DAYS) : startDate, endDate > end ? end : endDate)) {
		for (const [channel, share] of channels) {
			const f = dayFactor(date, end, s.brand + channel) * (channel === 'Organic Search' ? 1 : channel === 'Direct' ? 1 : 0.9);
			const sessions = Math.round(520 * s.scale * share * f);
			out.push({ date, channel, sessions, engagedSessions: Math.round(sessions * 0.62), users: Math.round(sessions * 0.8), keyEvents: Math.round(sessions * 0.03 * 10) / 10, pageviews: Math.round(sessions * 1.9) });
		}
	}
	return out;
}

/** A fetch stand-in so the real budget/sync code path runs against synthetic Clarity data. */
export function demoClarityFetch(): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const dim = url.searchParams.get('dimension1') ?? '';
		const key = dim || null;
		const row = (extra: Record<string, string | number>, i = 0) => ({ ...(key ? { [key]: String(extra._k ?? `v${i}`) } : {}), ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== '_k')) });
		const values = dim === 'URL' ? ['/guides/garden-tools-1', '/products/garden-tools-5', '/blog/garden-tools-10', '/'] : dim === 'Device' ? ['Mobile', 'PC', 'Tablet'] : [null];
		const body: ClarityMetric[] = [
			{ metricName: 'Traffic', information: values.map((v, i) => row({ _k: v ?? '', totalSessionCount: String(3200 - i * 600), totalBotSessionCount: String(240 - i * 40), distantUserCount: String(2700 - i * 500), PagesPerSessionPercentage: 1.9 + i * 0.1 }, i)) },
			{ metricName: 'DeadClickCount', information: values.map((v, i) => row({ _k: v ?? '', sessionsCount: String(120 - i * 20), sessionsWithMetricPercentage: 3.7 - i * 0.4 }, i)) },
			{ metricName: 'RageClickCount', information: values.map((v, i) => row({ _k: v ?? '', sessionsCount: String(36 - i * 6), sessionsWithMetricPercentage: 1.1 - i * 0.1 }, i)) }
		];
		return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
	}) as typeof fetch;
}

export function demoOpenSeoProjects() {
	return [
		{ id: 'demo-proj-greenleaf', name: 'Greenleaf (demo)', domain: 'greenleaf.example', url: 'https://openseo.example/p/demo-proj-greenleaf' },
		{ id: 'demo-proj-trailmaps', name: 'Trailmaps (demo)', domain: 'trailmaps.example', url: 'https://openseo.example/p/demo-proj-trailmaps' },
		{ id: 'demo-proj-other', name: 'Unrelated project', domain: 'unrelated.example', url: 'https://openseo.example/p/demo-proj-other' }
	];
}

/** Demo: unique users per channel over a window (about 60% of summed daily users, since people return). */
export function demoGa4UsersByChannel(property: string, start: string, end: string): { channel: string; users: number }[] {
	const sum = new Map<string, number>();
	for (const r of demoGa4Daily(property, start, end)) sum.set(r.channel, (sum.get(r.channel) ?? 0) + r.users);
	return [...sum].map(([channel, users]) => ({ channel, users: Math.round(users * 0.6) }));
}

/** Demo: Google-organic landing pages derived from the demo Search Console pages, so the two sources line up. */
export async function demoGa4Landing(property: string, start: string, end: string): Promise<{ page: string; sessions: number; engagedSessions: number; keyEvents: number }[]> {
	for (const a of DEMO_ACCOUNTS) {
		const i = DEMO_GA4_PROPERTIES(a.sub).findIndex((p) => p.prop.property === property);
		if (i < 0) continue;
		const rows = await new DemoClient(a.sub).query(a.sites[i].siteUrl, { startDate: start, endDate: end, dimensions: ['page'], rowLimit: 5000 });
		return rows.map((r) => ({ page: new URL(r.keys[0]).pathname, sessions: Math.round(r.clicks * 1.12) + 1, engagedSessions: Math.round(r.clicks * 0.7), keyEvents: Math.round(r.clicks * 0.04 * 10) / 10 }));
	}
	return [];
}

/** Demo CrUX: a fetch stand-in. Some sites have field data, the rest answer 404 ("not enough traffic"), like the real API. */
export function demoCruxFetch(): typeof fetch {
	return (async (_url: RequestInfo | URL, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body ?? '{}')) as { origin?: string; formFactor?: string };
		const host = hostKey(body.origin ?? '');
		const phone = body.formFactor === 'PHONE';
		if (h01(host, 'crux') < 0.25 || (body.origin ?? '').includes('://www.') !== (h01(host, 'www') > 0.5)) return new Response(JSON.stringify({ error: { code: 404, message: 'chrome ux report data not found' } }), { status: 404 });
		const r = (k: string, base: number, spread: number) => base * (phone ? 1.25 : 0.85) * (1 + (h01(host, k) - 0.5) * spread);
		// The good share must agree with the p75 the way real data does: p75 within "good" means at least 75% of loads were good.
		const metric = (p75: number, good: number, poor: number, seed: string, text = false) => {
			const jitter = h01(host, seed, phone ? 'p' : 'd');
			const share = p75 <= good ? 0.76 + jitter * 0.19 : p75 <= poor ? 0.4 + jitter * 0.34 : 0.2 + jitter * 0.2;
			return { histogram: [{ start: 0, end: good, density: Math.round(share * 100) / 100 }], percentiles: { p75: text ? p75.toFixed(2) : p75 } };
		};
		return new Response(
			JSON.stringify({
				record: {
					metrics: {
						largest_contentful_paint: metric(Math.round(r('lcp', 2300, 1.2)), 2500, 4000, 'lg'),
						interaction_to_next_paint: metric(Math.round(r('inp', 190, 1.4)), 200, 500, 'ig'),
						cumulative_layout_shift: metric(Number(r('cls', 0.08, 1.6).toFixed(2)), 0.1, 0.25, 'cg', true),
						first_contentful_paint: metric(Math.round(r('fcp', 1700, 1.0)), 1800, 3000, 'fg'),
						experimental_time_to_first_byte: metric(Math.round(r('ttfb', 700, 1.0)), 800, 1800, 'tg')
					}
				}
			}),
			{ status: 200 }
		);
	}) as typeof fetch;
}
