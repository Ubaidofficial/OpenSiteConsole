/**
 * The "Set up SEOConsole" guide on the dashboard: the steps that take a new installation from "connected" to "it tells me what to fix",
 * in three phases (connect your data, act on it, let it run by itself). Each step is ticked off from data the app already holds, so
 * nothing is tracked about the person; each says what it unlocks in this installation's own numbers, and where it can, it is done in
 * one click from the guide itself. Pure, unit-tested.
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
	/** open and blocking findings across the sites (null when not worked out, for speed, once the step is done) */
	openActions: number | null;
	blockingActions: number | null;
	/** sites with at least one of Bing, GA4, Tag Manager, Clarity or OpenSEO linked */
	sourcesLinked: number;
	cruxConnected: boolean;
	indexMonitorSites: number;
	brandTermSites: number;
	digestWebhook: boolean;
	agentKeys: number;
	teamMembers: number;
	/** the site the per-site steps act on: the one with the most clicks */
	topSite: { id: number; name: string; brandGuess: string | null } | null;
	/** pages the indexing monitor checks per run (INDEX_MONITOR_URLS) */
	monitorUrls: number;
	/** this server's MCP address, for the agent step */
	mcpUrl: string;
}

export type StepId = 'google' | 'sync' | 'sources' | 'actions' | 'indexing' | 'brand' | 'alerts' | 'agent' | 'team';
export type Phase = 'connect' | 'act' | 'automate';
export const PHASES: { id: Phase; label: string; blurb: string }[] = [
	{ id: 'connect', label: 'Connect', blurb: 'Bring your data in' },
	{ id: 'act', label: 'Act', blurb: 'Fix what matters first' },
	{ id: 'automate', label: 'Automate', blurb: 'Let it watch for you' }
];

/** Something the guide does itself: a form posted to the dashboard, or a value to copy. */
export type InlineAction =
	| { kind: 'form'; action: 'onboardIndexing' | 'onboardBrand'; fields: Record<string, string>; label: string }
	| { kind: 'copy'; value: string; label: string };

export interface OnboardingStep {
	id: StepId;
	phase: Phase;
	title: string;
	/** what doing it gets you, in this installation's own numbers where there are any */
	impact: string;
	done: boolean;
	optional: boolean;
	/** about how long it takes; null for a step that runs by itself */
	minutes: number | null;
	/** a problem to sort out first, shown as "Setup required" */
	blocked: string | null;
	inline: InlineAction | null;
	/** where to go to do it (or to do more than the inline action) */
	href: string | null;
	cta: string;
	/** a short line about where it stands, such as "4 of 6 sites synced" */
	status: string | null;
	/** progress of a step that fills up over time, 0-1 */
	progress: number | null;
	/** what to type to the agent instead; only once an agent is connected, since before that there is nobody to ask */
	agentPrompt: string | null;
}

const plural = (n: number, w: string) => `${n.toLocaleString('en-US')} ${w}${n === 1 ? '' : 's'}`;

