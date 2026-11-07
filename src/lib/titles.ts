import { SITE_TABS } from './explain';

const APP = 'SEOConsole';
const TOP: Record<string, string> = {
	'/': 'Dashboard', '/actions': 'What to do first', '/digest': 'Weekly digest', '/portfolio': 'Portfolio', '/sitemaps': 'Sitemaps', '/connect': 'Connect',
	'/agents': 'Agents and MCP', '/accounts': 'Accounts', '/updates': 'Google updates', '/login': 'Sign in', '/privacy': 'Privacy policy', '/terms': 'Terms of service', '/compare': 'Compare'
};

/**
 * The browser-tab title for a path, e.g. "Queries · SEOConsole". Site names are left out on purpose: privacy mode can blur the page
 * but not the tab strip, the history list or a bookmark.
 */
export function pageTitle(pathname: string): string {
	const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
	if (/^\/compare\/[a-z0-9-]+$/.test(path)) return `Compare · ${APP}`;
	const site = /^\/sites\/\d+(\/[a-z0-9-]+)?$/.exec(path);
	const name = site ? (SITE_TABS.find(([t]) => t === (site[1] ?? ''))?.[1] ?? null) : (TOP[path] ?? null);
	return name ? `${name} · ${APP}` : APP;
}
