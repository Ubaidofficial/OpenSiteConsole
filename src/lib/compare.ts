/**
 * The comparison pages: SEOConsole against the tools people weigh it with. Written to be fair, because a comparison that flatters is worthless:
 * every claim about a competitor comes from its own public pages (listed under each, with the date they were read), anything those pages do
 * not say is marked "not stated" rather than "no", and the rows where they are ahead are kept in. Every claim about SEOConsole is something the
 * app does today (see README); what it does not do yet is marked "no". Prices and features change, so each page says when it was checked.
 */
export type Verdict = 'yes' | 'partial' | 'no' | 'unknown';
export interface Cell { v: Verdict; note?: string }
export interface Row { group: string; feature: string; ours: Cell; theirs: Cell }
export interface Shot { src: string; alt: string; caption: string }
export interface Competitor {
	slug: string;
	name: string;
	url: string;
	/** one line: what it is for */
	blurb: string;
	checkedOn: string;
	/** what they charge, as their page says */
	price: string;
	weWin: string[];
	theyWin: string[];
	rows: Row[];
	shots: Shot[];
	sources: { label: string; url: string }[];
}

const y = (note?: string): Cell => ({ v: 'yes', note });
const p = (note?: string): Cell => ({ v: 'partial', note });
const n = (note?: string): Cell => ({ v: 'no', note });
const u = (note = 'Not stated on its public pages.'): Cell => ({ v: 'unknown', note });

export const CHECKED_ON = '2026-11-07';
export const REPO_URL = 'https://github.com/Ubaidofficial/OpenSiteConsole';
export const VERDICT_LABEL: Record<Verdict, string> = { yes: 'Yes', partial: 'Partly', no: 'No', unknown: 'Not stated' };

const MATURITY = (theirs: Cell): Row => ({
	group: 'Price and maturity', feature: 'How established it is',
	ours: p('A young project: tested on demo data and test doubles, not yet run against live Google data (see "Known limits" in the README).'),
	theirs
});

