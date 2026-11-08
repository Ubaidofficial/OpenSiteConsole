import type { BingClient, BingDay, BingSite, BingTermRow } from './bing';
import type { Ga4Day, Ga4Property } from './ga4';
import type { ClarityMetric } from './clarity';
import type { GtmContainer, GtmLive } from './gtm';
import { DEMO_ACCOUNTS, DEMO_HISTORY_DAYS, DemoClient, demoSearches, h01, plantedQuery } from './demo';
import { addDays, eachDay, pacificToday } from './dates';
import { hostKey } from './hosts';
import { db } from './db';
import { claritySnippet } from '../clarityinstall';

/** The Clarity project the demo greenleaf site's pages load. */
export const DEMO_CLARITY_ID = 'gl4demo7x2';
/** Demo containers that "installed" Clarity through SEOConsole (container path -> project ID), until the server restarts. */
export const demoInstalled = new Map<string, string>();

const sites = DEMO_ACCOUNTS.flatMap((a) => a.sites);
const siteOf = (urlOrHost: string) => sites.find((s) => hostKey(s.siteUrl) === hostKey(urlOrHost)) ?? sites[0];
const lastDay = () => addDays(pacificToday(), -2);
const dayFactor = (date: string, end: string, seed: string) => {
	const age = (Date.parse(end) - Date.parse(date)) / 86_400_000;
	const dow = new Date(date + 'T00:00:00Z').getUTCDay();
	return (dow === 0 || dow === 6 ? 0.72 : 1.05) * (0.85 + h01(seed, date) * 0.3) * (age === 17 ? 0.5 : 1);
};

