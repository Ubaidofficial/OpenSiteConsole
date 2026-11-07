/**
 * Plain-language explainers for the action queue: what each kind of finding is, and what each chip and button means.
 * Written from how the findings are built in src/lib/server/actions.ts, and kept free of site data so they are safe to show
 * in privacy mode. A test checks that every action type has both a label and an explainer.
 */
import { DONE_DAYS, SNOOZE_DAYS, type ActionType, type Confidence, type Effort } from './actions';

export const TYPE_LABEL: Record<ActionType, string> = {
	tracking: 'Measurement', blocked: 'Blocked', deindexed: 'De-indexed', sitewide: 'Site-wide', anomaly: 'Traffic drop', dead: 'Gone',
	'not-indexed': 'Not indexed', update: 'Google update', cannibalization: 'Cannibalization', 'ctr-gap': 'CTR gap', decay: 'Decay',
	striking: 'Striking distance', onpage: 'On-page', sitemap: 'Sitemap', lastmod: 'Sitemap dates', submitted: 'Sent, not indexed', request: 'Request indexing', vitals: 'Web vitals', test: 'Test'
};

export const TYPE_EXPLAIN: Record<ActionType, string> = {
	tracking: 'Your measurement looks broken or incomplete (for example a missing or misconfigured Google Analytics tag), so some numbers cannot be trusted until it is fixed.',
	blocked: 'Pages that earn clicks are blocked from Google by robots.txt, a noindex tag or a header. If that is not intended, they will lose their traffic.',
	deindexed: 'Pages that were in Google\'s index a short while ago are no longer there. The indexing monitor saw them drop out.',
	sitewide: 'Total clicks for the whole site are down against the previous period, not just one page. Check for a Google update or a site-wide change.',
	anomaly: 'Clicks on one day were far below what is normal for that weekday on this site. A single dip that recovers is often noise or an outage.',
	dead: 'A page that used to earn clicks now gets no impressions. It may be deleted or erroring. Restore it or redirect it to the closest equivalent.',
	'not-indexed': 'Google reports these pages as not indexed, yet Search Console still shows them earning clicks, so that traffic is at risk.',
	update: 'A Google ranking update overlaps a change in this site\'s traffic. It is a possible explanation, not proof.',
	cannibalization: 'Several of your own pages compete for the same search, so Google splits impressions between them. Keeping one clear winner usually helps.',
	'ctr-gap': 'The page ranks well, but fewer people click it than your own site normally gets at that position. The title and description are the usual fix.',
	decay: 'A page is losing clicks compared with the previous period while the rest of the site is not falling the same way, so the problem is specific to it.',
	striking: 'A search where you rank just below the top results (roughly positions 4 to 20). A modest improvement there would add clicks.',
	onpage: 'The on-page check found a problem, such as a missing title or description, on pages it checked. These are quick fixes.',
	sitemap: 'A mismatch between your sitemaps and what Google shows: pages that are listed but never shown, or pages that earn clicks but are not listed.',
	lastmod: 'The dates in your sitemap look wrong or untrustworthy (invalid, in the future, or all the same). Google uses them to decide what to re-crawl and ignores sites whose dates cannot be trusted.',
	submitted: 'URLs you sent to the search engines were checked again with Google after 5 days and are still not indexed. Google\'s own explanation for each is on the Submit tab.',
	request: 'Pages worth asking Google about with Search Console\'s Request Indexing button (which no tool can press for you), or pages where asking would not help until something is fixed.',
	vitals: 'Real visitors on phones get a poor Core Web Vitals result (loading speed, responsiveness or layout shift). It is a small ranking factor and a real cost to visitors.',
	test: 'The result of an SEO test you started: it may have worked, failed, conflicted with conversions, or be too early to tell.'
};

export const BLOCKING_EXPLAIN = 'This stops the site earning traffic or stops you measuring it, so it is listed before everything else, however large the other items look.';

export const IMPACT_EXPLAIN = 'Estimated clicks per 28 days at stake or to gain, worked out from this site\'s own data. It is a model figure, not a promise, and the figures are not additive because findings overlap.';
export const NO_IMPACT_EXPLAIN = 'There is no honest click estimate for this kind of item, so it is listed after the ones that have one.';

