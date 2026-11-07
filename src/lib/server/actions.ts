import { db } from './db';
import type { SiteRow } from './clients';
import { displayName } from './clients';
import { addDays } from './dates';
import { brandTerms, dailySeries, fittedCurve, pageTotals, periodFor, queryPageRows, summary, topQueries } from './queries';
import { computeCannibalization, computeCtrGaps, computeDecay, computeStriking, detectAnomalies, isBranded, normalizeUrl, pctChange } from '../analytics';
import { keyHash, rankActions, statusOf, SNOOZE_DAYS, DONE_DAYS, type ActionItem, type ActionStatus } from '../actions';
import { comparability, urlClassesReport } from './insights';
import { trackingHealth } from './tracking';
import { recentEvents } from './indexmon';
import { storedChecks } from './onpage';
import { sitemapCoverage } from './sitemapcov';
import { listTests, evaluateTestCached } from './seotests';
import { updatesBetween } from './gupdates';
import { cruxLatest } from './crux';
import { rate, VITALS, fmtVital } from '../vitals';
import { allSites } from './queries';

type Site = SiteRow;
const r0 = (n: number) => Math.round(n);
/** Whole number with thousands separators, for the sentences shown to people (chips already do this; the text must match). */
const n0 = (n: number) => Math.round(n).toLocaleString('en-US');
const pathOf = (u: string) => {
	try {
		const x = new URL(u);
		return (x.pathname || '/') + (x.search || '');
	} catch {
		return u;
	}
};
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(0)}%`;
const VERSION = 'a3';

/** Every finding for one site, unranked state-free. Cheap enough to run on demand; see actionsFor for the cached, ranked form. */
export function buildActions(site: Site, days = 28): ActionItem[] {
	const out: ActionItem[] = [];
	const id = site.id;
	const base = `/sites/${id}`;
	const add = (a: Omit<ActionItem, 'siteId'>) => void out.push({ ...a, siteId: id });
	const p = periodFor(site, days);
	const cmp = comparability(site, p);
	const total = summary(id, p.start, p.end).clicks;
	const prevTotal = cmp.comparable ? summary(id, p.prevStart, p.prevEnd).clicks : 0;
	const nowPages = new Map(pageTotals(id, p.start, p.end).map((r) => [r.page, r]));
	const prevPages = new Map(cmp.comparable ? pageTotals(id, p.prevStart, p.prevEnd).map((r) => [r.page, r]) : []);
	const clicksOf = (u: string) => Math.max(nowPages.get(u)?.clicks ?? 0, prevPages.get(u)?.clicks ?? 0);
	const share = (c: number) => (total > 0 ? c / total : 0);
	const upd = updatesBetween(addDays(p.start, -7), p.end).filter((u) => u.kind === 'core' || u.kind === 'spam');

	// ── 1. measurement ────────────────────────────────────────────────────────
	try {
		const h = trackingHealth(site, days);
		const how: Record<string, string> = {
			'gtm-unpublished': 'Open the container in Tag Manager, review the workspace and publish a version. Until then none of its tags run.',
			'ga4-id-mismatch': 'Make the GA4 tag use the measurement ID of the property you report on, or link the right property on the Connect page.',
			'ga4-no-organic': 'Check the GA4 tag fires on the site (Tag Assistant, GA4 Realtime), that the data stream URL is right and that consent settings are not blocking it.',
			'ga4-gap': 'Check the GA4 tag fires on every template, and consent or ad-blocker losses; compare with Search Console over a longer window.',
			'gtm-no-ga4-tag': 'If GA4 should load through Tag Manager, add the Google tag; if it loads another way, ignore this.',
			'gtm-ua': 'Delete the Universal Analytics tags; they do nothing.',
			'gtm-paused': 'Un-pause the tags that should run, or delete the ones that should not.'
		};
		for (const f of h.findings.filter((x) => x.severity !== 'info')) {
			add({ key: `tracking:${f.id}`, type: 'tracking', title: f.title, why: f.detail, how: how[f.id] ?? 'Open the Tag Manager tab for details.', impact: null, confidence: 'high', effort: f.severity === 'critical' ? 'medium' : 'low', blocking: f.severity === 'critical', href: `${base}/tags`, evidence: [] });
		}
	} catch {
		/* a missing source must not stop the queue */
	}

	// ── 2. pages blocked from indexing ────────────────────────────────────────
	const blocked = new Set<string>();
	for (const r of db().prepare('SELECT url, result FROM url_inspections WHERE site_id = ?').all(id) as { url: string; result: string }[]) {
		const s = (JSON.parse(r.result) as { indexStatusResult?: { robotsTxtState?: string; indexingState?: string } }).indexStatusResult;
		if (s?.robotsTxtState === 'DISALLOWED' || /^BLOCKED/.test(s?.indexingState ?? '')) blocked.add(r.url);
	}
	for (const c of storedChecks(id)) if ((c.issues ?? []).some((i) => i.id === 'noindex')) blocked.add(c.url);
	const blockedWithClicks = [...blocked].filter((u) => clicksOf(u) > 0).sort((a, b) => clicksOf(b) - clicksOf(a));
	if (blockedWithClicks.length) {
		const impact = blockedWithClicks.reduce((a, u) => a + clicksOf(u), 0);
		add({ key: `blocked:${keyHash(blockedWithClicks)}`, type: 'blocked', title: `${blockedWithClicks.length} page${blockedWithClicks.length === 1 ? '' : 's'} that earn clicks are blocked from indexing`, why: `robots.txt, a noindex tag or an HTTP header tells Google not to index them, yet they earned up to ${n0(impact)} clicks in a recent ${days}-day period (the higher of the last two). Those clicks will go.`, how: 'If these pages should rank, remove the robots.txt rule or the noindex tag and request indexing. If the block is intentional, take them out of your sitemap and internal links.', impact, confidence: 'high', effort: 'low', blocking: true, href: `${base}/indexing`, evidence: blockedWithClicks.slice(0, 5).map((u) => `${pathOf(u)} (${n0(clicksOf(u))} clicks)`) });
	}

	// ── 3. pages Google dropped from its index ────────────────────────────────
	const cutoff = Date.now() - 14 * 86_400_000;
	const dropped = [...new Set(recentEvents(id, 300).filter((e) => e.kind === 'deindexed' && e.at >= cutoff).map((e) => e.url))].filter((u) => clicksOf(u) > 0 && !blocked.has(u)).sort((a, b) => clicksOf(b) - clicksOf(a));
	if (dropped.length) {
		const impact = dropped.reduce((a, u) => a + clicksOf(u), 0);
		add({ key: `deindexed:${keyHash(dropped)}`, type: 'deindexed', title: `Google dropped ${dropped.length} page${dropped.length === 1 ? '' : 's'} from its index`, why: `The indexing monitor saw ${dropped.length === 1 ? 'it' : 'them'} go from indexed to not indexed in the last two weeks; ${dropped.length === 1 ? 'it' : 'they'} earned ${n0(impact)} clicks.`, how: 'Inspect each URL and read Google\'s reason (crawled but not indexed, duplicate, soft 404, blocked). Fix the cause (content, canonical, server errors), then request indexing.', impact, confidence: 'high', effort: 'medium', blocking: share(impact) >= 0.02, href: `${base}/indexing`, evidence: dropped.slice(0, 5).map((u) => `${pathOf(u)} (${n0(clicksOf(u))} clicks)`) });
	}

	// ── 4. the site as a whole ────────────────────────────────────────────────
	if (cmp.comparable && prevTotal >= 100) {
		const change = pctChange(total, prevTotal) ?? 0;
		if (change <= -0.15) {
			const why = upd.length ? `Clicks fell ${pct(change)} (${n0(prevTotal)} → ${n0(total)}), and Google's ${upd.map((u) => u.name).join(' and ')} overlapped this period.` : `Clicks fell ${pct(change)} (${n0(prevTotal)} → ${n0(total)}) against the previous ${days} days.`;
			const how = upd.length
				? `This lines up with a Google update. Do not make sweeping changes while it rolls out; let it finish and give it about two weeks, then compare. Meanwhile make sure tracking, indexing and the blocking items above are clean. Look at which sections lost most on the Groups tab.`
				: 'Rule out the mechanical causes first: tracking (above), indexing events, a recent site change (the change log), seasonality (same weeks last year on the Trends tab). Then see which sections lost most on the Groups tab.';
			add({ key: 'sitewide', type: 'sitewide', title: `Site-wide traffic is down ${Math.abs(Math.round(change * 100))}%`, why, how, impact: prevTotal - total, confidence: 'medium', effort: 'high', blocking: change <= -0.25, href: `${base}/groups`, evidence: upd.map((u) => `${u.name} (${u.begin}${u.end ? ' to ' + u.end : ', rolling out'})`) });
		}
	}
	try {
		const series = dailySeries(id, addDays(p.end, -(days + 90)), p.end).map((d) => ({ date: d.date, value: d.clicks }));
		for (const a of detectAnomalies(series).filter((x) => x.direction === 'drop' && x.date > addDays(p.end, -8))) {
			add({ key: `anomaly:${a.date}`, type: 'anomaly', title: `Clicks dropped ${Math.abs(Math.round(a.deltaPct * 100))}% on ${a.date}`, why: `${n0(a.value)} clicks against about ${n0(a.expected)} expected for that weekday.`, how: 'Check tracking and indexing events first, then whether a Google update started that day (Updates page). A one-day dip that recovers is usually noise or an outage.', impact: null /* one day's loss is not a 28-day figure */, confidence: 'medium', effort: 'low', blocking: a.deltaPct <= -0.4 && a.date >= addDays(p.end, -3), href: base, evidence: [] });
		}
	} catch {
		/* not enough history */
	}

	// ── 5. pages that vanished or are not indexed ─────────────────────────────
	const u = urlClassesReport(site, days);
	for (const r of u.rows.filter((x) => x.cls === 'dead' && x.prevClicks > 0).slice(0, 5)) {
		add({ key: `dead:${normalizeUrl(r.page)}`, type: 'dead', title: `${pathOf(r.page)} is gone from search`, why: `It earned ${n0(r.prevClicks)} clicks in the previous ${days} days and now gets no impressions${r.fetchState === 'NOT_FOUND' ? '; Google gets a 404 for it' : ''}.`, how: 'Restore it, or 301-redirect it to the closest equivalent page, and remove it from the sitemap and internal links.', impact: r.prevClicks, confidence: r.fetchState === 'NOT_FOUND' ? 'high' : 'medium', effort: 'low', blocking: false, href: `${base}/indexing`, evidence: [] });
	}
	const notIdx = u.rows.filter((x) => x.cls === 'not-indexed' && !blocked.has(x.page) && !dropped.includes(x.page) && x.clicks + x.prevClicks > 0).sort((a, b) => b.prevClicks + b.clicks - (a.prevClicks + a.clicks));
	if (notIdx.length) {
		const impact = notIdx.reduce((a, x) => a + Math.max(x.clicks, x.prevClicks), 0);
		add({ key: `not-indexed:${keyHash(notIdx.map((x) => x.page))}`, type: 'not-indexed', title: `${notIdx.length} page${notIdx.length === 1 ? '' : 's'} with traffic ${notIdx.length === 1 ? 'is' : 'are'} not in Google's index`, why: 'Google reports them as not indexed, yet Search Console still shows them earning clicks, so they are at risk.', how: 'Read Google\'s stated reason on the Indexing tab and fix it (thin or duplicate content, canonical pointing elsewhere, server error); then request indexing.', impact, confidence: 'medium', effort: 'medium', blocking: share(impact) >= 0.02, href: `${base}/indexing`, evidence: notIdx.slice(0, 5).map((x) => `${pathOf(x.page)} (${n0(Math.max(x.clicks, x.prevClicks))} clicks)`) });
	}

	// ── 6. ranking opportunities, from the site's own CTR curve ──────────────
	const terms = brandTerms(site);
	const qp = queryPageRows(id, p.start, p.end);
	const curve = fittedCurve(qp, terms);
	const scale = days / 28;
	const nonBrandQp = qp.filter((r) => !isBranded(r.query, terms));
	const checks = new Map(storedChecks(id).map((c) => [c.url, c]));
	for (const g of computeCannibalization(qp, curve, { limit: 8, minQueryImpressions: Math.max(20, r0(scale * 40)) })) {
		add({ key: `cannibal:${g.query}`, type: 'cannibalization', title: `${g.pages.length} pages compete for “${g.query}”`, why: `They split ${n0(g.totalImpressions)} impressions between them (positions ${g.pages.map((x) => x.position.toFixed(1)).join(', ')}), and one page at the best position would earn about ${n0(g.potentialClicks)} more clicks.`, how: `Keep ${pathOf(g.winner)} as the winner. Merge or sharply differentiate the others, point internal links and the anchor text at the winner, and 301 or canonical the weakest.`, impact: g.potentialClicks, confidence: 'medium', effort: 'medium', blocking: false, href: `${base}/cannibalization`, evidence: g.pages.slice(0, 4).map((x) => `${pathOf(x.page)} (pos ${x.position.toFixed(1)}, ${n0(x.clicks)} clicks)`) });
	}
	for (const r of computeCtrGaps(nonBrandQp, curve, { minImpressions: Math.max(50, r0(scale * 90)), limit: 8 })) {
		const c = checks.get(r.page);
		const cov = c?.queries?.find((q) => q.query === r.query);
		const note = cov && cov.title === 'none' ? ' The page title does not contain the query.' : cov && cov.title === 'some-words' ? ' The page title only partly matches the query.' : '';
		add({ key: `ctr:${r.query}|${normalizeUrl(r.page)}`, type: 'ctr-gap', title: `“${r.query}” ranks ${r.position.toFixed(1)} but gets half the clicks it should`, why: `${(r.ctr * 100).toFixed(1)}% CTR against about ${(r.expectedCtr * 100).toFixed(1)}% that this position normally earns on your site; about ${n0(r.missedClicks)} clicks missed.${note}`, how: 'Rewrite the title and meta description to match what the searcher wants, lead with the query, and look at the live result for what competitors show (rich results, dates, prices).', impact: r.missedClicks, confidence: 'medium', effort: 'low', blocking: false, href: `${base}/onpage`, evidence: [pathOf(r.page)] });
	}
	for (const r of computeStriking(topQueries(id, p.start, p.end, {}, 50_000).filter((x) => !isBranded(x.query, terms)), curve, { minImpressions: Math.max(10, r0(scale * 30)), limit: 5 })) {
		add({ key: `striking:${r.query}`, type: 'striking', title: `“${r.query}” is at position ${r.position.toFixed(1)}: within reach of the top 3`, why: `${n0(r.impressions)} impressions at position ${r.position.toFixed(1)}. On your own CTR curve, reaching position 3 would be worth about ${n0(r.expectedGain)} more clicks. That is an estimate of the prize, not a forecast of getting it.`, how: 'Strengthen the page that ranks: put the query in the title and H1, add the depth the top results have, link to it from related pages with descriptive anchors, and refresh it.', impact: r.expectedGain, confidence: r.position <= 8 ? 'medium' : 'low', effort: 'medium', blocking: false, href: `${base}/opportunities`, evidence: [] });
	}
	if (cmp.comparable) {
		const siteDelta = pctChange(total, prevTotal) ?? 0;
		for (const r of computeDecay([...nowPages.values()], [...prevPages.values()], siteDelta, null, { limit: 8, minPrevClicks: Math.max(10, r0(scale * 20)) }).filter((x) => x.scope === 'page-specific')) {
			add({ key: `decay:${normalizeUrl(r.page)}`, type: 'decay', title: `${pathOf(r.page)} lost ${n0(r.lostClicks)} clicks (${pct(r.deltaPct)})`, why: `Down from ${n0(r.prevClicks)} to ${n0(r.clicks)} while the site as a whole moved ${pct(siteDelta)}; average position ${r.positionPrev.toFixed(1)} → ${r.positionNow ? r.positionNow.toFixed(1) : 'not shown'}. The drop is specific to this page.`, how: 'Check it is still indexed and returns 200; look at the queries it lost on the Pages tab; refresh the content and links; check for a newer page now outranking it (cannibalization).', impact: r.lostClicks, confidence: 'medium', effort: 'medium', blocking: false, href: `${base}/decay`, evidence: [] });
		}
	}

	// ── 7. hygiene found by the on-page check, sitemaps and field data ───────
	const issueHow: Record<string, [string, string, 'low' | 'medium']> = {
		'no-title': ['have no <title>', 'Add a unique, descriptive title that leads with the main query.', 'medium'],
		'no-description': ['have no meta description', 'Write a description that sells the click; Google will write its own otherwise.', 'low'],
		'no-h1': ['have no <h1>', 'Add one H1 stating the page topic in the words searchers use.', 'low'],
		'top-query-missing': ['do not mention their top query in the title or H1', 'Work the query people already find the page with into the title and H1 naturally.', 'medium'],
		'canonical-elsewhere': ['declare a different page as canonical', 'Check that is intended; if not, point the canonical at the page itself.', 'medium']
	};
	for (const [issue, [phrase, how, conf]] of Object.entries(issueHow)) {
		const pages = [...checks.values()].filter((c) => (c.issues ?? []).some((i) => i.id === issue)).sort((a, b) => clicksOf(b.url) - clicksOf(a.url));
		if (!pages.length) continue;
		add({ key: `onpage:${issue}`, type: 'onpage', title: `${pages.length} checked page${pages.length === 1 ? '' : 's'} ${phrase}`, why: `Found by the on-page check; biggest first by clicks.${pages.length >= 3 ? '' : ' Run the check on more pages to see the full picture.'}`, how, impact: null, confidence: conf, effort: 'low', blocking: false, href: `${base}/onpage`, evidence: pages.slice(0, 5).map((c) => `${pathOf(c.url)} (${n0(clicksOf(c.url))} clicks)`) });
	}
	try {
		const cov = sitemapCoverage(site);
		if (cov.synced && cov.window.complete && cov.neverShown.count >= 3) {
			add({ key: 'sitemap:never-shown', type: 'sitemap', title: `${cov.neverShown.count} sitemap URLs have never been shown in Search`, why: `No impression in ${cov.window.days} days in the stored query data (${cov.shown} of ${cov.totalUrls} sitemap URLs were shown). That data leaves out anonymised queries and very rare ones, so a page that is only ever shown for those can appear here wrongly. Either Google has not indexed them or it indexed them and found nothing worth showing.`, how: 'The indexing monitor checks these first. Fix the not-indexed ones (noindex, canonical, thin or duplicate content), link to the rest from strong pages, and remove from the sitemap anything that should not rank.', impact: null, confidence: 'low', effort: 'medium', blocking: false, href: `${base}/indexing`, evidence: cov.neverShown.sample.slice(0, 5).map((s) => `${pathOf(s.url)} (${s.index})`) });
		}
		if (cov.synced && cov.notInSitemap.count >= 3) {
			add({ key: 'sitemap:missing', type: 'sitemap', title: `${cov.notInSitemap.count} pages that earn clicks are missing from your sitemaps`, why: `They earned ${n0(cov.notInSitemap.clicks)} clicks but no submitted sitemap lists them (some may be parameter variants).`, how: 'Add the real pages to the sitemap so Google keeps rediscovering them; ignore parameter or duplicate variants.', impact: null, confidence: 'low', effort: 'low', blocking: false, href: `${base}/indexing`, evidence: cov.notInSitemap.sample.slice(0, 5).map((s) => `${pathOf(s.url)} (${n0(s.clicks)} clicks)`) });
		}
	} catch {
		/* no sitemap data */
	}
	try {
		const phone = cruxLatest(id).latest.get('PHONE');
		if (phone) {
			const adv: Record<string, string> = { lcp: 'Optimise the largest above-the-fold image or text: compress and preload it, remove render-blocking scripts, cut server response time.', inp: 'Break up long JavaScript tasks, defer non-essential scripts and third-party tags.', cls: 'Reserve space for images, embeds and ads, and avoid inserting content above existing content.' };
			for (const v of VITALS.filter((x) => x.core)) {
				const val = phone[v.key];
				if (rate(v.key, val) === 'poor') add({ key: `vitals:${v.key}`, type: 'vitals', title: `${v.name} is poor on phones (${fmtVital(v.key, val)})`, why: `${v.long}: real-user 75th percentile from the Chrome UX Report. A poor Core Web Vital is a (small) ranking factor and a real cost to visitors.`, how: adv[v.key], impact: null, confidence: 'low', effort: 'high', blocking: false, href: `${base}/vitals`, evidence: [] });
			}
		}
	} catch {
		/* no field data */
	}

	// ── 8. tests that have reached a conclusion ───────────────────────────────
	for (const t of listTests(id)) {
		try {
			const o = evaluateTestCached(site, t);
			const v = o.clicks.verdict;
			const kv = o.conversions.status === 'ok' ? o.conversions.keyEvents?.verdict : undefined;
			if (v === 'positive' && kv === 'negative' && o.postDays >= 21) {
				add({ key: `test:${t.id}:conflict`, type: 'test', title: `“${t.name}”: more clicks, fewer conversions`, why: `Clicks are up ${pct(o.clicks.lift ?? 0)} against the control, but GA4 key events from Google organic are down ${pct(o.conversions.keyEvents?.lift ?? 0)}. The change is probably attracting a different, less valuable audience.`, how: 'Do not roll it out on clicks alone. Look at what the new queries and landing pages promise versus what the page delivers, and tighten the title and content to the intent that converts.', impact: null, confidence: 'medium', effort: 'medium', blocking: false, href: `${base}/tests`, evidence: [] });
			} else if ((v === 'positive' || v === 'negative') && o.postDays >= 21) {
				add({ key: `test:${t.id}:${v}`, type: 'test', title: v === 'positive' ? `Roll out “${t.name}”: it likely worked (${pct(o.clicks.lift ?? 0)} vs control)` : `Revert or rework “${t.name}”: it likely hurt (${pct(o.clicks.lift ?? 0)} vs control)`, why: `After ${o.postDays} days, ${o.treatmentPages} changed pages against ${o.controlPages} control pages${o.clicks.ciLow != null ? ` (95% range ${pct(o.clicks.ciLow)} to ${pct(o.clicks.ciHigh ?? 0)})` : ''}. Observational, not randomised.`, how: v === 'positive' ? 'Apply the same change to similar pages and log it, then test the rollout.' : 'Undo the change on the affected pages, or understand what went wrong before repeating it.', impact: null, confidence: o.updates.some((x) => x.window !== 'before' && (x.kind === 'core' || x.kind === 'spam')) ? 'low' : 'high', effort: 'medium', blocking: false, href: `${base}/tests`, evidence: [] });
			} else if (v === 'inconclusive' && o.postDays >= 28 && o.postDays < 84 && (o.clicks.calibration.detectable ?? 0) > 0.25) {
				add({ key: `test:${t.id}:extend`, type: 'test', title: `“${t.name}” cannot tell yet: let it run or widen it`, why: `No clear effect, but this test could only have seen a change bigger than about ${Math.round((o.clicks.calibration.detectable ?? 0) * 100)}%, so the answer is weak evidence either way.`, how: 'Let it run longer, include more pages, or test a bigger change.', impact: null, confidence: 'medium', effort: 'low', blocking: false, href: `${base}/tests`, evidence: [] });
			}
		} catch {
			/* a broken test is shown on the Tests tab */
		}
	}
	return out;
}

