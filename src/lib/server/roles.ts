import { error } from '@sveltejs/kit';

/**
 * Who may do what. One table, applied to every request in src/hooks.server.ts before any form action or endpoint runs, so a page that
 * forgets to check, or a button that is merely hidden, cannot open a hole.
 *
 *  - owner:  whoever knows ADMIN_PASSWORD (or, without a password, this machine). Everything. Not a database row, so it cannot be locked out.
 *  - admin:  everything, including the team, API keys and connections (Google accounts, Bing, GA4, Tag Manager, Clarity, OpenSEO, CrUX).
 *  - editor: uses the app: syncs, marks actions, runs tests and checks, submits URLs and sitemaps. Not connections, keys, the team or site settings.
 *  - viewer: reads every page; every request that changes something is refused.
 */
export const ROLES = ['owner', 'admin', 'editor', 'viewer'] as const;
export type Role = (typeof ROLES)[number];
export type MemberRole = Exclude<Role, 'owner'>;
export const MEMBER_ROLES: MemberRole[] = ['admin', 'editor', 'viewer'];
const RANK: Record<Role, number> = { viewer: 0, editor: 1, admin: 2, owner: 3 };

export const asMemberRole = (v: unknown): MemberRole | null => (v === 'admin' || v === 'editor' || v === 'viewer' ? v : null);
/** Whether someone with role `have` may do what needs `need`. */
export const hasRole = (have: Role | null | undefined, need: Role): boolean => !!have && Object.hasOwn(RANK, have) && RANK[have] >= RANK[need];

export interface CurrentUser {
	/** null for the owner */
	id: number | null;
	email: string | null;
	name: string;
	role: Role;
	/** the sites this person may see; null = all */
	siteIds: number[] | null;
}
export const OWNER: CurrentUser = Object.freeze({ id: null, email: null, name: 'Owner', role: 'owner', siteIds: null }) as CurrentUser;

export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', editor: 'Editor', viewer: 'Viewer' };

/** For use inside an action as a second line of defence; the hook has already applied the same rule. */
export function requireRole(locals: App.Locals, need: Role): CurrentUser {
	const u = locals.user;
	if (!u || !hasRole(u.role, need)) error(403, refusalText(need));
	return u;
}

export const canSeeSite = (u: CurrentUser | null | undefined, siteId: number): boolean => !!u && (u.siteIds === null || u.siteIds.includes(siteId));

export function refusalText(need: Role): string {
	return need === 'editor' ? 'Your role is Viewer: you can look at everything but not change anything. Ask an admin for the Editor role.' : 'Only the owner or an admin can do this (team, API keys, connections and site settings).';
}

/** The route a path belongs to: site ids become [id], SvelteKit's data requests count as their page, trailing slashes go. */
export function routeOf(pathname: string): string {
	let p = pathname.replace(/\/__data\.json$/, '');
	if (p.length > 1) p = p.replace(/\/+$/, '');
	p = p.replace(/^\/sites\/\d+(?=\/|$)/, '/sites/[id]').replace(/^\/invite\/[^/]+$/, '/invite/[token]');
	return p || '/';
}

/** The form action a POST runs, worked out exactly as SvelteKit does (the first query key that starts with "/", else "default"). */
export function actionNameOf(url: URL): string {
	for (const [k] of url.searchParams) if (k.startsWith('/')) return k.slice(1);
	return 'default';
}

const E: Role = 'editor';
const A: Role = 'admin';
/**
 * Every form action in src/routes, by page. tests/team.test.ts reads the route files and fails if an action is missing here, so a new
 * action cannot slip through unclassified; and anything not listed needs admin anyway (fail closed).
 */