export const COMPETITORS: Competitor[] = [
	{
		slug: 'seotesting',
		name: 'SEOTesting.com',
		url: 'https://seotesting.com/',
		blurb: 'SEO split and before/after testing on Search Console and Google Analytics data, with content decay, cannibalization and CTR reports.',
		checkedOn: CHECKED_ON,
		price: 'From $50 a month for one site; $125 for 5 sites; $375 for 20 sites; larger plans on request. 14-day free trial, no card.',
		weWin: [
			'Free to self-host, with no per-site price: add every site and account you have.',
			'An indexing toolkit (submit, request list, re-checks, monitoring) next to the tests.',
			'Bing, Clarity and Tag Manager data beside Search Console, and an MCP server so an AI agent can read and act on it.',
			'Your data stays on your own server and history is kept beyond Search Console’s 16 months.',
			'Unlimited users, free, with roles (admin, editor, viewer) and per-user site limits.'
		],
		theyWin: [
			'LLM tests (before/after on AI-assistant sessions) and an internal-linking tool: we have neither.',
			'A monthly plain-English report and a daily watch that includes robots.txt changes.',
			'It is hosted, supported and established: nothing to run, and it names customers on its site.'
		],
		rows: [
			{ group: 'SEO tests', feature: 'Before/after tests', ours: y('Clicks, impressions and position against control pages, with the noise level measured on your own earlier weeks.'), theirs: y('Single page or a group of pages, on Search Console data.') },
			{ group: 'SEO tests', feature: 'Split tests with a control group', ours: y('Control pages matched automatically from pre-change data, or the rest of the site, or pages you name.'), theirs: y('Similar pages as the control group.') },
			{ group: 'SEO tests', feature: 'Redirect / URL-switch tests', ours: y('Old and new URLs are measured together so moved traffic is not counted as lost.'), theirs: y('Switch tests for URL redirects.') },
			{ group: 'SEO tests', feature: 'A significance figure for each test', ours: y('A 95% range, a p-value and the smallest change the test could have detected; it says so when “no effect” is weak evidence.'), theirs: y('A significance figure for each result.') },
			{ group: 'SEO tests', feature: 'Conversions inside a test (Google Analytics)', ours: y('Key events, and key events per session, from Google organic.'), theirs: y('When Google Analytics is connected.') },
			{ group: 'SEO tests', feature: 'Google updates flagged on a test', ours: y('An overlapping core or spam update is shown and the result is flagged for extra caution.'), theirs: y('Updates are marked on the chart and shown by page group.') },
			{ group: 'SEO tests', feature: 'LLM tests (AI-assistant sessions before and after)', ours: n('Not built.'), theirs: y() },
			{ group: 'Reports', feature: 'Content decay', ours: y('Against the previous period, and against the same time last year once 12+ months of history are stored.'), theirs: y('Pages losing clicks year on year.') },
			{ group: 'Reports', feature: 'Cannibalization', ours: y(), theirs: y() },
			{ group: 'Reports', feature: 'CTR opportunities', ours: y('Pages under-performing the click rate your own site gets at that position.'), theirs: y('Pages with impressions but too few clicks.') },
			{ group: 'Reports', feature: 'Quick wins (low-hanging fruit)', ours: y('A Quick wins tab: titles to rewrite, searches one push from page 1, question queries you already rank for, sitemap gaps.'), theirs: u() },
			{ group: 'Reports', feature: 'AI-assistant traffic by page', ours: y('From Google Analytics referrers; an assistant that sends no referrer is missed.'), theirs: y('From Google Analytics data.') },
			{ group: 'Reports', feature: 'Question-shaped queries', ours: y(), theirs: y() },
			{ group: 'Reports', feature: 'Monthly plain-English report', ours: p('A weekly digest and urgent alerts to Slack, Discord or a webhook; no monthly report yet.'), theirs: y('A forwardable monthly summary.') },
			{ group: 'Reports', feature: 'Daily watch for changes', ours: p('Traffic-drop detection, indexing-change events and sitemap reads; no robots.txt watch.'), theirs: y('Pages that gained or lost clicks, new queries, sitemap and robots.txt changes.') },
			{ group: 'Reports', feature: 'Internal-linking tool', ours: n('Not built.'), theirs: y('A monthly credit allowance per plan.') },
			{ group: 'Beyond testing', feature: 'Indexing toolkit (submit, request list, re-checks, monitor)', ours: y('IndexNow, Bing and (for job and livestream pages) Google’s Indexing API, plus a Request Indexing list and day 1/3/5 re-checks.'), theirs: u() },
			{ group: 'Beyond testing', feature: 'Bing, Clarity and Tag Manager next to Search Console', ours: y(), theirs: u('Its pages list Search Console and Google Analytics only.') },
			{ group: 'Beyond testing', feature: 'MCP server for AI agents', ours: y('Read tools for all the data; anything that changes something needs a key created for it.'), theirs: u() },
			{ group: 'Beyond testing', feature: 'Many sites and Google accounts in one place', ours: y('No limit; it runs on your own server.'), theirs: p('Priced by the number of sites: 1, 5 or 20, more on request.') },
			{ group: 'Beyond testing', feature: 'History beyond Search Console’s 16 months', ours: y('Kept in your own database from the first sync.'), theirs: u() },
			{ group: 'Beyond testing', feature: 'More than one user', ours: y('Unlimited users, free: invite links with roles (admin, editor, viewer) and optional per-user site limits. Invites are links you send yourself; it sends no email.'), theirs: y('Unlimited users.') },
			{ group: 'Beyond testing', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('A hosted service (it says your Search Console data is not fed into a shared index).') },
			{ group: 'Price and maturity', feature: 'Free trial', ours: y('Free for good when self-hosted: nothing to trial.'), theirs: y('14 days, up to 30 sites, no card.') },
			MATURITY(y('Established; its site names customers and shows ratings (its own claims).'))
		],
		shots: [
			{ src: '/img/compare/tests.jpg', alt: 'A SEOConsole SEO test result with clicks against control pages, a Google update overlap warning and conversions', caption: 'A test result: clicks against control pages, how big a change the test could detect, a Google update that overlaps, and conversions.' },
			{ src: '/img/compare/quickwins.jpg', alt: 'The Quick wins tab listing titles to rewrite with estimated extra clicks', caption: 'Quick wins: the cheapest improvements first, with an estimate of the extra clicks.' },
			{ src: '/img/compare/decay.jpg', alt: 'The Decay tab with a choice between the previous period and the same time last year', caption: 'Decay, against the previous period or the same time last year.' }
		],
		sources: [{ label: 'SEOTesting.com home page', url: 'https://seotesting.com/' }, { label: 'SEOTesting.com pricing', url: 'https://seotesting.com/pricing/' }]
	},
	{
		slug: 'indexchex',
		name: 'IndexChex',
		url: 'https://indexchex.com/',
		blurb: 'A paid index checker and URL indexer, built for backlinks, citations and fresh pages.',
		checkedOn: CHECKED_ON,
		price: 'Subscriptions $19.99, $49.99 or $149.99 a month for 5,000, 25,000 or 100,000 credits; credit packs from $21.99; no free tier. One credit is one URL checked or submitted.',
		weWin: [
			'Free to self-host, with no per-URL cost.',
			'It works through official channels (IndexNow, Bing, Search Console, the Indexing API where Google documents it) and shows why a page is not indexed.',
			'The rest of the Search Console toolkit is in the same place: tests, decay, sitemaps, the Request Indexing list.',
			'It tells you plainly that no tool can force Google to index a page.'
		],
		theyWin: [
			'It can check any URL, including third-party backlinks. SEOConsole checks only pages in properties you own, because that is all Google’s URL Inspection allows.',
			'It handles batches of 10,000 and promises crawls for links you do not control; SEOConsole does not do that at all.',
			'An API that covers checking and submission: SEOConsole has an MCP server but no REST API yet.'
		],
		rows: [
			{ group: 'Checking', feature: 'Check whether your own pages are indexed', ours: y('Google’s URL Inspection, with the reason (for example “Crawled – currently not indexed”).'), theirs: y() },
			{ group: 'Checking', feature: 'Check any URL, such as backlinks', ours: n('Only pages in properties you own.'), theirs: y('Batch checks of up to 10,000 URLs; its methodology page was not read for this comparison.') },
			{ group: 'Checking', feature: 'Re-check after submitting', ours: y('Automatically at day 1, 3 and 5.'), theirs: y('Automatically 1 to 5 days after a submission.') },
			{ group: 'Checking', feature: 'Scheduled monitoring of your own pages', ours: y('The indexing monitor: de-indexing, canonical changes, blocks, fetch errors.'), theirs: y('Scheduled checks of indexer jobs.') },
			{ group: 'Submitting', feature: 'Batch size', ours: p('Up to 100 URLs per submission, within each channel’s own daily limit.'), theirs: y('Up to 10,000 URLs per job.') },
			{ group: 'Submitting', feature: 'Drip-feed over days', ours: y('1 to 30 days; URLs over a daily limit wait and go on the next days.'), theirs: y('Up to 30 days.') },
			{ group: 'Submitting', feature: 'IndexNow and Bing submission', ours: y(), theirs: u('Its method is not explained.') },
			{ group: 'Submitting', feature: 'Google’s Indexing API', ours: p('Only for job-posting and livestream pages, which is all Google documents it for; other pages are refused.'), theirs: u() },
			{ group: 'Submitting', feature: 'Get third-party or backlink URLs crawled', ours: n('Not offered.'), theirs: y('It says it sends “real Googlebot crawls” to your links; the mechanism is not explained.') },
			{ group: 'Submitting', feature: '“Instant” indexing', ours: n('No such promise: no tool can make Google index a page.'), theirs: y('An instant mode (5 minutes claimed, 60 credits a URL); its FAQ also says no one can guarantee indexing.') },
			{ group: 'Beyond indexing', feature: 'Search Console toolkit (tests, decay, sitemaps, request list)', ours: y(), theirs: n() },
			{ group: 'Beyond indexing', feature: 'CSV export', ours: y('The submission and result table.'), theirs: y() },
			{ group: 'Beyond indexing', feature: 'API', ours: p('An MCP server for AI agents; no REST API yet.'), theirs: y('Covers checking and submission.') },
			{ group: 'Price and maturity', feature: 'Free tier', ours: y('Free for good when self-hosted.'), theirs: n('None listed; test credits can be requested from support.') },
			MATURITY(y('Reports 33,968,266 links submitted by 16,263 SEOs on its site (its own figures).'))
		],
		shots: [
			{ src: '/img/compare/submit.jpg', alt: 'The Submit tab: URLs, channels, drip and queue, limits and the table of what happened', caption: 'Submit: channels, drip over days, daily limits, the queue, and what happened to each URL.' },
			{ src: '/img/compare/request.jpg', alt: 'The Request tab with the daily allowance and pages to fix first', caption: 'Request: the pages worth asking Google about, and the ones to fix first.' }
		],
		sources: [{ label: 'IndexChex home page', url: 'https://indexchex.com/' }, { label: 'IndexChex pricing', url: 'https://indexchex.com/pricing' }]
	},
	{
		slug: 'promptwatch',
		name: 'Promptwatch',
		url: 'https://promptwatch.com/',
		blurb: 'AI search visibility: tracks prompts across AI models, the sources they cite, and AI crawler activity.',
		checkedOn: CHECKED_ON,
		price: '$95, $245 or $579 a month (50, 150 or 350 prompts); free trial on those plans; custom enterprise.',
		weWin: [
			'Free to self-host.',
			'AI-assistant visits are joined with Search Console and Bing per page, so you see what a page earns from each in one row.',
			'A full SEO toolkit alongside: tests, indexing, decay, quick wins.'
		],
		theyWin: [
			'Prompt tracking across AI models, citation and source analysis, competitor share of voice and AI crawler logs. SEOConsole has none of these.',
			'Content writing and refresh, and country-level tracking.',
			'A hosted, supported product that does one thing deeply.'
		],
		rows: [
			{ group: 'AI visibility', feature: 'Track prompts across AI models', ours: n('Not built.'), theirs: y('50, 150 or 350 prompts depending on the plan.') },
			{ group: 'AI visibility', feature: 'Citation and source analysis', ours: n('Not built.'), theirs: y('Which sources and content types get cited.') },
			{ group: 'AI visibility', feature: 'Competitor share of voice', ours: n('Not built.'), theirs: y() },
			{ group: 'AI visibility', feature: 'AI crawler logs', ours: n('Not built.'), theirs: y('It describes a Cloudflare integration for them.') },
			{ group: 'AI visibility', feature: 'Visits from AI assistants, by page', ours: y('From Google Analytics referrers, beside Google and Bing clicks for the same page; an assistant that sends no referrer is missed.'), theirs: y('AI-referred traffic.') },
			{ group: 'AI visibility', feature: 'Question-shaped searches you already rank for', ours: y('In Quick wins, from Search Console.'), theirs: u() },
			{ group: 'Search data', feature: 'Google and Bing numbers joined per page', ours: y('The Pages table.'), theirs: y('Its Search insights page joins Google, Bing and AI numbers by URL path.') },
			{ group: 'Search data', feature: 'SEO tests, decay, cannibalization, quick wins', ours: y(), theirs: u() },
			{ group: 'Search data', feature: 'Indexing toolkit', ours: y(), theirs: u() },
			{ group: 'Access', feature: 'MCP server', ours: y('Read tools for all the data.'), theirs: y('MCP and API access on every plan.') },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('A hosted service.') },
			{ group: 'Price and maturity', feature: 'Free tier', ours: y('Free for good when self-hosted.'), theirs: p('A free trial on its paid plans.') },
			MATURITY(y('An established product with published plans and comparisons (its own claims).'))
		],
		shots: [
			{ src: '/img/compare/pages.jpg', alt: 'The Pages table with Google, Bing, Google Analytics and AI-assistant columns side by side', caption: 'Pages: Google, Bing, GA4 and AI-assistant visits for the same URL.' },
			{ src: '/img/compare/actions.jpg', alt: 'The Actions page with filters by site, kind and effort', caption: 'Actions: what to do first across all your sites.' }
		],
		sources: [{ label: 'Promptwatch pricing', url: 'https://promptwatch.com/pricing' }, { label: 'Promptwatch prompt tracking', url: 'https://promptwatch.com/prompt-tracking' }, { label: 'Promptwatch crawler logs', url: 'https://promptwatch.com/crawler-logs' }]
	},
	{
		slug: 'google-search-console',
		name: 'Google Search Console',
		url: 'https://search.google.com/search-console',
		blurb: 'Google’s own free tool. It is the source of the data SEOConsole reads.',
		checkedOn: CHECKED_ON,
		price: 'Free.',
		weWin: [
			'Every property and Google account in one place.',
			'History kept beyond the 16 months Search Console shows, in your own database.',
			'SEO tests, decay, cannibalization, quick wins and a ranked to-do list that Search Console does not have.',
			'Bing, Analytics and Clarity next to it, and an MCP server.'
		],
		theyWin: [
			'It is the source of truth, and it has the Request Indexing button itself: no other tool can press it.',
			'Tools SEOConsole does not replicate: Removals, Manual actions, Security issues, the Links report and Crawl stats (as I understand it; check Search Console).',
			'Nothing to install or run.'
		],
		rows: [
			{ group: 'Data', feature: 'Search performance data', ours: y('Read from Search Console and stored.'), theirs: y('The original.') },
			{ group: 'Data', feature: 'History beyond 16 months', ours: y('Kept from your first sync.'), theirs: n('Shows about 16 months.') },
			{ group: 'Data', feature: 'Many properties and accounts together', ours: y(), theirs: n('One property at a time.') },
			{ group: 'Data', feature: 'Bing, Analytics and Clarity next to it', ours: y(), theirs: n() },
			{ group: 'Indexing', feature: 'Request Indexing', ours: p('Prepares the list and tracks the result; you press the button, because it has no API.'), theirs: y('The button itself, by hand.') },
			{ group: 'Indexing', feature: 'URL Inspection and sitemaps', ours: y('Through the API, including submit and delete.'), theirs: y() },
			{ group: 'Indexing', feature: 'Submit to Bing and IndexNow engines', ours: y(), theirs: n('Not part of it.') },
			{ group: 'Analysis', feature: 'SEO tests with a control group', ours: y(), theirs: n() },
			{ group: 'Analysis', feature: 'Decay, cannibalization, striking distance, CTR gaps, quick wins', ours: y(), theirs: n() },
			{ group: 'Analysis', feature: 'A ranked to-do list and a weekly digest', ours: y(), theirs: n() },
			{ group: 'Google-only tools', feature: 'Removals, Manual actions, Security issues, Links, Crawl stats', ours: n('Not replicated.'), theirs: y('As I understand it; check Search Console.') },
			{ group: 'Access', feature: 'MCP server for AI agents', ours: y('Read tools for all the data.'), theirs: u() },
			{ group: 'Price and maturity', feature: 'Price', ours: y('Free when self-hosted.'), theirs: y('Free.') },
			MATURITY(y('Google’s own product.'))
		],
		shots: [
			{ src: '/img/compare/actions.jpg', alt: 'The Actions page with filters by site, kind and effort', caption: 'A ranked to-do list across every site.' },
			{ src: '/img/compare/pages.jpg', alt: 'The Pages table with Google, Bing, Google Analytics and AI-assistant columns side by side', caption: 'Search Console beside Bing, Analytics and AI visits.' }
		],
		sources: [{ label: 'Search Console', url: 'https://search.google.com/search-console' }, { label: 'Request Indexing is not in the API (third-party write-up)', url: 'https://aident.ai/blog/audit-url-indexing-search-console-codex' }]
	}
];

export const bySlug = (slug: string) => COMPETITORS.find((c) => c.slug === slug);
export const groupsOf = (rows: Row[]) => [...new Set(rows.map((r) => r.group))];

/** What SEOConsole costs, from the environment so a self-hoster or the hosted-plan owner can say it in their own words. */
export const DEFAULT_HOSTED_PRICE = 'Hosted by us: $9 a month ($29 a month with the advanced indexing features; launch price $19).';