// ── caching, ranking and "done / snooze" state ───────────────────────────────
function cacheKey(site: Site, days: number): string {
	const d = db();
	const one = (sql: string, ...a: unknown[]) => JSON.stringify(d.prepare(sql).get(...a));
	return JSON.stringify([
		VERSION, days, site.synced_through, site.last_sync_at, site.index_checked_on,
		one('SELECT MAX(fetched_at) m, COUNT(*) n FROM url_inspections WHERE site_id = ?', site.id),
		one('SELECT MAX(at) m, COUNT(*) n FROM index_events WHERE site_id = ?', site.id),
		one('SELECT MAX(checked_at) m, COUNT(*) n FROM onpage_checks WHERE site_id = ?', site.id),
		one('SELECT fetched_at f FROM sitemap_sync WHERE site_id = ?', site.id),
		one('SELECT MAX(updated_at) m, COUNT(*) n FROM google_updates'),
		one('SELECT COUNT(*) n, MAX(id) m FROM seo_tests WHERE site_id = ?', site.id),
		one('SELECT MAX(computed_at) m FROM seo_test_results r JOIN seo_tests t ON t.id = r.test_id WHERE t.site_id = ?', site.id),
		one('SELECT SUM(COALESCE(last_sync_at, 0)) s FROM site_links WHERE site_id = ?', site.id),
		site.crux_pulled_on,
		// settings that change what is found, and the day (the 14-day de-index window slides)
		site.brand_terms, site.permission, Math.floor(Date.now() / 86_400_000)
	]);
}

