/**
 * Plain-language explainers for the action queue: what each kind of finding is, and what each chip and button means.
 * Written from how the findings are built in src/lib/server/actions.ts, and kept free of site data so they are safe to show
 * in privacy mode. A test checks that every action type has both a label and an explainer.
 */
import { DONE_DAYS, SNOOZE_DAYS, type ActionType, type Confidence, type Effort } from './actions';

export const TYPE_LABEL: Record<ActionType, string> = {
	tracking: 'Measurement', blocked: 'Blocked', deindexed: 'De-indexed', sitewide: 'Site-wide', anomaly: 'Traffic drop', dead: 'Gone',
	'not-indexed': 'Not indexed', update: 'Google update', cannibalization: 'Cannibalization', 'ctr-gap': 'CTR gap', decay: 'Decay',
	striking: 'Striking distance', onpage: 'On-page', sitemap: 'Sitemap', vitals: 'Web vitals', test: 'Test',
	'lost-query': 'Lost searches', rising: 'Rising searches', 'page-edge': 'Page on the edge', gem: 'Hidden gem', questions: 'Unanswered questions',
	bing: 'Bing', device: 'Phone gap', engagement: 'Visitors leave', friction: 'Friction'
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
	vitals: 'Real visitors on phones get a poor Core Web Vitals result (loading speed, responsiveness or layout shift). It is a small ranking factor and a real cost to visitors.',
	test: 'The result of an SEO test you started: it may have worked, failed, conflicted with conversions, or be too early to tell.',
	'lost-query': 'Searches that used to bring you clicks and have nearly stopped. Some are lost rankings, some are seasonal, and a few simply dropped out of the data Google shares.',
	rising: 'Searches whose impressions have at least doubled and where you still rank below the top five: demand is arriving and you have not captured it yet.',
	'page-edge': 'One page that sits just below the top results for several searches at once. A single good update to that page can lift all of them together.',
	gem: 'A page whose visitors engage and convert better than your site average, yet Google ranks it at positions 4 to 20. The right audience is arriving; there is just not enough of it.',
	questions: 'Question-style searches (how, why, what, can I) where you show up but rank low. A short, direct answer on the page is the usual way in.',
	bing: 'Bing and Google disagree about your site: Bing ranks a page near the top where Google does not, or Bing shows nothing for pages that earn Google clicks.',
	device: 'You rank noticeably worse on phones than on desktop for the same search. Most visitors are on phones, so check the mobile page and its speed.',
	engagement: 'Visitors who arrive from Google leave faster or convert less than on the rest of the site: the page may not match what the search promised.',
	friction: 'Microsoft Clarity recorded many visits with rage clicks or dead clicks (repeated clicks on things that do nothing) on a page that Google sends visitors to.'
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
	['Findings', ['/actions', '/opportunities', '/cannibalization', '/decay', '/onpage', '/vitals', '/tests']],
	['Indexing', ['/indexing', '/indexnow', '/sitemaps', '/inspect']],
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

/** The Hidden opportunities block on the Opportunities tab: what each table means, and what is missing when it is empty. */
export const HIDDEN_INTRO = 'These need more than one source or more than one period to see, so they do not show up in Search Console on its own. Each estimate comes from your own click curve and is a model figure, not a promise.';
export const HIDDEN_SOURCE_HINT: Record<'previousPeriod' | 'bing' | 'ga4' | 'clarity', string> = {
	previousPeriod: 'The period before this one is not downloaded yet, so lost and rising searches cannot be worked out. Run a full history sync from the site settings.',
	bing: 'Bing is not connected for this site. Connect it on the Connect page to see where Bing and Google disagree.',
	ga4: 'GA4 has no landing-page data for this window. Connect GA4 on the Connect page (it is pulled with the next sync).',
	clarity: 'Clarity has no snapshot for this site yet. Add a Clarity token on the Connect page; it keeps one snapshot per day.'
};
export const HIDDEN_GROUPS: { id: string; title: string; blurb: string }[] = [
	{ id: 'lost', title: 'Lost searches', blurb: 'Searches that earned clicks in the previous period and have nearly stopped. Some may be seasonal, or may have dropped out of the data Google shares.' },
	{ id: 'rising', title: 'Rising searches', blurb: 'Impressions at least doubled and you rank below the top five: demand is arriving and you have not captured it.' },
	{ id: 'edge', title: 'Pages on the edge', blurb: 'One page sitting at positions 4 to 20 for several searches at once. One good update can lift all of them. The estimate assumes they all reach position 5, so it is a ceiling.' },
	{ id: 'questions', title: 'Questions you rank low for', blurb: 'Question-style searches where you show up below position 7. A short, direct answer on the page is the usual way in.' },
	{ id: 'bing', title: 'Bing ranks you, Google does not', blurb: 'Bing has you in the top five, Google at 11 or lower or not at all. The content is probably right for the topic; Google may want more links or a clearer match.' },
	{ id: 'notbing', title: 'Pages Bing shows nothing for', blurb: 'They earn Google clicks and have no Bing impressions, so Bing probably has not indexed them. IndexNow or Bing Webmaster Tools submits them.' },
	{ id: 'gems', title: 'Hidden gems', blurb: 'Pages whose visitors engage and convert better than your average, ranked 4 to 20 by Google. The audience is right; there is not enough of it.' },
	{ id: 'leaks', title: 'Visitors who leave', blurb: 'Google landing pages where far fewer visitors engage than on the rest of your site (GA4).' },
	{ id: 'noconv', title: 'Busy pages with no conversions', blurb: 'Busy Google landing pages with no key events at all, on a site that converts elsewhere. Check the key event can fire there before changing content.' },
	{ id: 'friction', title: 'Rage and dead clicks', blurb: 'Pages Google sends visitors to where many sessions had repeated clicks on things that do nothing (Clarity, last day only).' },
	{ id: 'device', title: 'Worse on phones', blurb: 'You rank at least three places worse on phones than on desktop for the same search. Google ranks the phone version of your pages.' }
];
