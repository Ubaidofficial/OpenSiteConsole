import { db, audit } from './db';
import { getSite } from './clients';
import { linksFor } from './links';
import { fetchPage, guardedFetch, pagesToCheck } from './onpage';
import { pageProblem } from '../onpage';
import { demoPageFetch } from './demo-channels';
import { gtmSnapshot } from './tracking';
import { isDomainProperty } from '../property';
import { clarityInstall, scanHtml, type ClarityInstall, type ClarityInstallInput, type ScannedPage } from '../clarityinstall';
import type { ClarityMetric } from './clarity';

/** The page to start from: https://example.com/ for a domain property (a redirect to www. is followed), the prefix itself otherwise. */
export function homeUrl(siteUrl: string): string {
	return isDomainProperty(siteUrl) ? `https://${siteUrl.slice('sc-domain:'.length)}/` : siteUrl;
}

/** The home page and the two pages earning the most clicks: enough to see a site-wide script, cheap enough to run daily. */
export function pagesToScan(siteId: number): string[] {
	const site = getSite(siteId)!;
	let top: string[] = [];
	try {
		top = pagesToCheck(siteId, 3);
	} catch {
		/* no Search Console data yet: the home page alone */
	}
	return [...new Set([homeUrl(site.site_url), ...top])].slice(0, 3);
}

/** Fetch the pages and record which Clarity projects and Tag Manager containers each one loads. Never throws for a page. */
export async function runClarityScan(siteId: number, o: { fetchImpl?: typeof fetch } = {}): Promise<ScannedPage[]> {
	const site = getSite(siteId)!;
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(site.account_id) as { is_demo: number } | undefined)?.is_demo;
	const fetchImpl = o.fetchImpl ?? (isDemo ? demoPageFetch(site.site_url) : guardedFetch);
	const pages: ScannedPage[] = [];
	for (const url of pagesToScan(siteId)) {
		const f = await fetchPage(url, site.site_url, fetchImpl);
		// a failed fetch (timeout, blocked) says nothing about the page; a real answer (404, 5xx, noindex, "temporarily unavailable") does
		const problem = f.status ? pageProblem(f.status, f.html) : null;
		pages.push(f.html ? { url, ok: true, ...scanHtml(f.html), ...(problem ? { problem } : {}) } : { url, ok: false, error: f.error ?? 'Could not fetch the page.', clarityIds: [], clarityLoader: false, gtmIds: [], ...(problem ? { problem } : {}) });
	}
	db().prepare('INSERT OR REPLACE INTO clarity_scans (site_id, checked_at, payload) VALUES (?,?,?)').run(siteId, Date.now(), JSON.stringify(pages));
	return pages;
}

export function storedClarityScan(siteId: number): { checkedAt: number; pages: ScannedPage[] } | null {
	const r = db().prepare('SELECT checked_at, payload FROM clarity_scans WHERE site_id = ?').get(siteId) as { checked_at: number; payload: string } | undefined;
	return r ? { checkedAt: r.checked_at, pages: JSON.parse(r.payload) as ScannedPage[] } : null;
}

/** Sessions in the newest stored Clarity snapshot, or null when there is none. */
function latestSessions(siteId: number): number | null {
	const r = db().prepare("SELECT payload FROM clarity_snapshots WHERE site_id = ? AND dimension = '' ORDER BY day DESC LIMIT 1").get(siteId) as { payload: string } | undefined;
	if (!r) return null;
	const traffic = (JSON.parse(r.payload) as ClarityMetric[]).find((m) => m.metricName === 'Traffic')?.information ?? [];
	return traffic.reduce((a, x) => a + Number(x.totalSessionCount ?? 0), 0);
}

export function clarityInstallInput(siteId: number): ClarityInstallInput {
	const links = linksFor(siteId);
	const snap = links.gtm ? gtmSnapshot(siteId) : null;
	return {
		connected: !!links.clarity,
		sessions: links.clarity ? latestSessions(siteId) : null,
		scan: storedClarityScan(siteId),
		gtm: snap ? { publicId: snap.publicId ?? snap.containerPath, published: snap.published, clarityTags: snap.tags.filter((t) => t.clarity).map((t) => ({ name: t.name, paused: t.paused, firing: t.firing, clarityId: t.clarityId ?? null })) } : null
	};
}

export const clarityInstallFor = (siteId: number): ClarityInstall => clarityInstall(clarityInstallInput(siteId));

/** Run a check now (from a button), logged so the owner can see when pages were fetched. */
export async function checkClarityNow(siteId: number) {
	const pages = await runClarityScan(siteId);
	audit('clarity.checked', { siteId, detail: `${pages.filter((p) => p.ok).length}/${pages.length} pages read` });
	return clarityInstallFor(siteId);
}