/** All findings for a site, ranked, recomputed only when something they read has changed. */
export function actionsFor(site: Site, days = 28): ActionItem[] {
	const d = db();
	const key = cacheKey(site, days);
	const hit = d.prepare('SELECT cache_key, payload FROM action_cache WHERE site_id = ? AND days = ?').get(site.id, days) as { cache_key: string; payload: string } | undefined;
	if (hit && hit.cache_key === key) return JSON.parse(hit.payload) as ActionItem[];
	const items = rankActions(buildActions(site, days));
	d.prepare('INSERT OR REPLACE INTO action_cache (site_id, days, cache_key, payload, computed_at) VALUES (?,?,?,?,?)').run(site.id, days, key, JSON.stringify(items), Date.now());
	return items;
}

export interface StoredState { state: string; until: number }
export const actionStates = (siteId: number) => new Map((db().prepare('SELECT key, state, until FROM action_state WHERE site_id = ?').all(siteId) as { key: string; state: string; until: number }[]).map((r) => [r.key, { state: r.state, until: r.until }]));

export function setActionState(siteId: number, key: string, state: 'done' | 'snoozed' | 'open') {
	if (state === 'open') return void db().prepare('DELETE FROM action_state WHERE site_id = ? AND key = ?').run(siteId, key);
	const until = Date.now() + (state === 'done' ? DONE_DAYS : SNOOZE_DAYS) * 86_400_000;
	db().prepare('INSERT OR REPLACE INTO action_state (site_id, key, state, until, updated_at) VALUES (?,?,?,?,?)').run(siteId, key, state, until, Date.now());
}