export class DemoBing implements BingClient {
	/** Demo: Bing "accepts" every submission and keeps a small daily allowance so the quota message can be seen. */
	async submitUrlBatch(): Promise<void> {}
	async urlSubmissionQuota(): Promise<{ daily: number | null; monthly: number | null }> {
		return { daily: 10_000, monthly: 300_000 };
	}
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
	/** `words` may carry a fixed Bing position (for the planted "Bing ranks you, Google does not" search). */
	private terms(siteUrl: string, words: (string | [string, number])[]): BingTermRow[] {
		const s = siteOf(siteUrl);
		const end = lastDay();
		const out: BingTermRow[] = [];
		// Bing's query/page endpoints update weekly, so emit weekly rows.
		for (let d = addDays(end, -(Math.floor(DEMO_HISTORY_DAYS / 7) * 7)); d <= end; d = addDays(d, 7)) {
			words.forEach((entry, i) => {
				const [w, fixed] = typeof entry === 'string' ? [entry, null] : entry;
				const impressions = Math.round((220 * s.scale) / (1 + i * 0.5) * (0.8 + h01(s.brand, d, w) * 0.4));
				const pos = fixed ?? 5 + (i % 9);
				out.push({ date: d, term: w, clicks: Math.round(impressions * (fixed ? 0.12 : 0.04)), impressions, clickPos: pos - 1 + h01(w, d), imprPos: pos });
			});
		}
		return out;
	}
	async queryStats(siteUrl: string) {
		const s = siteOf(siteUrl);
		return this.terms(siteUrl, [`${s.brand}`, [plantedQuery(s.topic, 'bing'), 2], `best ${s.topic}`, `${s.topic} price`, `how to choose ${s.topic}`, `${s.topic} reviews`, `buy ${s.topic} online`, `${s.topic} guide`]);
	}
	async pageStats(siteUrl: string) {
		const s = siteOf(siteUrl);
		const o = s.siteUrl.startsWith('sc-domain:') ? `https://${s.siteUrl.slice(10)}/` : s.siteUrl;
		// Most of the site's pages, with three left out so "Pages Bing shows nothing for" has something to show.
		const slug = s.topic.replace(/\s+/g, '-');
		const pages = Array.from({ length: 14 }, (_, i) => `${o}${i < 3 ? 'guides' : i < 8 ? 'products' : 'blog'}/${slug}-${i + 1}`).filter((_, i) => ![3, 8, 12].includes(i));
		return this.terms(siteUrl, [o, ...pages]);
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
					// a Clarity tag someone added but never gave a trigger: the Clarity check flags it
					...(brand === 'coffeelab' ? [tag('4', 'Heatmap script', 'html', { firing: [], clarity: true, clarityId: 'cf8demo3k1' })] : [])
				];
	const added = demoInstalled.get(containerPath);
	if (added) tags.push(tag('99', 'Microsoft Clarity (added by SEOConsole)', 'html', { clarity: true, clarityId: added }));
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
export function demoClarityFetch(siteUrl?: string): typeof fetch {
const s = siteUrl ? siteOf(siteUrl) : sites[0];
const slug = s.topic.replace(/\s+/g, '-');
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const dim = url.searchParams.get('dimension1') ?? '';
		const key = dim || null;
		const row = (extra: Record<string, string | number>, i = 0) => ({ ...(key ? { [key]: String(extra._k ?? `v${i}`) } : {}), ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== '_k')) });
		// By URL: the site's own pages. The products page is the planted problem: 19 of its 140 sessions had dead clicks.
		const values = dim === 'URL' ? ['/', `/guides/${slug}-1`, `/products/${slug}-6`, `/blog/${slug}-10`] : dim === 'Device' ? ['Mobile', 'PC', 'Tablet'] : [null];
		const sess = dim === 'URL' ? [3200, 900, 140, 600] : [3200, 2600, 2000];
		const dead = dim === 'URL' ? [120, 30, 19, 14] : [120, 100, 80];
		const rage = dim === 'URL' ? [36, 8, 11, 4] : [36, 30, 24];
		// pixelforge and northwind have no Clarity script (see demoPageFetch), so they record nothing until it is installed through Tag Manager
		const container = demoGtmContainers().find((c) => c.name === hostOfDemo(s.siteUrl))?.path;
		if ((s.brand === 'pixelforge' || s.brand === 'northwind') && !(container && demoInstalled.has(container))) {
			sess.fill(0);
			dead.fill(0);
			rage.fill(0);
		}
		const pct = (n: number, d: number) => Math.round((n / d) * 1000) / 10;
		const body: ClarityMetric[] = [
			{ metricName: 'Traffic', information: values.map((v, i) => row({ _k: v ?? '', totalSessionCount: String(sess[i]), totalBotSessionCount: String(Math.round(sess[i] * 0.07)), distantUserCount: String(Math.round(sess[i] * 0.84)), PagesPerSessionPercentage: 1.9 + i * 0.1 }, i)) },
			{ metricName: 'DeadClickCount', information: values.map((v, i) => row({ _k: v ?? '', sessionsCount: String(dead[i]), sessionsWithMetricPercentage: pct(dead[i], sess[i]) }, i)) },
			{ metricName: 'RageClickCount', information: values.map((v, i) => row({ _k: v ?? '', sessionsCount: String(rage[i]), sessionsWithMetricPercentage: pct(rage[i], sess[i]) }, i)) }
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
		// Planted by traffic rank, so they hold whatever the window: the 2nd busiest page never converts, the 3rd loses most of
		// its visitors, and two pages further down engage and convert far better than the rest (the "hidden gems").
		return rows.map((r, rank) => {
			const sessions = Math.round(r.clicks * 1.12) + 1;
			const gem = rank === 5 || rank === 8;
			const engaged = rank === 2 ? 0.24 : gem ? 0.86 : 0.62;
			const keyRate = rank === 1 ? 0 : gem ? 0.09 : 0.035;
			return { page: new URL(r.keys[0]).pathname, sessions, engagedSessions: Math.round(sessions * engaged), keyEvents: Math.round(sessions * keyRate * 10) / 10 };
		});
	}
	return [];
}

type DemoAssistant = 'ChatGPT' | 'Perplexity' | 'Gemini' | 'Claude' | 'Copilot';
const AI_SHARES: [DemoAssistant, number][] = [['ChatGPT', 0.55], ['Perplexity', 0.2], ['Gemini', 0.13], ['Claude', 0.08], ['Copilot', 0.04]];
const siteOfProperty = (property: string) => DEMO_ACCOUNTS.flatMap((a) => DEMO_GA4_PROPERTIES(a.sub).map((p, i) => ({ p, s: a.sites[i] }))).find((x) => x.p.prop.property === property)?.s ?? sites[0];