export const FORM_ACTIONS: Record<string, Record<string, Role>> = {
	'/': { syncAll: E, hideDuplicates: E, toggleHidden: E, purgeRemoved: A },
	'/accounts': { refresh: E, verifyToken: A, verifyNow: A, relabel: A, remove: A, addSite: A },
	'/agents': { create: A, permission: A, changes: A, remove: A },
	'/connect': { resync: E, bingKey: A, bingRemove: A, ga4Auto: A, gtmAuto: A, clarity: A, manual: A, unlink: A, openseo: A, crux: A, cruxRemove: A, openseoRemove: A },
	'/digest': { generate: E, send: E, check: E },
	'/updates': { import: E, add: E, remove: E },
	'/sitemaps': { resubmitAll: E },
	'/oauth/authorize': { allow: A, deny: A },
	'/team': { invite: A, revoke: A, role: A, disable: A, enable: A, remove: A, sites: A },
	'/sites/[id]': { addNote: E, makeTest: E, deleteNote: E },
	'/sites/[id]/actions': { state: E },
	'/sites/[id]/clarity': { check: E, plan: E, install: A },
	'/sites/[id]/links': { crawl: E, done: E },
	'/sites/[id]/indexing': { sitemapRefresh: E, watchAdd: E, watchRemove: E, toggle: E, check: E },
	'/sites/[id]/indexnow': { createKey: E, regenerate: E, verify: E, verifyAll: E, auto: E, submit: E, presetRecent: E, presetRemoved: E },
	'/sites/[id]/inspect': { submitSelected: E, addToRequests: E, inspect: E, top: E },
	'/sites/[id]/onpage': { top: E, urls: E },
	'/sites/[id]/request': { build: E, requested: E, dismiss: E },
	'/sites/[id]/settings': { save: A, resync: A, removeProperty: A },
	'/sites/[id]/sitemaps': { lastmodCompare: E, check: E, submit: E, delete: E },
	'/sites/[id]/submit': { preset: E, submit: E, sitemapSubmit: E, sitemapResubmit: E, sitemapCheck: E, refreshQuota: E, clearQueue: E, check: E },
	'/sites/[id]/tests': { create: E, remove: E }
};

/** +server endpoints, and the GET endpoints that change something (starting or finishing an account connection). */
export const ENDPOINTS: Record<string, Role> = {
	'POST /logout': 'viewer',
	'POST /sites/[id]/sync': E,
	'GET /auth/connect': A,
	'GET /auth/callback': A,
	'GET /auth/bing/connect': A,
	'GET /auth/bing/callback': A
};

const READS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const isRead = (method: string) => READS.has(method.toUpperCase());

/** The role a request needs. Reads need any signed-in role; a change not listed above needs admin. */
export function requiredRole(method: string, url: URL): Role {
	const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
	const route = routeOf(url.pathname);
	const key = `${m} ${route}`;
	if (Object.hasOwn(ENDPOINTS, key)) return ENDPOINTS[key];
	if (isRead(m)) return 'viewer';
	if (m === 'POST' && Object.hasOwn(FORM_ACTIONS, route)) {
		const actions = FORM_ACTIONS[route];
		const name = actionNameOf(url);
		if (Object.hasOwn(actions, name)) return actions[name];
	}
	return 'admin';
}

/** Pages a person limited to some sites may still open: they show nothing from other sites. Everything else covers every site. */
const SCOPED_READABLE = new Set(['/', '/team', '/updates']);

/**
 * Why a request is refused, or null. `not-found` for a site outside the person's scope (it is not even confirmed to exist),
 * `cross-site` for a page or change that spans every site, `role` when the role is too low.
 */
export function accessRefusal(user: CurrentUser, method: string, url: URL): { kind: 'not-found' | 'cross-site' | 'role'; need?: Role } | null {
	if (user.siteIds) {
		const site = /^\/sites\/(\d+)(?:\/|$)/.exec(url.pathname);
		const route = routeOf(url.pathname);
		if (site) {
			if (!user.siteIds.includes(Number(site[1]))) return { kind: 'not-found' };
		} else if (route !== '/logout' && !(isRead(method) && SCOPED_READABLE.has(route))) return { kind: 'cross-site' };
	}
	const need = requiredRole(method, url);
	return hasRole(user.role, need) ? null : { kind: 'role', need };
}
