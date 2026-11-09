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
	ours: p('A young project: tested on demo data and test doubles, not yet run against live Google data (see "Known limits" in docs/known-limits.md).'),
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
			'Internal-link suggestions with no credit allowance: crawl and re-crawl as often as you like.',
			'An indexing toolkit (submit, request list, re-checks, monitoring) next to the tests.',
			'Bing, Clarity and Tag Manager data beside Search Console, and an MCP server so an AI agent can read and act on it.',
			'Your data stays on your own server and history is kept beyond Search Console’s 16 months.',
			'Unlimited users, free, with roles (admin, editor, viewer) and per-user site limits.',
			'A daily robots.txt watch that tests the pages earning clicks against the rules Googlebot obeys, not only whether the file changed.'
		],
		theyWin: [
			'Its monthly report can be emailed; SEOConsole sends reports and alerts to Slack, Discord or a webhook only.',
			'It is hosted, supported and established: nothing to run, and it names customers on its site.'
		],
		rows: [
			{ group: 'SEO tests', feature: 'Before/after tests', ours: y('Clicks, impressions and position against control pages, with the noise level measured on your own earlier weeks.'), theirs: y('Single page or a group of pages, on Search Console data.') },
			{ group: 'SEO tests', feature: 'Split tests with a control group', ours: y('Control pages matched automatically from pre-change data, or the rest of the site, or pages you name.'), theirs: y('Similar pages as the control group.') },
			{ group: 'SEO tests', feature: 'Redirect / URL-switch tests', ours: y('Old and new URLs are measured together so moved traffic is not counted as lost.'), theirs: y('Switch tests for URL redirects.') },
			{ group: 'SEO tests', feature: 'A significance figure for each test', ours: y('A 95% range, a p-value and the smallest change the test could have detected; it says so when “no effect” is weak evidence.'), theirs: y('A significance figure for each result.') },
			{ group: 'SEO tests', feature: 'Conversions inside a test (Google Analytics)', ours: y('Key events, and key events per session, from Google organic.'), theirs: y('When Google Analytics is connected.') },
			{ group: 'SEO tests', feature: 'Google updates flagged on a test', ours: y('An overlapping core or spam update is shown and the result is flagged for extra caution.'), theirs: y('Updates are marked on the chart and shown by page group.') },
			{ group: 'SEO tests', feature: 'LLM tests (AI-assistant sessions before and after)', ours: y('Before/after or split tests on GA4 sessions from AI assistants (all, or one), with the same control pages and calibrated statistics as click tests; it says “too little AI traffic to tell” when the counts are too small. Only assistants that send a referrer are seen.'), theirs: y() },
			{ group: 'Reports', feature: 'Content decay', ours: y('Against the previous period, and against the same time last year once 12+ months of history are stored.'), theirs: y('Pages losing clicks year on year.') },
			{ group: 'Reports', feature: 'Cannibalization', ours: y(), theirs: y() },
			{ group: 'Reports', feature: 'CTR opportunities', ours: y('Pages under-performing the click rate your own site gets at that position.'), theirs: y('Pages with impressions but too few clicks.') },
			{ group: 'Reports', feature: 'Quick wins (low-hanging fruit)', ours: y('A Quick wins tab: titles to rewrite, searches one push from page 1, question queries you already rank for, sitemap gaps.'), theirs: u() },
			{ group: 'Reports', feature: 'AI-assistant traffic by page', ours: y('From Google Analytics referrers; an assistant that sends no referrer is missed.'), theirs: y('From Google Analytics data.') },
			{ group: 'Reports', feature: 'Question-shaped queries', ours: y(), theirs: y() },
			{ group: 'Reports', feature: 'Monthly plain-English report', ours: y('The last calendar month in sentences, per day against the month before and the same month last year, made on the 4th; to Slack, Discord or a webhook (no email).'), theirs: y('A forwardable monthly summary.') },
			{ group: 'Reports', feature: 'Daily watch for changes', ours: y('Traffic-drop detection, indexing-change events, daily sitemap reads and a daily robots.txt watch (changes kept, and pages with clicks tested against the rules Googlebot obeys).'), theirs: y('Pages that gained or lost clicks, new queries, sitemap and robots.txt changes.') },
			{ group: 'Reports', feature: 'Internal-linking tool', ours: y('Free, with no credits: crawls up to 60 of your pages weekly (more if you set it) and suggests which pages should link to the ones ranking 4 to 20, with the anchor text already on the page. HTML only: JavaScript is not run.'), theirs: y('A monthly credit allowance per plan.') },
			{ group: 'Beyond testing', feature: 'Indexing toolkit (submit, request list, re-checks, monitor)', ours: y('IndexNow, Bing and (for job and livestream pages) Google’s Indexing API, plus a Request Indexing list and day 1/3/5 re-checks.'), theirs: u() },
			{ group: 'Beyond testing', feature: 'Bing, Clarity and Tag Manager next to Search Console', ours: y(), theirs: u('Its pages list Search Console and Google Analytics only.') },
			{ group: 'Beyond testing', feature: 'MCP server for AI agents', ours: y('Read tools for all the data; anything that changes something needs a key created for it.'), theirs: y('An API and an MCP server are listed on its features page (read on 2026-11-08).') },
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
		sources: [{ label: 'SEOTesting.com home page', url: 'https://seotesting.com/' }, { label: 'SEOTesting.com pricing', url: 'https://seotesting.com/pricing/' }, { label: 'SEOTesting.com features', url: 'https://seotesting.com/home/features/' }, { label: 'SEOTesting.com LLM tests', url: 'https://seotesting.com/llm-testing/' }]
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
			'Its API checks and submits any URL; SEOConsole’s REST API covers only properties you own.'
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
			{ group: 'Beyond indexing', feature: 'API', ours: y('A REST API and an MCP server, with the same API keys and permission levels; only for properties you own.'), theirs: y('Covers checking and submission.') },
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
			'Prompt tracking at scale with citation and content-type analysis, and AI crawler logs. SEOConsole’s prompt tracking is basic (four assistants through your own keys or DataForSEO) and it has no crawler logs.',
			'Content writing and refresh, and country-level tracking.',
			'A hosted, supported product that does one thing deeply.'
		],
		rows: [
			{ group: 'AI visibility', feature: 'Track prompts across AI models', ours: p('Basic: up to 50 prompts per site, asked of ChatGPT, Gemini, Claude and Perplexity with web search, through your own API keys or DataForSEO (which reads ChatGPT and Gemini as seen in their apps), with a daily cap.'), theirs: y('50, 150 or 350 prompts depending on the plan.') },
			{ group: 'AI visibility', feature: 'Citation and source analysis', ours: p('Which domains each answer cites, whether yours is among them and at what rank, and the most-cited domains; no content-type analysis.'), theirs: y('Which sources and content types get cited.') },
			{ group: 'AI visibility', feature: 'Competitor share of voice', ours: p('Mention and citation share against up to 10 competitor domains you list, on the same answers.'), theirs: y() },
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
		slug: 'gsc-wizard',
		name: 'GSC Wizard',
		url: 'https://www.gscwizard.com/',
		blurb: 'A hosted Search Console analytics tool that adds Bing, Yandex, GA4 and Merchant Center, with an MCP server and a ChatGPT app.',
		checkedOn: '2026-11-08',
		price: 'Starter €17 a month (15 properties, owner + 1 seat), Pro €39 (75 properties, + 3 seats), Business €249 (650 properties, + 10 seats); custom plans from €349. Prices exclude VAT, monthly only; 7-day free trial, no card.',
		weWin: [
			'Free to self-host, with no limit on properties or seats.',
			'Clarity and Tag Manager next to Search Console, with a tracking audit and a one-click Clarity install.',
			'Your data stays on your own server, and history is kept for every property, not only the ones on a storage plan.',
			'An MCP server that can also act (submit URLs, sitemaps, IndexNow) when you allow it.'
		],
		theyWin: [
			'Hosted: nothing to install or run, and it reports serving tens of thousands of properties (its own claim).',
			'Yandex Webmaster and Google Merchant Center, which SEOConsole does not read; its forecasting, topic clusters and hreflang reports go further than SEOConsole’s simpler versions.',
			'A ChatGPT app and a Looker Studio connector.'
		],
		rows: [
			{ group: 'Data', feature: 'Many sites and Google accounts in one place', ours: y('No limit.'), theirs: y('15, 75 or 650 properties by plan; extra Google accounts can be linked.') },
			{ group: 'Data', feature: 'History beyond Search Console’s 16 months', ours: y('Kept for every property from the first sync.'), theirs: p('Up to 10 years on “full storage” properties only; others get 16 months.') },
			{ group: 'Data', feature: 'Bing next to Google', ours: y(), theirs: y('Bing Webmaster Tools and Yandex Webmaster.') },
			{ group: 'Data', feature: 'GA4 next to Search Console', ours: y(), theirs: y() },
			{ group: 'Data', feature: 'Clarity and Tag Manager', ours: y('Including a tracking audit and a one-click Clarity install through Tag Manager.'), theirs: u() },
			{ group: 'Analysis', feature: 'SEO tests with a control group and significance', ours: y('Before/after, split and redirect tests.'), theirs: y('A/B tests with control and treatment groups, p-values and effect sizes.') },
			{ group: 'Analysis', feature: 'Decay, cannibalization, striking distance and CTR gaps', ours: y(), theirs: y() },
			{ group: 'Analysis', feature: 'AI-assistant traffic by page', ours: y('From GA4 referrers.'), theirs: y('An AI / LLM traffic view from GA4.') },
			{ group: 'Analysis', feature: 'Core Web Vitals', ours: y('Field data from the Chrome UX Report, stored daily.'), theirs: y('CrUX field data with trends and alerts.') },
			{ group: 'Indexing', feature: 'Indexing toolkit (IndexNow, Bing, inspection, monitoring)', ours: y('IndexNow, Bing, a Request Indexing list and day 1/3/5 re-checks.'), theirs: y('URL Inspection in bulk, IndexNow and an Index Tracker for up to 1,800 URLs a day.') },
			{ group: 'Reports', feature: 'Scheduled reports and alerts', ours: y('A weekly digest, a monthly report and urgent alerts to Slack, Discord or a webhook.'), theirs: y('Daily, weekly and monthly reports to Slack; alerts to Slack, Teams and webhooks.') },
			{ group: 'Access', feature: 'MCP server for AI agents', ours: y('Reads by default; acting needs a level you grant.'), theirs: y('A remote MCP server on every plan.') },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('Hosted; a dedicated server is offered on custom plans only.') },
			{ group: 'Access', feature: 'Nothing to install or run', ours: n('Self-host only, for now.'), theirs: y('Hosted.') },
			{ group: 'More', feature: 'Yandex Webmaster and Google Merchant Center', ours: n('Not built.'), theirs: y() },
			{ group: 'More', feature: 'Traffic forecasting', ours: p('An 8-week click projection with a range on the Trends tab; it does not model seasonality or Google updates.'), theirs: y() },
			{ group: 'More', feature: 'Topic clusters', ours: p('Queries grouped by shared words on the Groups tab: transparent word matching, not semantic.'), theirs: y() },
			{ group: 'More', feature: 'hreflang report', ours: p('Flags locale folders (such as /en-gb/) that earn most clicks from another country; it does not read hreflang tags.'), theirs: y() },
			{ group: 'Price and maturity', feature: 'Price', ours: y('Free to self-host.'), theirs: p('From €17 a month for 15 properties, excluding VAT.') },
			MATURITY(y('Established; it says it tracks 88,650+ properties for 5,750+ SEOs (its own claim).'))
		],
		shots: [
			{ src: '/img/compare/actions.jpg', alt: 'The Actions page with filters by site, kind and effort', caption: 'A ranked to-do list across every site.' },
			{ src: '/img/compare/pages.jpg', alt: 'The Pages table with Google, Bing, Google Analytics and AI-assistant columns side by side', caption: 'Search Console beside Bing, Analytics and AI visits.' }
		],
		sources: [
			{ label: 'GSC Wizard features', url: 'https://www.gscwizard.com/features.html' },
			{ label: 'GSC Wizard pricing', url: 'https://www.gscwizard.com/pricing.html' },
			{ label: 'GSC Wizard llms.txt (what it is not for)', url: 'https://www.gscwizard.com/llms.txt' },
			{ label: 'GSC Wizard indexing docs', url: 'https://www.gscwizard.com/docs/indexing.html' }
		]
	},
	{
		slug: 'seo-stack',
		name: 'SEO Stack',
		url: 'https://www.seo-stack.io/',
		blurb: 'A hosted warehouse for Search Console and GA4 data with AI visibility tracking, an AI assistant, content writing and an MCP server.',
		checkedOn: '2026-11-08',
		price: 'Basic $129.99 a month (10 websites, 5 team members), Pro $349.99 (30 websites, 10 members), Agency $679.99 (200 websites, 15 members); extra websites $10 a month each. 14-day trial, card required.',
		weWin: [
			'Free to self-host, with no limit on websites or team members.',
			'Bing, Clarity and Tag Manager next to Search Console and GA4.',
			'Split and redirect tests with a control group and significance, not only before/after.',
			'An indexing toolkit with IndexNow and Bing submission, and your data on your own server.',
			'A chat that can also act on what it finds (submit URLs, log changes, start tests), with every change waiting for your approval.'
		],
		theyWin: [
			'Deeper AI visibility tracking; SEOConsole’s prompt tracking is basic.',
			'Its AI assistant comes with the plan; SEOConsole’s chat needs your own Anthropic API key, billed to you.',
			'AI content writing, briefs and a site audit: SEOConsole does not write content.',
			'Hosted, with white-label client reports on its Agency plan (its pages are not consistent on this).'
		],
		rows: [
			{ group: 'Data', feature: 'Many sites in one place', ours: y('No limit.'), theirs: y('10, 30 or 200 websites by plan; more at $10 a month each.') },
			{ group: 'Data', feature: 'History beyond Search Console’s 16 months', ours: y('Kept from the first sync.'), theirs: y('60 or 120+ months by plan, from the day you connect.') },
			{ group: 'Data', feature: 'Bing next to Google', ours: y(), theirs: u() },
			{ group: 'Data', feature: 'GA4 next to Search Console', ours: y(), theirs: y() },
			{ group: 'Data', feature: 'Clarity and Tag Manager', ours: y('Including a tracking audit and a one-click Clarity install through Tag Manager.'), theirs: u() },
			{ group: 'Analysis', feature: 'SEO tests with a control group and significance', ours: y('Before/after, split and redirect tests.'), theirs: p('Before/after “AI Experiments” with a written analysis; its pages say a true site-wide A/B test is not possible.') },
			{ group: 'Analysis', feature: 'Decay, cannibalization, striking distance and CTR gaps', ours: y(), theirs: y() },
			{ group: 'Analysis', feature: 'AI-assistant traffic by page', ours: y('From GA4 referrers.'), theirs: y('AI assistants as a GA4 channel.') },
			{ group: 'Indexing', feature: 'Indexing toolkit (IndexNow, Bing, inspection, monitoring)', ours: y('IndexNow, Bing, a Request Indexing list and day 1/3/5 re-checks.'), theirs: p('Page indexing checks at scale; IndexNow is not stated.') },
			{ group: 'Reports', feature: 'Scheduled reports and alerts', ours: y('A weekly digest, a monthly report and urgent alerts to Slack, Discord or a webhook (no email or PDF).'), theirs: p('Weekly or monthly PDF reports by email; Slack is listed as coming soon.') },
			{ group: 'Access', feature: 'MCP server for AI agents', ours: y('Reads by default; acting needs a level you grant.'), theirs: y('On all plans; a REST API is not out yet (its own words).') },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('Hosted, with exports to Sheets, CSV and PDF.') },
			{ group: 'Access', feature: 'Nothing to install or run', ours: n('Self-host only, for now.'), theirs: y('Hosted.') },
			{ group: 'More', feature: 'AI visibility tracking', ours: p('Basic prompt tracking: mentions, citations and share of voice in ChatGPT, Gemini, Claude and Perplexity answers, through your own API keys or DataForSEO.'), theirs: y() },
			{ group: 'More', feature: 'Chat with your data (in-app AI assistant)', ours: y('Claude, with your own Anthropic key, on the same tools as the MCP server; it can act, but every change waits for your approval.'), theirs: y('“Ask your GSC and GA4 data anything”, its platform page says; whether it can act is not stated.') },
			{ group: 'More', feature: 'AI content writing', ours: n('Not built.'), theirs: y('Token and content allowances by plan.') },
			{ group: 'Price and maturity', feature: 'Price', ours: y('Free to self-host.'), theirs: p('From $129.99 a month for 10 websites.') },
			MATURITY(y('Established; it says it is trusted by over 5,000 users (its own claim).'))
		],
		shots: [
			{ src: '/img/compare/tests.jpg', alt: 'A SEOConsole SEO test result with clicks against control pages, a Google update overlap warning and conversions', caption: 'A test result with control pages, the smallest detectable change and conversions.' },
			{ src: '/img/compare/submit.jpg', alt: 'The Submit tab sending URLs to IndexNow and Bing', caption: 'Indexing: IndexNow and Bing submission with re-checks.' }
		],
		sources: [
			{ label: 'SEO Stack pricing', url: 'https://www.seo-stack.io/pricing' },
			{ label: 'SEO Stack vs Google Search Console', url: 'https://www.seo-stack.io/compare/vs-google-search-console' },
			{ label: 'SEO Stack for agencies', url: 'https://www.seo-stack.io/solutions/agencies' },
			{ label: 'SEO Stack AI experiments', url: 'https://www.seo-stack.io/platform/ai-experiments' },
			{ label: 'SEO Stack platform (read 2026-11-09)', url: 'https://www.seo-stack.io/platform' }
		]
	},
	{
		slug: 'seo-gets',
		name: 'SEO Gets',
		url: 'https://seogets.com/',
		blurb: 'Hosted Search Console and GA4 analytics for SEOs: a master dashboard, content groups, opportunity reports, annotations, client portals and an MCP connector.',
		checkedOn: '2026-11-08',
		price: '$49 a month, billed monthly, for the platform and the first core site; each extra core site $4 a month, unlimited from 35 core sites ($185 a month). Super Site add-on $4 a month per core site (5 years of history, index reporting, content change tracking). A yearly option is offered; its terms were not readable on the page. Free sites are always free, no card. Prices shown in $; VAT not stated. Its features page prices the same storage and index reporting at $10 a month per site.',
		weWin: [
			'Free to self-host, with every feature on every site: no per-site price and no paid add-on for history or indexing.',
			'History beyond Search Console’s 16 months for every property, not only sites with a paid add-on.',
			'Bing, Clarity and Tag Manager next to Search Console and GA4.',
			'Split and redirect tests with a control group and a significance figure, not only before/after.',
			'IndexNow, Bing and sitemap submission from the app, a REST API, and basic AI prompt tracking with citation detection.'
		],
		theyWin: [
			'White-labeled live client portals and shareable links, and email notifications; SEOConsole sends to Slack, Discord or a webhook only and has no client portal.',
			'One-click topic clustering and content groups, a Chrome extension for annotations, and automatic content change tracking.',
			'Hosted and established: nothing to run, human onboarding and support, and it says 4,000+ SEO professionals use it (its own claim).'
		],
		rows: [
			{ group: 'Data', feature: 'Many sites and Google accounts in one place', ours: y('No limit; it runs on your own server.'), theirs: y('Unlimited free sites, users and Google accounts per team; the full toolkit is priced per core site.') },
			{ group: 'Data', feature: 'History beyond Search Console’s 16 months', ours: y('Kept for every property from the first sync.'), theirs: p('Up to 5 years with the Super Site add-on on a core site; free and core sites show 16 months.') },
			{ group: 'Data', feature: 'GA4 next to Search Console', ours: y(), theirs: y('On core sites.') },
			{ group: 'Data', feature: 'Bing, Clarity and Tag Manager', ours: y('Including a tracking audit and a one-click Clarity install through Tag Manager.'), theirs: u('Its pages list Search Console and GA4 only.') },
			{ group: 'Analysis', feature: 'Decay, cannibalization, striking distance and CTR gaps', ours: y(), theirs: y('Content decay, cannibalization, striking distance and CTR by position, on core sites.') },
			{ group: 'Analysis', feature: 'Topic clusters and content groups', ours: p('Pages grouped by URL folder and queries clustered by shared words on the Groups tab: transparent word matching, not semantic.'), theirs: y('One-click topic clustering and content groups, showing which are growing or slipping.') },
			{ group: 'Analysis', feature: 'Before/after SEO tests', ours: y('Against control pages, with the noise level measured on your own earlier weeks.'), theirs: y('Before-and-after tests on the changes you log.') },
			{ group: 'Analysis', feature: 'Split and redirect tests with a significance figure', ours: y('Control pages, a 95% range and a p-value.'), theirs: u() },
			{ group: 'Analysis', feature: 'Annotations and change tracking', ours: y('A change log with a before/after readout adjusted for the site’s trend.'), theirs: y('Annotations from any page with a Chrome extension; content, HTTP status and internal-link changes tracked on Super Sites.') },
			{ group: 'Analysis', feature: 'AI prompt tracking with citation detection', ours: y('Basic: runs your prompts through AI APIs with your own API keys on a schedule and records whether your domain is mentioned or cited.'), theirs: n('Its home page says it is not a fit if you want AI “visibility tracking”.') },
			{ group: 'Indexing', feature: 'Indexing monitor', ours: y('Opt-in daily re-inspection of your biggest pages: de-indexed, canonical changed, blocked, fetch errors.'), theirs: y('Up to 5,000 sitemap URLs checked every 2–3 days, with the Super Site add-on.') },
			{ group: 'Indexing', feature: 'Sitemap submission from the app', ours: y('List, submit, resubmit and remove, per site and in bulk.'), theirs: n('Its FAQ says you still rely on Search Console for sitemap submissions.') },
			{ group: 'Indexing', feature: 'Submit URLs to IndexNow and Bing', ours: y(), theirs: u() },
			{ group: 'Reports', feature: 'Scheduled summaries', ours: y('A weekly digest, a monthly report and urgent alerts to Slack, Discord or a webhook.'), theirs: y('Weekly summaries; a weekly indexing report for Super Sites.') },
			{ group: 'Reports', feature: 'Email delivery', ours: n('Webhook only: Slack, Discord or generic JSON.'), theirs: y('Email notification preferences for the weekly indexing report (its changelog, May 15, 2026).') },
			{ group: 'Reports', feature: 'Client portal and shareable links', ours: n('Not built: no client or white-label reports.'), theirs: y('White-labeled live client portals and “magic links” for stakeholders.') },
			{ group: 'Access', feature: 'MCP server for AI agents', ours: y('Reads by default; acting needs a level you grant.'), theirs: y('For core and Super Sites (not free sites): Search Console, GA4 and annotation data, with annotations read and written.') },
			{ group: 'Access', feature: 'REST API', ours: y('Read-only by default, with the same API keys as the MCP server.'), theirs: u() },
			{ group: 'Access', feature: 'More than one user', ours: y('Unlimited users, free, with roles (admin, editor, viewer) and optional per-user site limits.'), theirs: y('Unlimited users per team.') },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('A hosted service (app.seogets.com).') },
			{ group: 'Access', feature: 'Nothing to install or run', ours: n('Self-host only, for now.'), theirs: y('Hosted, with human onboarding and support on core sites.') },
			{ group: 'Price and maturity', feature: 'Price', ours: y('Free to self-host.'), theirs: p('Free sites free; $49 a month for the first core site and $4 for each extra one.') },
			MATURITY(y('Established; it says it is trusted by 4,000+ SEO professionals and names agency, consultant and in-house users (its own claims).'))
		],
		shots: [
			{ src: '/img/compare/tests.jpg', alt: 'A SEOConsole SEO test result with clicks against control pages, a Google update overlap warning and conversions', caption: 'A test result: clicks against control pages, the smallest change the test could detect, and conversions.' },
			{ src: '/img/compare/actions.jpg', alt: 'The Actions page with filters by site, kind and effort', caption: 'A ranked to-do list across every site, free for every site.' }
		],
		sources: [
			{ label: 'SEO Gets home page', url: 'https://seogets.com/' },
			{ label: 'SEO Gets pricing', url: 'https://seogets.com/pricing' },
			{ label: 'SEO Gets features', url: 'https://seogets.com/features' },
			{ label: 'SEO Gets changelog', url: 'https://seogets.com/changelog' }
		]
	},
	{
		slug: 'quickseo',
		name: 'QuickSEO',
		url: 'https://quickseo.ai/',
		blurb: 'A hosted, free Search Console dashboard for all your websites, with opportunities, a weekly technical audit and an MCP server on a paid plan.',
		checkedOn: '2026-11-08',
		price: 'Free ($0 a month) for unlimited websites, no card. Lite $39 a month (USD in its page data), billed monthly, no contract. New customers get a 14-day free trial of Lite; the card is collected at checkout but not charged during the trial. VAT not stated.',
		weWin: [
			'Every feature free when self-hosted, including the index monitor, page groups, alerts and the MCP server that QuickSEO keeps for its paid plan.',
			'History kept beyond Search Console’s 16 months, and GA4, Bing, Clarity and Tag Manager next to Search Console.',
			'SEO tests with a control group and significance, an indexing toolkit that submits to IndexNow and Bing, a REST API, and basic AI prompt tracking with citation detection.',
			'An MCP server that can also act (submit URLs, sitemaps, IndexNow) when you allow it, and reads across all sites.'
		],
		theyWin: [
			'Hosted and free for unlimited websites: nothing to install or run.',
			'A weekly technical SEO audit of every site with a health score and 26 checks, including AI crawler access in robots.txt; SEOConsole checks pages one at a time and has no health score.',
			'A weekly email and alert emails; SEOConsole sends to Slack, Discord or a webhook only.'
		],
		rows: [
			{ group: 'Data', feature: 'Many sites in one place', ours: y('No limit.'), theirs: y('Unlimited websites on the free plan.') },
			{ group: 'Data', feature: 'Several Google accounts together', ours: y(), theirs: u('Not stated; its FAQ speaks of the properties “your Google account” can access.') },
			{ group: 'Data', feature: 'History beyond Search Console’s 16 months', ours: y('Kept for every property from the first sync.'), theirs: u('Not stated; its FAQ says dashboards fetch Search Console data from Google when you open them.') },
			{ group: 'Data', feature: 'GA4, Bing, Clarity and Tag Manager', ours: y(), theirs: u('Its pages list Google Search Console only.') },
			{ group: 'Analysis', feature: 'Opportunities with estimated extra clicks', ours: y('Striking distance and CTR gaps on a CTR curve fitted to your own data, plus quick wins and hidden opportunities.'), theirs: y('Low CTR, striking distance and content decay with an estimated range; top three per site free, all on Lite.') },
			{ group: 'Analysis', feature: 'Growing and decaying keywords and pages', ours: y('Winners and losers tested against noise, and significance-tested decay.'), theirs: y('Against the previous period.') },
			{ group: 'Analysis', feature: 'Branded vs non-branded split', ours: y(), theirs: y() },
			{ group: 'Analysis', feature: 'Google updates with a per-site verdict', ours: y('On the traffic chart, in tests that overlap one, in the action queue and in the digest.'), theirs: y('Shaded on every chart, with a verdict on whether each site moved more than its usual week.') },
			{ group: 'Analysis', feature: 'SEO tests with a control group and significance', ours: y('Before/after, split and redirect tests.'), theirs: p('Before/after measurement on each opportunity you mark done (all of them on Lite); a control group is not stated.') },
			{ group: 'Analysis', feature: 'Site-wide technical SEO audit', ours: p('An on-page check of a page’s title, description and H1 against its queries, plus noindex and canonical; daily robots.txt and sitemap checks. No site-wide health score.'), theirs: y('26 checks every week on a sample of pages, with a health score and issues ranked by severity.') },
			{ group: 'Analysis', feature: 'AI prompt tracking with citation detection', ours: y('Basic: runs your prompts through AI APIs with your own API keys on a schedule and records whether your domain is mentioned or cited.'), theirs: n('Retired on October 9, 2026, per its changelog.') },
			{ group: 'Indexing', feature: 'Indexing monitor', ours: y('Opt-in daily re-inspection of your biggest pages and a watch list.'), theirs: y('On Lite: URL Inspection on a schedule, showing which pages dropped out of the index.') },
			{ group: 'Indexing', feature: 'Submit URLs and sitemaps (IndexNow, Bing, Search Console)', ours: y(), theirs: u() },
			{ group: 'Reports', feature: 'Scheduled summaries and alerts', ours: y('A weekly digest, a monthly report and urgent alerts to Slack, Discord or a webhook.'), theirs: y('A weekly email (free); on Lite, an email when a Google update starts and when clicks fall well below normal.') },
			{ group: 'Reports', feature: 'Email delivery', ours: n('Webhook only: Slack, Discord or generic JSON.'), theirs: y('A weekly email on the free plan.') },
			{ group: 'Access', feature: 'MCP server for AI agents', ours: y('Reads by default; acting needs a level you grant.'), theirs: y('On Lite: read-only tools over OAuth, one website at a time.') },
			{ group: 'Access', feature: 'REST API', ours: y('Read-only by default, with the same API keys as the MCP server.'), theirs: u() },
			{ group: 'Access', feature: 'More than one user', ours: y('Unlimited users, free, with roles and optional per-user site limits.'), theirs: u() },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: n('Hosted; it stores opportunities, index status and encrypted Google tokens, and fetches the rest from Google live.') },
			{ group: 'Access', feature: 'Nothing to install or run', ours: n('Self-host only, for now.'), theirs: y('Hosted.') },
			{ group: 'Price and maturity', feature: 'Free tier', ours: y('Free for good when self-hosted, every feature included.'), theirs: y('Free for unlimited websites, no card; Lite is $39 a month.') },
			MATURITY(p('Running since at least March 2024 by the Hacker News quote it shows, and relaunched as a free Search Console dashboard on October 9, 2026 (its own changelog); it publishes no customer numbers.'))
		],
		shots: [
			{ src: '/img/compare/quickwins.jpg', alt: 'The Quick wins tab listing titles to rewrite with estimated extra clicks', caption: 'Quick wins with an estimate of the extra clicks, for every site and free.' },
			{ src: '/img/compare/pages.jpg', alt: 'The Pages table with Google, Bing, Google Analytics and AI-assistant columns side by side', caption: 'Search Console beside Bing, Analytics and AI visits for the same page.' }
		],
		sources: [
			{ label: 'QuickSEO home page', url: 'https://quickseo.ai/' },
			{ label: 'QuickSEO pricing', url: 'https://quickseo.ai/pricing' },
			{ label: 'QuickSEO MCP server', url: 'https://quickseo.ai/features/mcp' },
			{ label: 'QuickSEO MCP docs', url: 'https://quickseo.ai/docs/mcp' },
			{ label: 'QuickSEO technical SEO audit', url: 'https://quickseo.ai/features/technical-seo-audit' },
			{ label: 'QuickSEO Google update tracker', url: 'https://quickseo.ai/features/google-update-tracker' },
			{ label: 'QuickSEO multi-site dashboard', url: 'https://quickseo.ai/features/multi-site-dashboard' },
			{ label: 'QuickSEO changelog', url: 'https://quickseo.ai/changelog' }
		]
	},
	{
		slug: 'powersearchconsole',
		name: 'PowerSearchConsole',
		url: 'https://powersearchconsole.com/',
		blurb: 'A hosted reporting layer on Search Console: 45+ ready-made reports, a filterable data explorer, email reports and keyword alerts, without storing your data.',
		checkedOn: '2026-11-08',
		price: 'Early-bird prices (“50% discounted”, kept for good): Grow $29 USD a month or $290 a year (3 sites), Power $59 or $590 (10 sites, 3 users), Enterprise $129 or $1,290 (25 sites, 10 users); the struck-through list prices are $59, $119 and $259 a month. Extra users $5 a month. Free forever for one small site (under 50 daily clicks). 30-day free trial, no card. VAT not stated.',
		weWin: [
			'Free to self-host, with no limit on sites or users.',
			'History kept beyond Search Console’s 16 months, and GA4, Bing, Clarity and Tag Manager next to Search Console.',
			'SEO tests with a control group, an indexing toolkit, decay, cannibalization and a ranked to-do list.',
			'An MCP server and a REST API, and basic AI prompt tracking with citation detection.'
		],
		theyWin: [
			'Custom email reports (daily, weekly or monthly, filtered by section) and keyword or page alerts by email; SEOConsole has neither email nor alerts on thresholds you set.',
			'A data explorer with 60+ filters, thresholds and sorting, and saved reports to share.',
			'Hosted, with a demo account to try without signing up, and it does not store your Search Console data.'
		],
		rows: [
			{ group: 'Data', feature: 'Many sites in one place', ours: y('No limit.'), theirs: p('An all-sites dashboard; 3, 10 or 25 websites by plan (more on Enterprise on request), or one small site free.') },
			{ group: 'Data', feature: 'Several Google accounts together', ours: y(), theirs: y('Sites “from different Google accounts all to the same PowerSearchConsole report suite”.') },
			{ group: 'Data', feature: 'History beyond Search Console’s 16 months', ours: y('Kept for every property from the first sync.'), theirs: u('Not stated; it says it queries Search Console live for every report and does not store your data.') },
			{ group: 'Data', feature: 'GA4, Bing, Clarity and Tag Manager', ours: y(), theirs: u('Its pages list Google Search Console only.') },
			{ group: 'Analysis', feature: 'Ready-made reports', ours: y('Trends (winners and losers, new and lost queries, position bands), decay, cannibalization, striking distance and quick wins.'), theirs: y('45+ SEO reports, such as keywords that lost their Top-3 position.') },
			{ group: 'Analysis', feature: 'Filters and a report builder', ours: p('Country, device and branded filters, search and segments; no free-form report builder.'), theirs: y('A data explorer with 60+ filters, thresholds and sorting; reports can be saved and shared with the team.') },
			{ group: 'Analysis', feature: 'Site sections', ours: y('Pages grouped by URL folder on the Groups tab.'), theirs: y('Compare sections, with alerts and email reports for each.') },
			{ group: 'Analysis', feature: 'SEO tests with a control group and significance', ours: y('Before/after, split and redirect tests.'), theirs: n('Its roadmap lists SEO tests under “Later” (its Power plan blurb still mentions “SEO Tests”).') },
			{ group: 'Indexing', feature: 'Indexing monitor and URL submission', ours: y('Daily re-inspection, IndexNow, Bing and sitemap submission, and a Request Indexing list.'), theirs: u() },
			{ group: 'Reports', feature: 'Custom email reports', ours: n('Webhook only (Slack, Discord or generic JSON): no email.'), theirs: y('Daily, weekly or monthly, with filters and report sections, to any team member; 1, 10, 50 or unlimited by plan.') },
			{ group: 'Reports', feature: 'Alerts on a keyword, page or section', ours: p('Urgent alerts for blocking problems and traffic-drop detection; no alerts on a threshold you set for a keyword or page.'), theirs: y('Clicks, position or CTR for the site, a keyword, a page or a group, checked daily and sent by email; not on the free plan.') },
			{ group: 'Reports', feature: 'CSV export', ours: y('Queries and pages.'), theirs: y('Up to 25,000 rows from the data explorer.') },
			{ group: 'Access', feature: 'More than one user', ours: y('Unlimited users, free, with roles and optional per-user site limits.'), theirs: p('3 users on Power, 10 on Enterprise, $5 a month per extra user; site-level access on Enterprise only.') },
			{ group: 'Access', feature: 'MCP server or REST API', ours: y('An MCP server and a read-only-by-default REST API, with the same API keys.'), theirs: u() },
			{ group: 'Access', feature: 'Your data stays on your own server', ours: y('When self-hosted.'), theirs: p('Hosted, but it says it does not store your Search Console data; on-prem hosting on request.') },
			{ group: 'Access', feature: 'Nothing to install or run', ours: n('Self-host only, for now.'), theirs: y('Hosted, with a demo account to try without signing up.') },
			{ group: 'Price and maturity', feature: 'Price', ours: y('Free to self-host.'), theirs: p('From $29 a month for 3 sites (early-bird price); free for one small site.') },
			{ group: 'Price and maturity', feature: 'Free trial', ours: y('Free for good when self-hosted: nothing to trial.'), theirs: y('30 days, no card.') },
			MATURITY(p('New: “We just launched”, and its plans are discounted “as PowerSearchConsole just launched” (its own claims); its pages are written by its founder.'))
		],
		shots: [
			{ src: '/img/compare/pages.jpg', alt: 'The Pages table with Google, Bing, Google Analytics and AI-assistant columns side by side', caption: 'Pages: Search Console beside Bing, GA4 and AI-assistant visits for the same URL.' },
			{ src: '/img/compare/decay.jpg', alt: 'The Decay tab with a choice between the previous period and the same time last year', caption: 'Decay against the previous period, or the same time last year once history is stored.' }
		],
		sources: [
			{ label: 'PowerSearchConsole home page', url: 'https://powersearchconsole.com/' },
			{ label: 'PowerSearchConsole pricing', url: 'https://powersearchconsole.com/pricing/' },
			{ label: 'PowerSearchConsole teams', url: 'https://powersearchconsole.com/features/teams/' },
			{ label: 'PowerSearchConsole SEO alerts', url: 'https://powersearchconsole.com/features/seo-alerts/' },
			{ label: 'PowerSearchConsole export', url: 'https://powersearchconsole.com/features/export-all-data/' },
			{ label: 'PowerSearchConsole data policy', url: 'https://powersearchconsole.com/fineprint/data-policy/' },
			{ label: 'PowerSearchConsole feature roadmap', url: 'https://powersearchconsole.com/about/feature-roadmap/' },
			{ label: 'PowerSearchConsole white label', url: 'https://powersearchconsole.com/work-together/white-label/' }
		]
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