/**
 * The planted LLM-test pages of a demo site: AI-assistant sessions to `liftPage` rise about 2.4x from `changeDate` (as if it had been
 * rewritten for AI answers), `flatPage` was "changed" on the same day and nothing happened. A demo LLM test on the first comes out
 * positive; on the second it shows no clear effect.
 */
export function demoAiPlant(siteUrl: string, today = pacificToday()) {
	const slug = siteOf(siteUrl).topic.replace(/\s+/g, '-');
	return { liftPage: `/blog/${slug}-9`, flatPage: `/products/${slug}-4`, changeDate: addDays(today, -2 - 42) };
}

/**
 * Demo AI-assistant sessions by day, assistant and landing page. Each page has its own steady level (ChatGPT the largest share),
 * with a weekly pattern, gentle growth common to the whole site and day-to-day noise, plus the planted change of demoAiPlant.
 * Counts are small, as real AI traffic is, and whole numbers (randomised rounding keeps the averages right).
 */
export function demoGa4AiDaily(property: string, startDate: string, endDate: string): { date: string; assistant: DemoAssistant; page: string; sessions: number; keyEvents: number }[] {
	const s = siteOfProperty(property);
	const slug = s.topic.replace(/\s+/g, '-');
	const plant = demoAiPlant(s.siteUrl);
	const end = lastDay();
	// Expected AI sessions a day for each page at the start of the history (all assistants together).
	const base: [string, number][] = [['/', 4], ...[3.5, 3, 2.5, 5, 1.5, 1.2, 1, 0.8, 3, 2, 1.5, 1.2, 1, 0.6].map((v, i): [string, number] => [`/${i < 3 ? 'guides' : i < 8 ? 'products' : 'blog'}/${slug}-${i + 1}`, v])];
	const out: ReturnType<typeof demoGa4AiDaily> = [];
	const from = startDate < addDays(end, -DEMO_HISTORY_DAYS) ? addDays(end, -DEMO_HISTORY_DAYS) : startDate;
	for (const date of eachDay(from, endDate > end ? end : endDate)) {
		const age = (Date.parse(end) - Date.parse(date)) / 86_400_000;
		const dow = new Date(date + 'T00:00:00Z').getUTCDay();
		const common = (dow === 0 || dow === 6 ? 0.75 : 1.08) * (1 + ((DEMO_HISTORY_DAYS - age) / DEMO_HISTORY_DAYS) * 0.4);
		const since = Math.round((Date.parse(date) - Date.parse(plant.changeDate)) / 86_400_000);
		for (const [page, level] of base) {
			// the planted rise builds over the first week after the change, as pages are re-read by the assistants
			const lift = page === plant.liftPage && since >= 0 ? 1 + 1.4 * Math.min(1, (since + 1) / 7) : 1;
			const mean = level * s.scale * common * lift * (0.8 + h01(property, date, page) * 0.4);
			for (const [assistant, share] of AI_SHARES) {
				const sessions = Math.floor(mean * share + h01(property, date, page, assistant));
				if (sessions > 0) out.push({ date, assistant, page, sessions, keyEvents: Math.round(sessions * 0.05 * 10) / 10 });
			}
		}
	}
	return out;
}

