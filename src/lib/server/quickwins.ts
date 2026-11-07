import type { SiteRow } from './clients';
import { brandTerms, fittedCurve, periodFor, queryPageRows, topQueries } from './queries';
import { computeCtrGaps, computeStriking, isBranded } from '../analytics';
import { isQuestionQuery } from '../trends';
import { sitemapCoverage } from './sitemapcov';
import { requestQueue } from './requestindex';
import { queueFor } from './actions';

/**
 * Quick wins, "low-hanging fruit": the changes that take the least effort for a likely gain, picked from the Search Console data the app
 * already holds. Nothing here is new analysis; it is the cheapest part of each finding, grouped by what you would actually do, with the
 * work each one is. Estimates are model figures from this site's own click-through curve, not promises, and they are not added up
 * because the groups overlap (one query can be a CTR gap and near page 1).
 */
export interface QuickWinRow { label: string; detail: string; /** estimated extra clicks per period; null when there is no honest number */ gain: number | null; href?: string }
export interface QuickWinGroup {
	key: 'ctr' | 'page-one' | 'questions' | 'sitemap' | 'onpage' | 'indexing';
	title: string;
	why: string;
	how: string;
	/** the tab where the whole list lives */
	tab: string;
	/** how many items there are in all (rows is the top few) */
	total: number;
	rows: QuickWinRow[];
}
export interface QuickWins { days: number; groups: QuickWinGroup[] }

const TOP = 8;
const pathOf = (u: string) => {
	try {
		const x = new URL(u);
		return (x.pathname || '/') + (x.search || '');
	} catch {
		return u;
	}
};
const r1 = (n: number) => Math.round(n * 10) / 10;

export function quickWins(site: SiteRow, days = 28): QuickWins {
	const groups: QuickWinGroup[] = [];
	const p = periodFor(site, days);
	const terms = brandTerms(site);
	const qp = queryPageRows(site.id, p.start, p.end).filter((r) => !isBranded(r.query, terms));
	const curve = fittedCurve(queryPageRows(site.id, p.start, p.end), terms);
	// The same thresholds as the Opportunities tab, so a row here is a row there.
	const minImpr = Math.max(10, Math.round((days / 28) * 30));
	const queries = topQueries(site.id, p.start, p.end, {}, 50_000).filter((r) => !isBranded(r.query, terms));

	const gaps = computeCtrGaps(qp, curve, { minImpressions: Math.max(50, minImpr * 3) });
	if (gaps.length) {
		groups.push({
			key: 'ctr', title: 'Rewrite the title and description', total: gaps.length, tab: 'opportunities',
			why: "These pages already rank in the top 10 but get far fewer clicks than your own site normally earns at that position, so the snippet is the weak part, not the ranking.",
			how: 'Rewrite the title and meta description to match what the searcher typed: lead with the query, say what they get, and add a reason to click. It is a ten-minute edit per page.',
			rows: gaps.slice(0, TOP).map((g) => ({ label: g.query, detail: `${pathOf(g.page)} · position ${r1(g.position)} · ${(g.ctr * 100).toFixed(1)}% click rate against about ${(g.expectedCtr * 100).toFixed(1)}% expected`, gain: Math.round(g.missedClicks), href: g.page }))
		});
	}

	const nearTop = computeStriking(queries, curve, { minImpressions: minImpr, minPos: 8, maxPos: 15 });
	if (nearTop.length) {
		groups.push({
			key: 'page-one', title: 'One push from the top of page 1', total: nearTop.length, tab: 'opportunities',
			why: 'These searches already show you at positions 8 to 15, the edge of page 1. A small improvement moves them to where most clicks are.',
			how: 'Open the page that ranks, put the query in the title and the first heading, add the sections the top results have that you lack, and link to it from two or three related pages with descriptive anchor text.',
			rows: nearTop.slice(0, TOP).map((s) => ({ label: s.query, detail: `position ${r1(s.position)} · ${s.impressions.toLocaleString('en-US')} impressions${s.topPage ? ` · ${pathOf(s.topPage)}` : ''}`, gain: Math.round(s.expectedGain), href: s.topPage }))
		});
	}

	const asked = computeStriking(queries.filter((r) => isQuestionQuery(r.query)), curve, { minImpressions: Math.max(10, Math.round(minImpr / 2)), minPos: 3, maxPos: 20 });
	if (asked.length) {
		groups.push({
			key: 'questions', title: 'Answer the questions people already find you for', total: asked.length, tab: 'queries',
			why: 'These are searches phrased as questions, where you already show up on page 1 or 2. A direct answer near the top of the page is the usual way to win them, and they are the kind of query AI assistants also draw on.',
			how: 'Add the question as a heading with a two or three sentence answer straight under it, then the detail. Add FAQ markup only if the page really has the questions and answers on it.',
			rows: asked.slice(0, TOP).map((s) => ({ label: s.query, detail: `position ${r1(s.position)} · ${s.impressions.toLocaleString('en-US')} impressions${s.topPage ? ` · ${pathOf(s.topPage)}` : ''}`, gain: Math.round(s.expectedGain), href: s.topPage }))
		});
	}

	try {
		const cov = sitemapCoverage(site);
		if (cov.synced && cov.notInSitemap.count > 0) {
			groups.push({
				key: 'sitemap', title: 'Add the pages that earn clicks to your sitemap', total: cov.notInSitemap.count, tab: 'sitemaps',
				why: 'These pages already get clicks but no submitted sitemap lists them. Some are parameter variants; the real pages should be listed so Google keeps rediscovering them.',
				how: 'Add the real pages to the sitemap (most CMSs do it from a setting), with an honest <lastmod>, then read the sitemaps again.',
				rows: cov.notInSitemap.sample.slice(0, TOP).map((x) => ({ label: pathOf(x.url), detail: `${x.clicks.toLocaleString('en-US')} clicks · ${x.impressions.toLocaleString('en-US')} impressions`, gain: null, href: x.url }))
			});
		}
	} catch {
		/* no sitemap read yet */
	}

	try {
		const onpage = queueFor(site, days).open.filter((a) => a.type === 'onpage');
		if (onpage.length) {
			groups.push({
				key: 'onpage', title: 'Fix the titles and descriptions the checker flagged', total: onpage.length, tab: 'onpage',
				why: 'A missing or generic title or description is the cheapest fix there is, and the snippet is what people see before they click.',
				how: 'Open the On-page tab, work down the flagged pages and write a specific title and description for each.',
				rows: onpage.slice(0, TOP).map((a) => ({ label: a.title, detail: a.why, gain: null, href: a.href }))
			});
		}
	} catch {
		/* no on-page check yet */
	}

	try {
		const q = requestQueue(site.id);
		if (q.pending.length) {
			groups.push({
				key: 'indexing', title: 'Ask Google about pages it has not indexed', total: q.pending.length, tab: 'request',
				why: "New or changed pages that Google has not indexed yet can't earn anything. Search Console's Request Indexing button is the one fast, official way to ask, and the Request tab prepares the list.",
				how: 'Open the Request tab, follow the link for each page and press Request indexing in Search Console (a tool cannot press it for you).',
				rows: q.pending.slice(0, TOP).map((i) => ({ label: pathOf(i.url), detail: i.reason, gain: null, href: i.url }))
			});
		}
	} catch {
		/* no request list */
	}
	return { days, groups };
}
