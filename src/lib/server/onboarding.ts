/**
 * The facts behind the dashboard's "Get started" guide, read from what the app already stores (src/lib/onboarding.ts turns them into
 * steps). Whether the guide is hidden is one setting for the installation, since the owner and admins set it up together.
 */
import { db } from './db';
import { config } from './config';
import { webhook } from './digest';
import { cruxIntegration } from './crux';
import { onboardingProgress, onboardingSteps, type OnboardingFacts } from '../onboarding';

const count = (sql: string, ...a: unknown[]) => (db().prepare(sql).get(...a) as { n: number }).n;
const VISIBLE = "s.hidden = 0 AND s.permission NOT IN ('siteUnverifiedUser','none')";

export function onboardingFacts(): OnboardingFacts {
	const first = db().prepare(`SELECT s.id FROM sites s LEFT JOIN site_daily d ON d.site_id = s.id WHERE ${VISIBLE} GROUP BY s.id ORDER BY COALESCE(SUM(d.clicks), 0) DESC, s.id LIMIT 1`).get() as { id: number } | undefined;
	return {
		demo: config.demo,
		googleConfigured: config.demo || (!!config.googleClientId && !!config.googleClientSecret),
		googleAccounts: count("SELECT COUNT(*) n FROM accounts WHERE status = 'active'"),
		sitesTotal: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE}`),
		sitesSynced: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND s.last_sync_at IS NOT NULL`),
		actionsHandled: count('SELECT COUNT(*) n FROM action_state'),
		sourcesLinked: count("SELECT COUNT(DISTINCT site_id) n FROM site_links WHERE kind IN ('bing','ga4','gtm','clarity','openseo')"),
		cruxConnected: !!cruxIntegration(),
		indexMonitorSites: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND s.index_monitor = 1`),
		brandTermSites: count(`SELECT COUNT(*) n FROM sites s WHERE ${VISIBLE} AND COALESCE(TRIM(s.brand_terms), '') <> ''`),
		digestWebhook: !!webhook().url,
		agentKeys: count('SELECT COUNT(*) n FROM api_keys'),
		teamMembers: count('SELECT COUNT(*) n FROM users WHERE disabled = 0') + count('SELECT COUNT(*) n FROM invites WHERE accepted_at IS NULL AND expires_at > ?', Date.now()),
		firstSiteId: first?.id ?? null
	};
}

const HIDDEN_KEY = 'onboarding_hidden';
export const onboardingHidden = () => (db().prepare('SELECT value FROM kv WHERE key = ?').get(HIDDEN_KEY) as { value: string } | undefined)?.value === '1';
export const setOnboardingHidden = (hidden: boolean) => void db().prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(HIDDEN_KEY, hidden ? '1' : '0');

/** Everything the dashboard needs for the guide. */
export function onboardingFor() {
	const steps = onboardingSteps(onboardingFacts());
	return { steps, progress: onboardingProgress(steps), hidden: onboardingHidden() };
}