/** Demo AI-assistant sessions over a whole window, by assistant and landing page: the daily figures summed, so the two views agree. */
export async function demoGa4AiTraffic(property: string, start: string, end: string): Promise<{ assistant: DemoAssistant; page: string; sessions: number; engagedSessions: number; keyEvents: number }[]> {
	const sum = new Map<string, { assistant: DemoAssistant; page: string; sessions: number; engagedSessions: number; keyEvents: number }>();
	for (const r of demoGa4AiDaily(property, start, end)) {
		const k = `${r.assistant}\n${r.page}`;
		const cur = sum.get(k) ?? { assistant: r.assistant, page: r.page, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += r.sessions;
		cur.keyEvents += r.keyEvents;
		sum.set(k, cur);
	}
	return [...sum.values()].map((r) => ({ ...r, engagedSessions: Math.round(r.sessions * 0.7), keyEvents: Math.round(r.keyEvents * 10) / 10 }));
}

/**
 * Demo page fetcher for the on-page check (demo sites are .example domains that do not exist). Pages get deterministic
 * HTML with planted problems: some lack a meta description, some have a generic title, one is noindex, one has two H1s.
 */
const SENTENCES = [
	(q: string) => `If you are comparing options, our notes on ${q} cover what matters most.`,
	(q: string) => `Readers often ask about ${q} before they buy anything.`,
	(q: string) => `We tested a lot of gear while writing about ${q}, and the differences were bigger than expected.`,
	(q: string) => `A short checklist helps with ${q}: decide the budget first, then the features.`,
	(q: string) => `${q[0].toUpperCase() + q.slice(1)} comes up in almost every conversation we have with new customers.`,
	(q: string) => `There is no single answer to ${q}, but a few rules of thumb help.`
];

/**
 * Demo page body: a menu (home and three section pages), a main column whose sentences mention searches that OTHER pages rank for
 * (so the internal-link tool has mentions to find), two links in the text to other pages, and a footer. Deterministic per page.
 */
function demoBody(siteUrl: string, topic: string, url: URL, h1: string): string {
	const searches = demoSearches(siteUrl);
	const pages = [...new Set(searches.flatMap((s) => s.pages))].map((p) => new URL(p).pathname).sort((a, b) => Number(a.split('-').pop()) - Number(b.split('-').pop()));
	const slug = topic.replace(/\s+/g, '-');
	const here = url.pathname;
	const nav = `<header><nav><a href="/">Home</a> <a href="/guides/${slug}-1">Guides</a> <a href="/products/${slug}-4">Products</a> <a href="/blog/${slug}-9">Blog</a></nav></header>`;
	const others = searches.filter((s) => !s.pages.some((p) => new URL(p).pathname === here));
	const picked = others.map((s, i) => ({ s, k: h01(siteUrl, here, 'mention', i) })).sort((a, b) => a.k - b.k).slice(0, 7);
	const sentences = picked.map(({ s }, i) => SENTENCES[Math.floor(h01(here, s.q, i) * SENTENCES.length)](s.q));
	const paras = [`<p>This page is part of our ${topic} section, written for people who want to get the basics right.</p>`];
	for (let i = 0; i < sentences.length; i += 3) paras.push(`<p>${sentences.slice(i, i + 3).join(' ')}</p>`);
	const linkTo = pages.filter((p) => p !== here).map((p, i) => ({ p, k: h01(siteUrl, here, 'link', i) })).sort((a, b) => a.k - b.k).slice(0, 2).map((x) => x.p);
	if (linkTo.length) paras.push(`<p>See also <a href="${linkTo[0]}">our ${topic} notes</a>${linkTo[1] ? ` and <a href="${linkTo[1]}">this related page</a>` : ''}.</p>`);
	return `${nav}<main>${h1}${paras.join('')}</main><footer><a href="/about">About</a> <a href="/contact">Contact</a> <a href="mailto:hello@${hostKey(siteUrl)}">Email us</a></footer>`;
}

export function demoPageFetch(siteUrl: string): typeof fetch {
	const host = hostKey(siteUrl);
	const def = sites.find((s) => hostKey(s.siteUrl) === host) ?? sites[0];
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		const r = h01(host, url.pathname);
		const slug = url.pathname.split('/').filter(Boolean).pop() ?? 'home';
		if (r < 0.06) return new Response('gone', { status: 404 });
		const words = slug.replace(/-\d+$/, '').replace(/-/g, ' ');
		const title = r < 0.3 ? `Home | ${def.brand}` : `${def.topic} - ${words} | ${def.brand}`;
		const desc = r > 0.55 && r < 0.75 ? '' : `<meta name="description" content="A practical guide to ${def.topic}: ${words}.">`;
		const robots = r > 0.94 ? '<meta name="robots" content="noindex,follow">' : '';
		const h1 = r > 0.8 && r < 0.9 ? '' : `<h1>${r < 0.45 ? words : def.topic}</h1>${r > 0.9 && r <= 0.94 ? '<h1>Welcome</h1>' : ''}`;
		// Tracking snippets, so the Clarity check has every case: Clarity in the page (greenleaf), Tag Manager only (the rest), nothing (northwind).
		const gtmSnip = def.brand === 'northwind' ? '' : `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s);j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId(def.brand)}');</script>`;
		const claritySnip = def.brand === 'greenleaf' ? claritySnippet(DEMO_CLARITY_ID) : '';
		const html = `<!doctype html><html lang="en"><head><title>${title}</title>${desc}${robots}<link rel="canonical" href="${url.href}">${gtmSnip}${claritySnip}</head><body>${demoBody(def.siteUrl, def.topic, url, h1)}</body></html>`;
		return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
	}) as typeof fetch;
}