export const CONFIDENCE_EXPLAIN: Record<Confidence, string> = {
	high: 'High confidence: this is based on something measured directly, so the estimate is more reliable.',
	medium: 'Medium confidence: a reasonable estimate from your own data, but it depends on assumptions about how clicks respond.',
	low: 'Low confidence: a rough estimate. Treat it as a pointer to look, not as a number to plan around.'
};

export const EFFORT_EXPLAIN: Record<Effort, string> = {
	low: 'Low effort: usually a quick change, such as editing a title or a tag.',
	medium: 'Medium effort: some real work, such as rewriting or restructuring a page.',
	high: 'High effort: a larger piece of work, such as a site-wide change or performance engineering.'
};

export const BUTTON_EXPLAIN = {
	open: 'Go to the page in this app where you can look at this and act on it.',
	done: `Mark it as handled. It is hidden for ${DONE_DAYS} days and comes back if the problem is still there.`,
	snooze: `Hide it for ${SNOOZE_DAYS} days without marking it fixed. It comes back after that if the problem is still there.`,
	restore: 'Put it back in the queue now.'
} as const;

export const PORTFOLIO_INTRO = 'Portfolio puts the findings you see on each site\'s own tabs into one list across all your visible, synced sites, so you can see where the biggest opportunities and problems are without opening every site. Each site is judged against its own data first, then the results are merged. Sites hidden from the dashboard are left out, and a property that another one already covers is counted once.';

export const PORTFOLIO_TAB_EXPLAIN: Record<string, string> = {
	striking: 'Searches where a site ranks just below the top results (roughly positions 4 to 20), biggest estimated gain first. "Est. +clicks" is what reaching position 3 would add, from that site\'s own click-through curve. Searches that contain the site\'s brand terms are left out.',
	cannibalization: 'Searches where two or more pages of the same site compete and split the impressions. Only the most serious cases are listed here; open a site for its full list. "Clicks at stake" is the extra clicks one page would earn if it took the best position.',
	decay: 'Pages that lost clicks compared with the previous period of the same length. "Δ" is the page\'s change and "vs site" compares it with how the whole site moved, so a page falling while its site grows stands out.',
	anomalies: 'Days when a site\'s clicks were unusually far from what is normal for that weekday. "Expected" is that normal level. Check tracking, indexing and Google updates before assuming a real change.'
};

/** The tabs on a site's page: path under /sites/<id>, label, and what the tab is for (shown on hover). One list, so the tab bar, the hover text and the browser titles cannot drift apart. */
export const SITE_TABS = [
	['', 'Overview', 'Traffic chart for the period, unusual days, and your change log.'],
	['/quickwins', 'Quick wins', 'The easiest improvements first: titles to rewrite, searches one push from page 1, questions you already rank for, and quick fixes.'],
	['/actions', 'Actions', 'This site\'s to-do list, in the order to do it.'],
	['/queries', 'Queries', 'Search queries, with filters for brand, country and device.'],
	['/pages', 'Pages', 'Pages with Google, Bing, GA4 and Clarity numbers side by side.'],
	['/trends', 'Trends', 'Queries and pages whose clicks changed by more than normal day-to-day noise, against the previous period.'],
	['/groups', 'Groups', 'Pages grouped by the folder they live in, to see which section of the site is growing or shrinking.'],
	['/opportunities', 'Opportunities', 'Your own click-through rate by position, and the queries ranking just below the top results (striking distance).'],
	['/cannibalization', 'Cannibalization', 'Queries where two or more of your pages each hold a real share of the impressions.'],
	['/decay', 'Decay', 'Pages that lost clicks against the previous period by more than the site as a whole moved.'],
	['/segments', 'Segments', 'Clicks and impressions split by device and by country.'],
	['/types', 'Search types', 'Search Console numbers split by search type, such as web, image and video.'],
	['/vitals', 'Web vitals', 'Real-visitor page speed (Core Web Vitals) from Google\'s Chrome UX Report. Needs a free Google API key.'],
	['/tests', 'Tests', 'Measure whether an SEO change worked, comparing before and after or against control pages.'],
	['/submit', 'Submit', 'Send new or changed pages to the search engines that accept them, send sitemaps to Search Console, and see what happened to each URL.'],
	['/request', 'Request', 'A short daily list of pages worth asking Google about in Search Console, with a link to each, and a record of what you asked and whether it worked.'],
	['/indexing', 'Indexing', 'Watch whether Google has indexed your pages, using a rotating sample of URL inspections.'],
	['/indexnow', 'IndexNow', 'Tell Bing and other IndexNow search engines the moment a page changes.'],
	['/onpage', 'On-page', 'Checks pages for common on-page problems, such as a missing title or description.'],
	['/sitemaps', 'Sitemaps', 'Your sitemaps as Google sees them, with a check that each can be fetched and read.'],
	['/inspect', 'Inspect', 'Look up Google\'s index status for specific URLs (URL Inspection).'],
	['/bing', 'Bing', 'Bing Webmaster data for this site, once Bing is linked.'],
	['/analytics', 'GA4', 'Google Analytics 4 organic sessions beside Search Console clicks, once GA4 is linked.'],
	['/tags', 'Tag Manager', 'What is in your Google Tag Manager container, checked against GA4 and Search Console, once it is linked.'],
	['/clarity', 'Clarity', 'Microsoft Clarity snapshot, once linked. Clarity only exposes the last 1 to 3 days, so one snapshot is stored daily.'],
	['/settings', 'Settings', 'Site preferences such as label, tags and brand terms, and what data is stored.']
] as const;

