import { db } from './db';
import { config } from './config';
import { allSites } from './queries';
import { bestMatch, hostsMatch } from './hosts';
import { BingApiError, RealBingClient } from './bing';
import { bingClientFor, ga4SourceFor } from './channels';
import { fetchInsights, ClarityApiError, utcDay } from './clarity';
import { demoClarityFetch, demoOpenSeoProjects } from './demo-channels';
import { listOpenSeoProjects } from './openseo';
import { getIntegration, integrationMeta, linksFor, listIntegrations, removeIntegration, saveIntegration, setLink } from './links';
import { enqueueCruxSync, enqueueLinkSync } from './jobs';
import { CruxError, queryOrigin } from './crux';
import { audit } from './db';
import { SCOPE_GA4 } from './ga4';

const visibleSites = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));

export const hasGa4Scope = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.includes(SCOPE_GA4);

// ── Bing ─────────────────────────────────────────────────────────────────────
export function autoMatchBing(integrationId: number) {
	return bingClientFor(integrationId).listSites().then((bingSites) => {
		const verified = bingSites.filter((s) => s.isVerified);
		let matched = 0;
		const linked = new Set<string>();
		for (const site of visibleSites()) {
			if (linksFor(site.id).bing) continue;
			const m = bestMatch(site.site_url, verified, (b) => b.url);
			if (!m) continue;
			setLink(site.id, 'bing', { integrationId, externalId: m.url, label: m.url });
			enqueueLinkSync(site.id, 'bing');
			linked.add(m.url);
			matched++;
		}
		return { matched, bingSites: bingSites.length, unmatchedBing: verified.filter((b) => !linked.has(b.url) && !allSites().some((s) => linksFor(s.id).bing?.external_id === b.url)).map((b) => b.url), unverified: bingSites.filter((s) => !s.isVerified).map((s) => s.url) };
	});
}

export async function connectBingKey(apiKey: string, label: string) {
	const key = apiKey.trim();
	if (!key) throw new BingApiError('Paste your Bing Webmaster API key', 400);
	const demo = config.demo && key === 'demo';
	const id = saveIntegration('bing', label.trim() || 'Bing Webmaster', { apiKey: key }, { auth: 'apikey' }, demo);
	try {
		const result = await autoMatchBing(id); // also validates the key: GetUserSites fails on a bad one
		audit('bing.connected', { detail: label });
		return { id, ...result };
	} catch (e) {
		removeIntegration(id);
		throw e;
	}
}

export function saveBingOAuth(tokens: { access_token: string; refresh_token?: string; expires_in?: number }, label: string) {
	return saveIntegration('bing', label, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000 }, { auth: 'oauth' });
}

// ── GA4 ──────────────────────────────────────────────────────────────────────
export async function autoMatchGa4() {
	const accounts = db().prepare("SELECT id, scopes, is_demo, email FROM accounts WHERE status = 'active'").all() as { id: number; scopes: string; is_demo: number; email: string }[];
	let matched = 0;
	const ambiguous: string[] = [];
	const noScope: string[] = [];
	const unmatchedSites: string[] = [];
	const sites = visibleSites().filter((s) => !linksFor(s.id).ga4);
	for (const acc of accounts) {
		if (!hasGa4Scope(acc)) {
			noScope.push(acc.email);
			continue;
		}
		const mine = sites.filter((s) => s.account_id === acc.id && !linksFor(s.id).ga4);
		if (!mine.length) continue;
		const src = ga4SourceFor(acc.id);
		const props = (await src.listProperties()).slice(0, 100);
		const withUrls: { property: string; displayName: string; urls: string[] }[] = [];
		let i = 0;
		await Promise.all(Array.from({ length: 4 }, async () => {
			while (i < props.length) {
				const p = props[i++];
				withUrls.push({ ...p, urls: await src.streamUrls(p.property).catch(() => []) });
			}
		}));
		for (const site of mine) {
			const cands = withUrls.filter((p) => p.urls.some((u) => hostsMatch(u, site.site_url)));
			if (cands.length === 1) {
				setLink(site.id, 'ga4', { accountId: acc.id, externalId: cands[0].property, label: cands[0].displayName });
				enqueueLinkSync(site.id, 'ga4');
				matched++;
			} else if (cands.length > 1) ambiguous.push(site.site_url);
			else unmatchedSites.push(site.site_url);
		}
	}
	return { matched, ambiguous, unmatchedSites, noScope };
}