/**
 * Demo robots.txt: ordinary rules that block nothing earning clicks (cart, internal search, sorted lists), a stricter group for
 * one other crawler, and the sitemap. Anything else on the host is a 404.
 */
export function demoRobotsFetch(siteUrl: string): typeof fetch {
	const def = siteOf(siteUrl);
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (url.pathname !== '/robots.txt') return new Response('not found', { status: 404 });
		const body = [
			`# robots.txt for ${def.brand}`,
			'User-agent: *',
			'Disallow: /cart/',
			'Disallow: /search',
			'Disallow: /*?sort=',
			'Allow: /search/help',
			'',
			'User-agent: ExampleScraperBot',
			'Disallow: /',
			'',
			`Sitemap: ${url.origin}/sitemap.xml`
		].join('\n');
		return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
	}) as typeof fetch;
}

/**
 * Demo sitemap: every page Search Console has shown for the site, minus two of them (so "earns clicks but missing from the
 * sitemap" has something to show), plus pages that were never shown (some old, some new), so the coverage view has all its cases.
 */
export function demoSitemapFetch(siteId: number): typeof fetch {
	return (async (input: RequestInfo | URL) => {
		const url = new URL(String(input));
		if (!url.pathname.endsWith('sitemap.xml')) return new Response('not found', { status: 404 });
		const rows = db().prepare('SELECT page, SUM(clicks) c FROM sa_rows WHERE site_id = ? GROUP BY page ORDER BY c DESC').all(siteId) as { page: string; c: number }[];
		const origin = `${url.protocol}//${url.host}`;
		const today = pacificToday();
		const entries = [
			...rows.slice(0, Math.max(0, rows.length - 2)).map((r) => ({ loc: r.page, lastmod: addDays(today, -40 - (r.page.length % 30)) })),
			...Array.from({ length: 6 }, (_, i) => ({ loc: `${origin}/guides/archive-2019-${i + 1}`, lastmod: '2019-06-0' + (i + 1) })),
			...Array.from({ length: 2 }, (_, i) => ({ loc: `${origin}/blog/just-published-${i + 1}`, lastmod: addDays(today, -3 - i) }))
		];
		const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${entries.map((e) => `<url><loc>${e.loc.replace(/&/g, '&amp;')}</loc><lastmod>${e.lastmod}</lastmod></url>`).join('')}</urlset>`;
		return new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } });
	}) as typeof fetch;
}

/**
 * Demo GA4 organic sessions and key events by day and landing page, derived from the demo Search Console pages so the two line up
 * (sessions a little above clicks, key events about 4% of sessions with a stable per-page rate), as in real data.
 */
export async function demoGa4OrganicDaily(property: string, start: string, end: string): Promise<{ date: string; page: string; sessions: number; keyEvents: number }[]> {
	for (const a of DEMO_ACCOUNTS) {
		const i = DEMO_GA4_PROPERTIES(a.sub).findIndex((p) => p.prop.property === property);
		if (i < 0) continue;
		const rows = await new DemoClient(a.sub).query(a.sites[i].siteUrl, { startDate: start, endDate: end, dimensions: ['date', 'page'], rowLimit: 500_000 });
		return rows.map((r) => {
			const page = new URL(r.keys[1]).pathname;
			const sessions = Math.round(r.clicks * 1.12) + (r.clicks > 0 ? 1 : 0);
			return { date: r.keys[0], page, sessions, keyEvents: Math.round(sessions * (0.02 + 0.04 * h01(property, page)) * 10) / 10 };
		});
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