/** What a row in a site's "Recent syncs" list means. "auto" is the normal run: it also walks one chunk further back while the history is incomplete. */
export const SYNC_MODE_LABEL: Record<string, string> = { auto: 'Sync + backfill', incremental: 'Sync' };
export const syncModeLabel = (mode: string) => SYNC_MODE_LABEL[mode] ?? mode;
export const SYNC_RUNS_EXPLAIN = 'Every run re-pulls the newest few days, because Google revises recent figures. Until your history is complete (up to the 16 months Google keeps), a run also pulls one more chunk of 45 days further back, so a new site shows a string of "Sync + backfill" rows within the first minutes. Days is how many days were pulled in that run.';

/** How the site tabs are grouped in the tab bar: a caption and the tab paths under it. Every tab appears in exactly one group (a test checks it). */
export const SITE_TAB_GROUPS = [
	['Traffic', ['', '/queries', '/pages', '/trends', '/groups', '/segments', '/types']],
	['Findings', ['/quickwins', '/actions', '/opportunities', '/cannibalization', '/decay', '/onpage', '/vitals', '/tests']],
	['Indexing', ['/submit', '/request', '/indexing', '/indexnow', '/sitemaps', '/inspect']],
	['Other sources', ['/bing', '/analytics', '/tags', '/clarity']],
	['Site', ['/settings']]
] as const;

/**
 * Hover text for table column headers, by header label. A column's own `title` wins over this. Only labels that mean the same thing
 * wherever they appear are listed; a label that means different things in different tables (such as "Expected") gets its own title where it is defined.
 */
export const COLUMN_HINT: Record<string, string> = {
	Clicks: 'How many times people clicked through to your site from search results.',
	Impressions: 'How many times a result for your site was shown in search results.',
	'Impr.': 'Impressions: how many times a result for your site was shown in search results.',
	CTR: 'Click-through rate: clicks divided by impressions.',
	Position: 'Average ranking position in search results. 1 is the top; a lower number is better.',
	Pos: 'Average ranking position in search results. 1 is the top; a lower number is better.',
	'Avg position': 'Average ranking position in search results. 1 is the top; a lower number is better.',
	'Δ': 'Change in clicks, as a percentage, against the previous period of the same length.',
	'Δ %': 'Change in clicks, as a percentage, against the previous period of the same length.',
	'Δ clicks': 'Change in clicks, as a percentage, against the previous period of the same length.',
	'vs site': 'How this page\'s change compares with the change of the whole site, so a page falling while its site grows stands out.',
	'Est. +clicks': 'Estimated extra clicks per period if this query reached position 3, from this site\'s own click-through curve. An estimate, not a forecast.',
	'Clicks at stake': 'Estimated extra clicks if one page took the best position for this query.',
	'Lost clicks': 'Clicks lost against the previous period of the same length.',
	'Indexed?': 'Whether Google reports the page as being in its index, from URL Inspection.',
	Sessions: 'Visits, as Google Analytics 4 counts them.',
	Engaged: 'Share of sessions that Google Analytics 4 counted as engaged.',
	'Key events': 'Actions you marked as key events in Google Analytics 4 (formerly called conversions).',
	'Rage clicks': 'Microsoft Clarity flags many rapid clicks in the same spot, a sign the visitor was frustrated.'
};
