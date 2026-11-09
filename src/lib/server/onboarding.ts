/**
 * The facts behind the dashboard's setup guide, read from what the app already stores (src/lib/onboarding.ts turns them into steps).
 * Whether the guide is hidden is one setting for the installation, since the owner and admins set it up together.
 */
import { db } from './db';
import { config } from './config';
import { webhook } from './digest';
import { cruxIntegration } from './crux';
import { displayName, getSite } from './clients';
import { brandTerms } from './queries';
import { queueFor } from './actions';
import { onboardingProgress, onboardingSteps, runningSummary, type OnboardingFacts } from '../onboarding';

const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const VISIBLE = "s.hidden = 0 AND s.permission NOT IN ('siteUnverifiedUser','none')";
/** The to-do counts read each site's cached queue; past this many sites the guide says less rather than slow the dashboard. */
const QUEUE_SITES = 15;

export function onboardingFacts(): OnboardingFacts {
	const ids = (db().prepare(`SELECT s.id FROM sites s LEFT JOIN site_daily d ON d.site_id = s.id WHERE ${VISIBLE} GROUP BY s.id ORDER BY COALESCE(SUM(d.clicks), 0) DESC, s.id`).all() as { id: number }[]).map((r) => r.id);
	const top = ids.length ? getSite(ids[0]) : undefined;
	const actionsHandled = count('SELECT COUNT(*) n FROM action_state');
	const synced = count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND s.last_sync_at IS NOT NULL`);
	// Only while the step is open and there is data: the numbers are there to get someone started.
	let openActions: number | null = null, blockingActions: number | null = null;
	if (!actionsHandled && synced && ids.length <= QUEUE_SITES) {
		openActions = 0;
		blockingActions = 0;
		for (const id of ids) {
			try {
				const q = queueFor(getSite(id)!);
				openActions += q.open.length;
				blockingActions += q.open.filter((a) => a.blocking).length;
			} catch {
				/* a site that cannot be read is left out */
			}
		}
	}
	return {
		demo: config.demo,
		googleConfigured: config.demo || (!!config.googleClientId && !!config.googleClientSecret),
		googleAccounts: count("SELECT COUNT(*) n FROM accounts WHERE status = 'active'"),
		sitesTotal: ids.length,
		sitesSynced: synced,
		actionsHandled,
		openActions,
		blockingActions,
		sourcesLinked: count("SELECT COUNT(DISTINCT site_id) n FROM site_links WHERE kind IN ('bing','ga4','gtm','clarity','openseo')"),
		cruxConnected: !!cruxIntegration(),
		indexMonitorSites: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND s.index_monitor = 1`),
		brandTermSites: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND COALESCE(TRIM(s.brand_terms), '') <> ''`),
		digestWebhook: !!webhook().url,
		agentKeys: count('SELECT COUNT(*) n FROM api_keys'),
		teamMembers: count('SELECT COUNT(*) n FROM users WHERE disabled = 0') + count('SELECT COUNT(*) n FROM invites WHERE accepted_at IS NULL AND expires_at > ?', Date.now()),
		// brandTerms() falls back to a guess from the domain when none are set: that guess is what the guide offers to confirm.
		topSite: top ? { id: top.id, name: displayName(top.site_url).replace(/ \(URL prefix\)$/, ''), brandGuess: top.brand_terms.trim() ? null : (brandTerms(top)[0] ?? null) } : null,
		monitorUrls: config.indexMonitorUrls,
		mcpUrl: `${config.origin}/api/mcp`
	};
}

const HIDDEN_KEY = 'onboarding_hidden';
export const onboardingHidden = () => (db().prepare('SELECT value FROM kv WHERE key = ?').get(HIDDEN_KEY) as { value: string } | undefined)?.value === '1';
export const setOnboardingHidden = (hidden: boolean) => void db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(HIDDEN_KEY, hidden ? '1' : '0');

/** Everything the dashboard needs for the guide. */
export function onboardingFor() {
	const facts = onboardingFacts();
	const steps = onboardingSteps(facts);
	return { steps, progress: onboardingProgress(steps), running: runningSummary(facts), hidden: onboardingHidden() };
}