export interface QueueView { open: ActionItem[]; hidden: (ActionItem & { status: ActionStatus; until: number })[] }

/** The queue as a person sees it: open items in rank order, and separately what is done or snoozed (restorable). */
export function queueFor(site: Site, days = 28): QueueView {
	const states = actionStates(site.id);
	const open: ActionItem[] = [];
	const hidden: QueueView['hidden'] = [];
	for (const a of actionsFor(site, days)) {
		const st = states.get(a.key);
		const status = statusOf(st);
		if (status === 'open') open.push(a);
		else hidden.push({ ...a, status, until: st!.until });
	}
	return { open, hidden };
}

/** Across every visible site: blocking first, then by score; each item carries its site's name. */
/** `sites` limits the queue to those sites (an API key's scope): the limit is applied after the filter, never before it. */
export function portfolioQueue(limit = 40, days = 28, sites: Site[] = allSites()) {
	const items: (ActionItem & { site: string })[] = [];
	for (const s of sites.filter((x) => !['siteUnverifiedUser', 'none'].includes(x.permission))) {
		try {
			for (const a of queueFor(s, days).open) items.push({ ...a, site: displayName(s.site_url) });
		} catch {
			/* one broken site must not hide the others */
		}
	}
	return rankActions(items).slice(0, limit);
}