export function onboardingSteps(f: OnboardingFacts): OnboardingStep[] {
	const site = (tab: string) => (f.topSite ? `/sites/${f.topSite.id}${tab}` : null);
	const google = f.googleAccounts > 0;
	const agent = f.agentKeys > 0;
	const ask = (prompt: string) => (agent ? prompt : null);
	const top = f.topSite;
	return [
		{
			id: 'google', phase: 'connect', title: 'Connect Search Console', minutes: 2, optional: false, done: google,
			impact: 'Sign in once per Google account: every property it can see is imported, with GA4 and Tag Manager access in the same consent.',
			blocked: google || f.googleConfigured ? null : 'The Google sign-in is not configured on this server yet: add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env and restart. The README’s “Getting credentials” walks through it in about five minutes.',
			inline: null, href: '/accounts', cta: google ? 'Add another account' : 'Connect a Google account',
			status: google ? `${plural(f.googleAccounts, 'account')} connected` : null, progress: null, agentPrompt: null
		},
		{
			id: 'sync', phase: 'connect', title: 'Import your history', minutes: null, optional: false, done: f.sitesTotal > 0 && f.sitesSynced > 0,
			impact: 'Up to 16 months per site, downloaded in the background and kept beyond Google’s limit from now on. Nothing to do but wait a few minutes.',
			blocked: null, inline: null, href: f.sitesTotal ? null : '/accounts', cta: 'Check the connected accounts',
			status: f.sitesTotal ? `${f.sitesSynced} of ${plural(f.sitesTotal, 'site')} synced` : google ? 'No properties found in the connected accounts yet' : 'Starts once Google is connected',
			progress: f.sitesTotal ? f.sitesSynced / f.sitesTotal : null, agentPrompt: null
		},
		{
			id: 'sources', phase: 'connect', title: 'Add Bing, GA4 and more', minutes: 5, optional: false, done: f.sourcesLinked > 0 || f.cruxConnected,
			impact: f.sitesTotal
				? `${f.sitesTotal - f.sourcesLinked > 0 ? `${plural(f.sitesTotal - f.sourcesLinked, 'site')} only ${f.sitesTotal - f.sourcesLinked === 1 ? 'has' : 'have'}` : 'Your sites have'} Search Console data. Each source adds findings it cannot show (conversions, Bing rankings, broken tracking, rage clicks) and is matched to your sites by domain.`
				: 'Each source adds findings Search Console cannot show (conversions, Bing rankings, broken tracking, rage clicks) and is matched to your sites by domain.',
			blocked: null, inline: null, href: '/connect', cta: 'Connect sources',
			status: f.sourcesLinked ? `${plural(f.sourcesLinked, 'site')} with another source` : null, progress: null, agentPrompt: null
		},
		{
			id: 'actions', phase: 'act', title: 'Fix your first to-do', minutes: 5, optional: false, done: f.actionsHandled > 0,
			impact: f.openActions != null && f.openActions > 0
				? `${plural(f.openActions, 'open item')} across your sites${f.blockingActions ? `, ${f.blockingActions} of them blocking` : ''}, ranked by what to fix first. Mark one done (or snooze it) when you have dealt with it.`
				: 'Every finding in one list, ranked by what to fix first. Mark one done (or snooze it) when you have dealt with it.',
			blocked: null, inline: null, href: '/actions', cta: 'Open the to-do list',
			status: f.actionsHandled ? `${plural(f.actionsHandled, 'item')} handled` : null, progress: null, agentPrompt: ask('What should I fix first across my sites?')
		},
		{
			id: 'indexing', phase: 'act', title: 'Watch your indexing', minutes: 1, optional: false, done: f.indexMonitorSites > 0,
			impact: top
				? `Re-inspects up to ${f.monitorUrls} pages of ${top.name} every day and tells you when one drops out of Google, changes canonical or gets blocked. Changes show from the second day.`
				: 'Re-inspects your biggest pages every day and tells you when one drops out of Google, changes canonical or gets blocked.',
			blocked: null,
			inline: top && !f.indexMonitorSites ? { kind: 'form', action: 'onboardIndexing', fields: { siteId: String(top.id) }, label: `Turn on for ${top.name}` } : null,
			href: site('/indexing'), cta: 'Indexing settings',
			status: f.indexMonitorSites ? `On for ${plural(f.indexMonitorSites, 'site')}` : null, progress: null, agentPrompt: ask('Are any of my important pages not indexed?')
		},
		{
			id: 'brand', phase: 'act', title: 'Tell it your brand', minutes: 1, optional: false, done: f.brandTermSites > 0,
			impact: top?.brandGuess
				? `From the domain we guessed “${top.brandGuess}” for ${top.name}. Confirming it keeps branded searches out of quick wins and opportunities, which should be about searches you can still win.`
				: 'Brand terms keep branded searches out of quick wins and opportunities, which should be about searches you can still win.',
			blocked: null,
			inline: top?.brandGuess && !f.brandTermSites ? { kind: 'form', action: 'onboardBrand', fields: { siteId: String(top.id), terms: top.brandGuess }, label: `Use “${top.brandGuess}”` } : null,
			href: site('/settings'), cta: top?.brandGuess ? 'Edit in settings' : 'Set brand terms',
			status: f.brandTermSites ? `Set for ${plural(f.brandTermSites, 'site')}` : null, progress: null, agentPrompt: null
		},
		{
			id: 'alerts', phase: 'automate', title: 'Get alerts in Slack or Discord', minutes: 2, optional: false, done: f.digestWebhook,
			impact: 'A weekly digest, a monthly report, and an alert the moment something blocks a site. Add your webhook address to .env and restart; it is a server setting, so it cannot be set from here.',
			blocked: null, inline: f.digestWebhook ? null : { kind: 'copy', value: 'DIGEST_WEBHOOK_URL=', label: 'Copy the .env line' },
			href: '/digest', cta: 'See the digest', status: f.digestWebhook ? 'Webhook set' : null, progress: null, agentPrompt: null
		},
		{
			id: 'agent', phase: 'automate', title: 'Connect your AI agent', minutes: 2, optional: false, done: agent,
			impact: 'Ask Claude, ChatGPT or Codex about your sites, get the to-do list, submit pages. Read-only unless you allow more, and every change is logged.',
			blocked: null, inline: agent ? null : { kind: 'copy', value: f.mcpUrl, label: 'Copy the MCP address' },
			href: '/agents', cta: 'Setup steps per app', status: agent ? plural(f.agentKeys, 'connection') : null, progress: null, agentPrompt: null
		},
		{
			id: 'team', phase: 'automate', title: 'Invite your team', minutes: 1, optional: true, done: f.teamMembers > 0,
			impact: 'Unlimited people, each an admin, editor or viewer, optionally limited to some sites. An invite is a link you send yourself.',
			blocked: null, inline: null, href: '/team', cta: 'Invite someone',
			status: f.teamMembers ? plural(f.teamMembers, 'member') : null, progress: null, agentPrompt: null
		}
	];
}

/** How far along: required steps only, so an optional one never holds the guide open. */
export function onboardingProgress(steps: OnboardingStep[]) {
	const req = steps.filter((s) => !s.optional);
	const done = req.filter((s) => s.done).length;
	const left = req.filter((s) => !s.done);
	return {
		done, total: req.length, complete: done === req.length,
		next: left[0] ?? steps.find((s) => !s.done) ?? null,
		/** minutes left on the required steps that take any */
		minutesLeft: left.reduce((a, s) => a + (s.minutes ?? 0), 0)
	};
}

/** When everything is done: what is now working, in one line each. */
export function runningSummary(f: OnboardingFacts): string[] {
	const out: string[] = [];
	if (f.sitesTotal) out.push(`${plural(f.sitesTotal, 'site')} syncing`);
	if (f.sourcesLinked) out.push(`${plural(f.sourcesLinked, 'site')} with extra sources`);
	if (f.indexMonitorSites) out.push(`Indexing watched on ${plural(f.indexMonitorSites, 'site')}`);
	if (f.digestWebhook) out.push('Digest and alerts to your webhook');
	if (f.agentKeys) out.push(`${plural(f.agentKeys, 'agent connection')}`);
	if (f.teamMembers) out.push(`${plural(f.teamMembers, 'teammate')}`);
	return out;
}
