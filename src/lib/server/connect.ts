import { db } from './db';
import { config } from './config';
import { allSites } from './queries';
import { bestMatch, hostKey, hostsMatch } from './hosts';
import { BingApiError, RealBingClient } from './bing';
import { bingClientFor, ga4SourceFor, gtmSourceFor } from './channels';
import { containerHosts, isWebContainer, type GtmContainer } from './gtm';
import { fetchInsights, ClarityApiError, utcDay } from './clarity';
import { demoClarityFetch, demoOpenSeoProjects } from './demo-channels';
import { listOpenSeoProjects } from './openseo';
import { getIntegration, integrationMeta, linksFor, listIntegrations, removeIntegration, saveIntegration, setLink } from './links';
import { enqueueCruxSync, enqueueLinkSync } from './jobs';
import { CruxError, queryOrigin } from './crux';
import { audit } from './db';
import { SCOPE_GA4 } from './ga4';
import { SCOPE_GTM_READ } from './google';

const visibleSites = () => allSites().filter((s) => !['siteUnverifiedUser', 'none'].includes(s.permission));

export const hasGa4Scope = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.includes(SCOPE_GA4);
export const hasGtmScope = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.includes(SCOPE_GTM_READ);

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

// ── Tag Manager ──────────────────────────────────────────────────────────────
/**
 * Link each unlinked site to the web container whose domain (or, failing that, name) matches it. Unlike GA4 this looks across
 * every account that has Tag Manager access, because the person who manages tags is often not the Search Console owner.
 */
export async function autoMatchGtm() {
	const accounts = (db().prepare("SELECT id, scopes, is_demo, email FROM accounts WHERE status = 'active' ORDER BY id").all() as { id: number; scopes: string; is_demo: number; email: string }[]);
	const noScope = accounts.filter((a) => !hasGtmScope(a)).map((a) => a.email);
	let matched = 0;
	const ambiguous: string[] = [];
	const used = new Set<string>();
	for (const acc of accounts.filter(hasGtmScope)) {
		const sites = visibleSites().filter((s) => !linksFor(s.id).gtm);
		if (!sites.length) break;
		const containers = (await gtmSourceFor(acc.id).listContainers()).filter(isWebContainer);
		for (const site of sites) {
			const cands = containers.filter((c) => containerHosts(c).some((h) => hostsMatch(h, site.site_url)));
			const exact = cands.filter((c) => containerHosts(c).some((h) => hostKey(h) === hostKey(site.site_url)));
			const pick: GtmContainer | undefined = exact.length === 1 ? exact[0] : exact.length === 0 && cands.length === 1 ? cands[0] : undefined;
			if (!pick) {
				if (cands.length > 1) ambiguous.push(site.site_url);
				continue;
			}
			setLink(site.id, 'gtm', { accountId: acc.id, externalId: pick.path, label: `${pick.publicId} · ${pick.name}` });
			enqueueLinkSync(site.id, 'gtm');
			used.add(pick.path);
			matched++;
		}
	}
	const unmatchedSites = visibleSites().filter((s) => !linksFor(s.id).gtm && !ambiguous.includes(s.site_url)).map((s) => s.site_url);
	return { matched, ambiguous, unmatchedSites, noScope };
}

/** Link a site by hand to a container given as GTM-XXXXXXX or accounts/123/containers/456, looked up in the connected accounts. */
export async function linkGtmManually(siteId: number, ref: string) {
	const want = ref.trim();
	if (!/^(GTM-[A-Z0-9]+|accounts\/\d+\/containers\/\d+)$/i.test(want)) throw new Error('Enter a container ID like GTM-ABC1234, or a path like accounts/123/containers/456.');
	for (const acc of db().prepare("SELECT id, scopes, is_demo FROM accounts WHERE status = 'active' ORDER BY id").all() as { id: number; scopes: string; is_demo: number }[]) {
		if (!hasGtmScope(acc)) continue;
		const hit = (await gtmSourceFor(acc.id).listContainers()).find((c) => c.publicId.toLowerCase() === want.toLowerCase() || c.path === want);
		if (!hit) continue;
		setLink(siteId, 'gtm', { accountId: acc.id, externalId: hit.path, label: `${hit.publicId} · ${hit.name}` });
		enqueueLinkSync(siteId, 'gtm');
		return hit;
	}
	throw new Error(`No container ${want} is visible to your connected Google accounts (they need Tag Manager access; reconnect them if it was never granted).`);
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
		const payload = await fetchInsights(id, t, { numOfDays: 1 }, demo ? demoClarityFetch(site.site_url) : fetch);
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

/**
 * A URL the server will call with a stored key. A self-hosted OpenSEO can legitimately sit on a private network, so private
 * addresses are allowed; what is refused is anything that could carry credentials in the address, and the link-local range and
 * names that cloud providers use for instance metadata (the usual target of this kind of request).
 */
export function integrationUrlProblem(raw: string): string | null {
	let u: URL;
	try {
		u = new URL(raw);
	} catch {
		return 'That is not a valid URL.';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Only http and https addresses are allowed.';
	if (u.username || u.password) return 'Do not put a user name or password in the address; the API key is sent separately.';
	const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
	if (h === 'metadata' || h === 'metadata.google.internal' || h.endsWith('.internal') && h.startsWith('metadata')) return 'That address is a cloud metadata service, not an OpenSEO server.';
	if (/^169\.254\./.test(h) || /^fe[89ab][0-9a-f]:/.test(h) || h === 'fd00:ec2::254') return 'Link-local addresses (including cloud metadata) are not allowed.';
	return null;
}

// ── OpenSEO ──────────────────────────────────────────────────────────────────
export async function connectOpenSeo(baseUrl: string, apiKey: string) {
	const base = baseUrl.trim().replace(/\/+$/, '');
	if (!/^https?:\/\/\S+$/.test(base)) throw new Error('Enter your OpenSEO URL, e.g. https://openseo.example.com');
	const bad = integrationUrlProblem(base);
	if (bad) throw new Error(bad);
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
