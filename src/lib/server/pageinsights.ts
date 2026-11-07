import { db } from './db';
import { clarityPages, mergePages, type AiPage, type ClarityPage, type Ga4Page, type InsightRow, type Vol } from '../pageinsights';
import { periodFor, historyCoversPrevious, topPages } from './queries';
import { linksFor } from './links';
import type { SiteRow } from './clients';
import type { ClarityMetric } from './clarity';

type S = Pick<SiteRow, 'id' | 'site_url' | 'synced_through' | 'backfill_done' | 'backfilled_to'>;

/** Where a path would be on the site, for a link when no source knows the full address (GA4 reports paths only). */
export function originOf(siteUrl: string): string {
	if (siteUrl.startsWith('sc-domain:')) return 'https://' + siteUrl.slice('sc-domain:'.length);
	try {
		return new URL(siteUrl).origin;
	} catch {
		return siteUrl.replace(/\/$/, '');
	}
}

export interface PageInsights {
	rows: InsightRow[];
	period: { start: string; end: string; prevStart: string; prevEnd: string };
	/** whether each source has anything to show, and whether its previous period is stored (so changes are real) */
	google: { comparable: boolean };
	bing: { linked: boolean; hasData: boolean; comparable: boolean };
	ga4: { linked: boolean; hasData: boolean; comparable: boolean };
	/** AI assistants as GA4 sees them. `status`: ok = the report was pulled (it may be empty), pending = GA4 has not synced yet, failed = the last pull of this report failed */
	ai: { linked: boolean; status: 'ok' | 'pending' | 'failed' | null; hasData: boolean; comparable: boolean };
	clarity: { linked: boolean; hasData: boolean; day: string | null };
}

/** Google, Bing, GA4 and Clarity for every page, joined on the URL path, with each source's change against the previous period. */
export function pageInsights(site: S, days: number, limit = 5000): PageInsights {
	const d = db();
	const p = periodFor(site, days);
	const links = linksFor(site.id);
	const toVol = (rows: { page: string; clicks: number; impressions: number; position: number }[]): Vol[] => rows.map((r) => ({ url: r.page, clicks: r.clicks, impressions: r.impressions, position: r.position }));

	const googleComparable = historyCoversPrevious(site, p.prevStart);
	const google = toVol(topPages(site.id, p.start, p.end, {}, 50_000));
	const googlePrev = googleComparable ? toVol(topPages(site.id, p.prevStart, p.prevEnd, {}, 50_000)) : null;

	// Bing: page rows by date; impression position weighted by impressions. A previous period only counts if Bing's stored range reaches it.
	const bingLinked = !!links.bing;
	const bingRange = bingLinked ? (d.prepare('SELECT MIN(date) a FROM bing_daily WHERE site_id = ?').get(site.id) as { a: string | null }) : { a: null };
	const bingWin = (s: string, e: string): Vol[] =>
		(d.prepare("SELECT term url, SUM(clicks) clicks, SUM(impressions) impressions, COALESCE(SUM(COALESCE(impr_pos, 0) * impressions) * 1.0 / NULLIF(SUM(impressions), 0), 0) position FROM bing_terms WHERE site_id = ? AND kind = 'page' AND date BETWEEN ? AND ? GROUP BY term").all(site.id, s, e) as Vol[]);
	const bing = bingLinked ? bingWin(p.start, p.end) : null;
	const bingComparable = !!bingRange.a && bingRange.a <= p.prevStart;
	const bingPrev = bingLinked && bingComparable ? bingWin(p.prevStart, p.prevEnd) : null;

	// GA4: Google-organic landing pages for this window, and (when pulled) the window before it.
	const ga4Linked = !!links.ga4;
	const landing = (table: string) =>
		(d.prepare(`SELECT page, sessions, engaged_sessions engagedSessions, key_events keyEvents FROM ${table} WHERE site_id = ? AND days = ?`).all(site.id, days) as Ga4Page[]);
	const ga4 = ga4Linked ? landing('ga4_landing') : null;
	const ga4PrevRows = ga4Linked ? landing('ga4_landing_prev') : [];
	const ga4Prev = ga4 && ga4.length && ga4PrevRows.length ? ga4PrevRows : null;

	// AI assistants (GA4 sessions whose source is ChatGPT, Perplexity, Gemini, Claude or Copilot). The AI report is an extra pull: when it
	// failed, ga4_ai_on is empty and nothing here is shown, because an empty table would read as "no AI traffic".
	const aiState = ga4Linked ? (d.prepare('SELECT ga4_periods_on periods, ga4_ai_on aion FROM sites WHERE id = ?').get(site.id) as { periods: string | null; aion: string | null }) : null;
	const aiStatus = !aiState ? null : !aiState.periods ? ('pending' as const) : !aiState.aion ? ('failed' as const) : ('ok' as const);
	const aiRows = (table: string) =>
		(d.prepare(`SELECT page, assistant, sessions, engaged_sessions engagedSessions, key_events keyEvents FROM ${table} WHERE site_id = ? AND days = ?`).all(site.id, days) as AiPage[]);
	const ai = aiStatus === 'ok' ? aiRows('ga4_ai') : null;
	const aiPrevRows = aiStatus === 'ok' ? aiRows('ga4_ai_prev') : [];
	// An empty previous window cannot be told apart from one that was never stored, so no change is claimed in either case.
	const aiPrev = ai && ai.length && aiPrevRows.length ? aiPrevRows : null;

	// Clarity: the newest "by URL" snapshot, which covers the last 24 hours only, not the selected period.
	const clarityLinked = !!links.clarity;
	const snap = clarityLinked ? (d.prepare("SELECT day, payload FROM clarity_snapshots WHERE site_id = ? AND dimension = 'URL' ORDER BY day DESC LIMIT 1").get(site.id) as { day: string; payload: string } | undefined) : undefined;
	let clarity: ClarityPage[] | null = null;
	if (snap) {
		try {
			clarity = clarityPages(JSON.parse(snap.payload) as ClarityMetric[]);
		} catch {
			clarity = null;
		}
	}

	const rows = mergePages({ google, googlePrev, bing, bingPrev, ga4: ga4 && ga4.length ? ga4 : null, ga4Prev, ai: ai && ai.length ? ai : null, aiPrev, clarity: clarity && clarity.length ? clarity : null }, (path) => originOf(site.site_url) + path).slice(0, limit);
	return {
		rows,
		period: { start: p.start, end: p.end, prevStart: p.prevStart, prevEnd: p.prevEnd },
		google: { comparable: googleComparable },
		bing: { linked: bingLinked, hasData: !!bing && bing.length > 0, comparable: !!bingPrev },
		ga4: { linked: ga4Linked, hasData: !!ga4 && ga4.length > 0, comparable: !!ga4Prev },
		ai: { linked: ga4Linked, status: aiStatus, hasData: !!ai && ai.length > 0, comparable: !!aiPrev },
		clarity: { linked: clarityLinked, hasData: !!clarity && clarity.length > 0, day: snap?.day ?? null }
	};
}