export async function listGa4Candidates(accountId: number) {
	return ga4SourceFor(accountId).listProperties();
}

// ── Clarity ──────────────────────────────────────────────────────────────────
export async function connectClarity(siteId: number, token: string) {
	const t = token.trim();
	if (!t) throw new ClarityApiError('Paste the Clarity API token', 400);
	const site = allSites({ includeHidden: true }).find((s) => s.id === siteId);
	if (!site) throw new Error('Unknown site');
	const demo = config.demo && t === 'demo';
	const id = saveIntegration('clarity', site.label || site.site_url, { token: t }, {}, demo);
	try {
		// The test call is not wasted: it becomes today's first snapshot.
		const payload = await fetchInsights(id, t, { numOfDays: 1 }, demo ? demoClarityFetch() : fetch);
		db().prepare('INSERT OR REPLACE INTO clarity_snapshots VALUES (?,?,?,?,?)').run(siteId, utcDay(), '', JSON.stringify(payload), Date.now());
	} catch (e) {
		removeIntegration(id);
		throw e;
	}
	const old = linksFor(siteId).clarity?.integration_id;
	setLink(siteId, 'clarity', { integrationId: id, externalId: site.site_url, label: 'Clarity project' });
	if (old) removeIntegration(old);
	audit('clarity.connected', { siteId });
	return { id };
}

// ── OpenSEO ──────────────────────────────────────────────────────────────────
export async function connectOpenSeo(baseUrl: string, apiKey: string) {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/\S+$/.test(base)) throw new Error('Enter your OpenSEO URL, e.g. https://openseo.example.com');
	const demo = config.demo && apiKey.trim() === 'demo';
	const projects = demo ? demoOpenSeoProjects() : await listOpenSeoProjects(base, apiKey.trim());
	const id = saveIntegration('openseo', new URL(base).host, { apiKey: apiKey.trim() }, { baseUrl: base }, demo);
	let matched = 0;
	const unmatchedProjects: string[] = [];
	const linkedProjects = new Set<string>();
	for (const site of visibleSites()) {
		const withDomain = projects.filter((p) => p.domain);
		const m = bestMatch(site.site_url, withDomain, (p) => p.domain!);
		if (!m) continue;
		setLink(site.id, 'openseo', { integrationId: id, externalId: m.id, label: m.name });
		linkedProjects.add(m.id);
		matched++;
	}
	for (const p of projects) if (!linkedProjects.has(p.id)) unmatchedProjects.push(`${p.name}${p.domain ? ` (${p.domain})` : ''}`);
	// Replace any older OpenSEO connection that no longer has links.
	for (const old of listIntegrations('openseo')) if (old.id !== id) removeIntegration(old.id);
	audit('openseo.connected', { detail: base });
	return { id, matched, projects: projects.length, unmatchedProjects };
}

export const openSeoProjectUrl = (integrationId: number | null, projectId: string) => {
	if (!integrationId) return null;
	const i = getIntegration(integrationId);
	return i ? `${integrationMeta(i).baseUrl ?? ''}/p/${projectId}` : null;
};

// ── Core Web Vitals (Chrome UX Report) ───────────────────────────────────────
export async function connectCrux(apiKey: string) {
	const key = apiKey.trim();
	if (!key) throw new CruxError('Paste your Google API key', 400);
	const demo = config.demo && key === 'demo';
	// Validate the key against an origin with lots of traffic: 200 or "no data" both prove the key and API are fine.
	if (!demo) await queryOrigin(key, 'https://web.dev', 'PHONE');
	for (const i of listIntegrations('crux')) removeIntegration(i.id);
	const id = saveIntegration('crux', 'Chrome UX Report', { apiKey: key }, {}, demo);
	audit('crux.connected');
	const sites = visibleSites().filter((s) => !s.hidden);
	for (const s of sites) enqueueCruxSync(s.id);
	return { id, sites: sites.length };
}
