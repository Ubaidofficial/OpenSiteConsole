/**
 * The "Get started" guide on the dashboard: the few steps that take a new installation from "connected" to "useful", in the order that
 * pays off first. Each step is ticked off from data the app already holds, so nothing is tracked about the person. Pure, unit-tested.
 */

export interface OnboardingFacts {
	demo: boolean;
	/** GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set (or demo mode, which needs neither) */
	googleConfigured: boolean;
	googleAccounts: number;
	sitesTotal: number;
	sitesSynced: number;
	/** findings marked done or snoozed, on any site */
	actionsHandled: number;
	/** sites with at least one of Bing, GA4, Tag Manager, Clarity or OpenSEO linked, plus the Core Web Vitals key */
	sourcesLinked: number;
	cruxConnected: boolean;
	indexMonitorSites: number;
	brandTermSites: number;
	digestWebhook: boolean;
	agentKeys: number;
	teamMembers: number;
	/** the site the per-site steps open on: the one with the most clicks */
	firstSiteId: number | null;
}

export type StepId = 'google' | 'sync' | 'actions' | 'sources' | 'indexing' | 'brand' | 'alerts' | 'agent' | 'team';
export interface OnboardingStep {
	id: StepId;
	title: string;
	/** one line under the title */
	blurb: string;
	done: boolean;
	optional: boolean;
	/** a problem to sort out before the step can be done, shown as "Setup required" */
	blocked: string | null;
	/** where the step is done, and the button's words */
	href: string | null;
	cta: string;
	/** a short status line, such as "4 of 6 sites synced" */
	status: string | null;
	/** what the person can type to their agent instead, once one is connected */
	agentPrompt: string | null;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function onboardingSteps(f: OnboardingFacts): OnboardingStep[] {
	const site = (tab: string) => (f.firstSiteId ? `/sites/${f.firstSiteId}${tab}` : null);
	const google = f.googleAccounts > 0;
	const steps: OnboardingStep[] = [
		{
			id: 'google', title: 'Connect Google Search Console', blurb: 'Sign in with Google once per account: every property it can see is imported, with GA4 and Tag Manager access in the same step.',
			done: google, optional: false,
			blocked: google || f.googleConfigured ? null : 'Google OAuth client not configured: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart (README, "Getting credentials").',
			href: '/accounts', cta: 'Connect a Google account', status: google ? plural(f.googleAccounts, 'account') : null, agentPrompt: null
		},
		{
			id: 'sync', title: 'Import your history', blurb: 'The first sync downloads up to 16 months per site and keeps it beyond that from then on. It runs by itself; large sites take a few minutes.',
			done: f.sitesTotal > 0 && f.sitesSynced > 0, optional: false, blocked: null,
			href: '/', cta: 'See the dashboard', status: f.sitesTotal ? `${f.sitesSynced} of ${plural(f.sitesTotal, 'site')} synced` : google ? 'No properties found in the connected accounts yet' : null, agentPrompt: null
		},
		{
			id: 'actions', title: 'Work through your to-do list', blurb: 'Every finding, ranked by what to fix first. Mark one done or snooze it to see how the list works.',
			done: f.actionsHandled > 0, optional: false, blocked: null,
			href: '/actions', cta: 'Open the to-do list', status: f.actionsHandled ? `${plural(f.actionsHandled, 'item')} handled` : null, agentPrompt: 'What should I fix first across my sites?'
		},
		{
			id: 'sources', title: 'Connect Bing, GA4, Tag Manager and Clarity', blurb: 'Each source adds findings Search Console alone cannot show: conversions, Bing rankings, tracking problems, rage clicks. Every one is optional.',
			done: f.sourcesLinked > 0 || f.cruxConnected, optional: false, blocked: null,
			href: '/connect', cta: 'Connect sources', status: f.sourcesLinked ? `${plural(f.sourcesLinked, 'site')} with another source` : null, agentPrompt: null
		},
		{
			id: 'indexing', title: 'Watch your indexing', blurb: 'Re-inspects your biggest pages every day and tells you when one drops out of Google, changes canonical or gets blocked.',
			done: f.indexMonitorSites > 0, optional: false, blocked: null,
			href: site('/indexing'), cta: 'Turn on the monitor', status: f.indexMonitorSites ? `On for ${plural(f.indexMonitorSites, 'site')}` : null, agentPrompt: 'Are any of my important pages not indexed?'
		},
		{
			id: 'brand', title: 'Tell it your brand', blurb: 'Brand terms split branded from non-branded searches, so quick wins and opportunities are about searches you can still win.',
			done: f.brandTermSites > 0, optional: false, blocked: null,
			href: site('/settings'), cta: 'Set brand terms', status: f.brandTermSites ? `Set for ${plural(f.brandTermSites, 'site')}` : null, agentPrompt: null
		},
		{
			id: 'alerts', title: 'Get the weekly digest and urgent alerts', blurb: 'A weekly summary, a monthly report and an alert the moment something blocks a site, sent to Slack, Discord or any webhook.',
			done: f.digestWebhook, optional: false, blocked: null,
			href: '/digest', cta: 'See the digest', status: f.digestWebhook ? 'Webhook set' : 'Set DIGEST_WEBHOOK_URL in .env and restart', agentPrompt: null
		},
		{
			id: 'agent', title: 'Connect your AI agent', blurb: 'Use your data from Claude, ChatGPT or Codex: ask questions, get the to-do list, submit pages. Read-only unless you allow more.',
			done: f.agentKeys > 0, optional: false, blocked: null,
			href: '/mcp', cta: 'Set up the agent', status: f.agentKeys ? `${plural(f.agentKeys, 'key')} or sign-in${f.agentKeys === 1 ? '' : 's'}` : null, agentPrompt: null
		},
		{
			id: 'team', title: 'Invite your team', blurb: 'Unlimited people, each an admin, editor or viewer, optionally limited to some sites.',
			done: f.teamMembers > 0, optional: true, blocked: null,
			href: '/team', cta: 'Invite someone', status: f.teamMembers ? plural(f.teamMembers, 'member') : null, agentPrompt: null
		}
	];
	return steps;
}

/** How far along: required steps only, so an optional one never holds the guide open. */
export function onboardingProgress(steps: OnboardingStep[]) {
	const req = steps.filter((s) => !s.optional);
	const done = req.filter((s) => s.done).length;
	return { done, total: req.length, complete: done === req.length, next: steps.find((s) => !s.done && !s.optional) ?? steps.find((s) => !s.done) ?? null };
}
