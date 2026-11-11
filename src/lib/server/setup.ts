import { db, audit } from './db';
import { config } from './config';
import { getSite } from './clients';
import { linksFor, setLink } from './links';
import { enqueueLinkSync } from './jobs';
import { ga4SourceFor, gtmSourceFor, type Ga4Source } from './channels';
import { ga4Candidates, ga4PropertiesWithUrls, hasGa4Scope, hasGtmScope, pickGtm } from './connect';
import { GA4_TAG_TYPES, isWebContainer, type GtmSource } from './gtm';
import { demoGtmWriter, ga4TagBody, GA4_TAG_NAME, GTM_WRITE_SCOPES, hasGtmWrite, installTagViaWorkspace, realGtmAdmin, realGtmWriter, type GtmAdmin, type GtmWriter } from './gtmwrite';
import { ga4TosUrl, hasGa4Write, realGa4Admin, SCOPE_GA4_EDIT, type Ga4Admin, type Ga4WebStream } from './ga4write';
import { redirectUri } from './google';
import { hostKey, hostsMatch } from './hosts';
import { demoGa4MeasurementId, DEMO_GA4_PROPERTIES, demoSetup } from './demo-channels';
import { storedClarityScan } from './clarityscan';
import { gtmSnippet, type GtmSnippet } from '../gtminstall';

/**
 * "Set up GA4 & Tag Manager": for one site, find (or create) its GA4 property and Tag Manager container, link both, and put
 * the Google tag in the container.
 *
 * It reuses what the Connect page already does: the matching rules (connect.ts), the workspace -> tag -> version -> publish flow
 * (gtmwrite.ts, the same one the Clarity install uses) and the sync queue. It only creates something when nothing matches, and
 * everything it would do is shown first (planSetup changes nothing).
 *
 * The permissions are an opt-in grant (`/auth/connect?grant=setup`), never asked for on a READ_ONLY server.
 *
 * Retrying is safe: the property and the container are linked the moment they are created, so a run that stops half way
 * continues from the same place instead of creating a second one.
 *
 * Tag Manager's API cannot create an account (v2 has accounts.get/list/update only), so someone with none is sent to
 * tagmanager.google.com. GA4 can: accounts.provisionAccountTicket, after the person accepts Google's Terms of Service.
 */
export const SETUP_SCOPES = [SCOPE_GA4_EDIT, ...GTM_WRITE_SCOPES];
export const hasSetupGrant = (a: { scopes: string; is_demo: number }) => !!a.is_demo || SETUP_SCOPES.every((s) => a.scopes.split(/\s+/).includes(s));

export interface SetupChoices {
	/** An existing GA4 property, when several matched ("properties/123"). */
	ga4Property?: string;
	/** The GA4 account to create the property in ("accounts/123"). */
	ga4Account?: string;
	/** An existing container, when several matched: `${googleAccountId}|${path}`. */
	gtmContainer?: string;
	/** The Tag Manager account to create the container in ("accounts/123"). */
	gtmAccount?: string;
	/** IANA name, e.g. Europe/Berlin. Required to create a GA4 property. */
	timeZone?: string;
	/** ISO 4217, e.g. EUR. */
	currencyCode?: string;
}

export interface SetupApi {
	ga4Read(accountId: number): Pick<Ga4Source, 'listProperties' | 'streamUrls'>;
	gtmRead(accountId: number): GtmSource;
	ga4Admin(accountId: number): Ga4Admin;
	gtmAdmin(accountId: number): GtmAdmin;
	writer(accountId: number): GtmWriter;
}

type AccountRow = { id: number; email: string; scopes: string; is_demo: number; google_sub: string };
const accountRow = (id: number) => db().prepare('SELECT id, email, scopes, is_demo, google_sub FROM accounts WHERE id = ?').get(id) as AccountRow | undefined;
const isDemoAccount = (id: number) => !!accountRow(id)?.is_demo;

// ── demo ─────────────────────────────────────────────────────────────────────
let demoN = 0;
function demoGa4Admin(accountId: number): Ga4Admin {
	const sub = accountRow(accountId)?.google_sub ?? 'demo-a';
	return {
		listAccounts: async () => [{ account: 'accounts/9001', displayName: 'Demo Analytics account' }],
		webStreams: async (property) => ['demo-a', 'demo-b'].flatMap((s) => DEMO_GA4_PROPERTIES(s)).filter((p) => p.prop.property === property && p.url).map((p) => ({ measurementId: demoGa4MeasurementId(property), uri: p.url })),
		createProperty: async (_account, p) => {
			const property = `properties/9${100 + ++demoN}`;
			demoSetup.ga4.push({ accountSub: sub, prop: { property, displayName: p.displayName, account: 'Demo Analytics account' }, url: '' });
			return { property, displayName: p.displayName };
		},
		createWebStream: async (property, s) => {
			const hit = demoSetup.ga4.find((x) => x.prop.property === property);
			if (hit) hit.url = s.uri;
			return { stream: `${property}/dataStreams/1`, measurementId: demoGa4MeasurementId(property) };
		},
		provisionTicket: async () => 'demo-ticket'
	};
}
function demoGtmAdmin(): GtmAdmin {
	return {
		listAccounts: async () => [{ path: 'accounts/60000', name: 'Demo Tag Manager account' }],
		createContainer: async (account, c) => {
			const n = ++demoN;
			const created = { path: `${account}/containers/${9000 + n}`, publicId: `GTM-DEMO${String(n).padStart(3, '0')}`, name: c.name, domains: c.domainName, usage: ['web'], accountName: 'Demo Tag Manager account' };
			demoSetup.containers.push(created);
			return { path: created.path, publicId: created.publicId, name: created.name };
		}
	};
}

export const defaultSetupApi: SetupApi = {
	ga4Read: (id) => ga4SourceFor(id),
	gtmRead: (id) => gtmSourceFor(id),
	ga4Admin: (id) => (isDemoAccount(id) ? demoGa4Admin(id) : realGa4Admin(id)),
	gtmAdmin: (id) => (isDemoAccount(id) ? demoGtmAdmin() : realGtmAdmin(id)),
	writer: (id) => (isDemoAccount(id) ? demoGtmWriter() : realGtmWriter(id))
};
export interface SetupOptions { api?: Partial<SetupApi> }
const apiOf = (o: SetupOptions): SetupApi => ({ ...defaultSetupApi, ...o.api });

// ── the plan ─────────────────────────────────────────────────────────────────
export type Ga4Step =
	| { state: 'linked' | 'match'; property: string; label: string; accountId: number; measurementId: string | null }
	/** A linked property with no web stream (an earlier run stopped half way): add the stream. */
	| { state: 'stream'; property: string; label: string; accountId: number; uri: string }
	| { state: 'choose'; candidates: { property: string; label: string }[] }
	| { state: 'create'; accountId: number; accounts: { account: string; displayName: string }[]; account: string | null; displayName: string; uri: string; timeZone: string; currencyCode: string }
	/** No GA4 account at all: the person must accept Google's Terms of Service to get one. */
	| { state: 'tos'; accountId: number }
	| { state: 'blocked'; reason: string };

export type GtmStep =
	| { state: 'linked' | 'match'; accountId: number; container: string; publicId: string; label: string }
	| { state: 'choose'; candidates: { key: string; publicId: string; name: string; account: string }[] }
	| { state: 'create'; accountId: number; accounts: { path: string; name: string }[]; account: string | null; name: string; domain: string }
	/** The API cannot create a Tag Manager account: the person makes one at tagmanager.google.com. */
	| { state: 'no-account'; accountId: number }
	| { state: 'blocked'; reason: string };

export interface TagStep {
	/** present: the live version already has a GA4 / Google tag. add: it will be added. unknown: the container is not chosen yet. */
	state: 'present' | 'add' | 'unknown';
	tagName: string;
	/** The ID the tag will send to; null while the property does not exist yet. */
	measurementId: string | null;
	existing: { name: string; type: string; measurementId: string | null; firing: string[]; paused: boolean }[];
	/** An existing tag sends to a different measurement ID than the property this site is linked to. */
	mismatch?: string;
	newContainer: boolean;
	canPublish: boolean;
	publishBlocked?: string;
}

export interface SetupPlan {
	ok: boolean;
	/** Why nothing can be planned at all (read-only server, unknown site, account gone). */
	error?: string;
	site?: { id: number; name: string; host: string };
	ga4?: Ga4Step;
	gtm?: GtmStep;
	tag?: TagStep;
	/** Google accounts that must first allow SEOConsole to edit (email). */
	needsGrant?: string[];
	/** What still needs a decision or an action from the person. */
	blockers: string[];
	/** Everything is decided and permitted: the confirming button may run. */
	ready: boolean;
}

/** The address as the person thinks of it: example.com for a domain property, the host of a URL-prefix one. */
export function siteHost(siteUrl: string): string {
	if (siteUrl.startsWith('sc-domain:')) return siteUrl.slice('sc-domain:'.length).toLowerCase();
	try {
		return new URL(siteUrl).hostname.toLowerCase();
	} catch {
		return hostKey(siteUrl);
	}
}

const serverTimeZone = () => {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
};
export const validTimeZone = (tz: string) => {
	if (!/^[A-Za-z][A-Za-z0-9_+\-]*(\/[A-Za-z0-9_+\-]+)*$/.test(tz)) return false;
	try {
		new Intl.DateTimeFormat('en', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
};
export const validCurrency = (c: string) => /^[A-Z]{3}$/.test(c);

/** The stream for this site (by host), else the first one. */
function pickStream(streams: Ga4WebStream[], host: string): Ga4WebStream | undefined {
	return streams.find((s) => hostKey(s.uri) === hostKey(host)) ?? streams.find((s) => hostsMatch(s.uri, host)) ?? streams[0];
}

const empty = (): { blockers: string[]; ready: false } => ({ blockers: [], ready: false });

/** What would happen for this site, without changing anything. Reads GA4 and Tag Manager with the read-only access every connection has. */
export async function planSetup(siteId: number, choices: SetupChoices = {}, o: SetupOptions = {}): Promise<SetupPlan> {
	if (config.readOnly) return { ...empty(), ok: false, error: 'This server runs with READ_ONLY=1, so it never changes Google Analytics or Tag Manager.' };
	const site = getSite(siteId);
	if (!site) return { ...empty(), ok: false, error: 'Unknown site.' };
	const acc = accountRow(site.account_id);
	if (!acc) return { ...empty(), ok: false, error: 'The Google account that owns this site is no longer connected.' };
	const api = apiOf(o);
	const host = siteHost(site.site_url);
	const links = linksFor(siteId);

	// ── GA4
	let ga4: Ga4Step;
	if (links.ga4) {
		const accountId = links.ga4.account_id ?? acc.id;
		const streams = await api.ga4Admin(accountId).webStreams(links.ga4.external_id);
		const label = links.ga4.label ?? links.ga4.external_id;
		const s = pickStream(streams, host);
		ga4 = s ? { state: 'linked', property: links.ga4.external_id, label, accountId, measurementId: s.measurementId } : { state: 'stream', property: links.ga4.external_id, label, accountId, uri: `https://${host}` };
	} else if (!hasGa4Scope(acc)) {
		ga4 = { state: 'blocked', reason: `Reconnect ${acc.email} on the Accounts page to grant Google Analytics access.` };
	} else {
		const cands = ga4Candidates(await ga4PropertiesWithUrls(api.ga4Read(acc.id)), site.site_url);
		const chosen = cands.length === 1 ? cands[0] : cands.find((c) => c.property === choices.ga4Property);
		if (chosen) {
			const s = pickStream(await api.ga4Admin(acc.id).webStreams(chosen.property), host);
			ga4 = { state: 'match', property: chosen.property, label: chosen.displayName, accountId: acc.id, measurementId: s?.measurementId ?? null };
		} else if (cands.length > 1) {
			ga4 = { state: 'choose', candidates: cands.map((c) => ({ property: c.property, label: c.displayName })) };
		} else {
			const accounts = await api.ga4Admin(acc.id).listAccounts();
			if (!accounts.length) ga4 = { state: 'tos', accountId: acc.id };
			else {
				const account = accounts.find((a) => a.account === choices.ga4Account)?.account ?? (accounts.length === 1 ? accounts[0].account : null);
				ga4 = { state: 'create', accountId: acc.id, accounts, account, displayName: host, uri: `https://${host}`, timeZone: choices.timeZone || serverTimeZone(), currencyCode: choices.currencyCode || 'USD' };
			}
		}
	}

	// ── Tag Manager
	let gtm: GtmStep;
	if (links.gtm) {
		const accountId = links.gtm.account_id ?? acc.id;
		const label = links.gtm.label ?? links.gtm.external_id;
		gtm = { state: 'linked', accountId, container: links.gtm.external_id, publicId: label.split(' · ')[0] || links.gtm.external_id, label };
	} else {
		const accounts = db().prepare("SELECT id, email, scopes, is_demo, google_sub FROM accounts WHERE status = 'active' ORDER BY id").all() as AccountRow[];
		let hit: { accountId: number; c: { path: string; publicId: string; name: string } } | undefined;
		const cands: { accountId: number; c: { path: string; publicId: string; name: string; accountName: string } }[] = [];
		for (const a of accounts.filter(hasGtmScope)) {
			const containers = (await api.gtmRead(a.id).listContainers()).filter(isWebContainer);
			const r = pickGtm(containers, site.site_url);
			if (r.pick && !hit) hit = { accountId: a.id, c: r.pick };
			for (const c of r.candidates) cands.push({ accountId: a.id, c });
		}
		const keyOf = (accountId: number, path: string) => `${accountId}|${path}`;
		const picked = hit ?? (choices.gtmContainer ? cands.find((x) => keyOf(x.accountId, x.c.path) === choices.gtmContainer) : undefined);
		if (picked) gtm = { state: 'match', accountId: picked.accountId, container: picked.c.path, publicId: picked.c.publicId, label: `${picked.c.publicId} · ${picked.c.name}` };
		else if (cands.length) gtm = { state: 'choose', candidates: cands.map((x) => ({ key: keyOf(x.accountId, x.c.path), publicId: x.c.publicId, name: x.c.name, account: x.c.accountName })) };
		else if (!hasGtmScope(acc)) gtm = { state: 'blocked', reason: `Reconnect ${acc.email} on the Accounts page to grant Tag Manager access.` };
		else {
			const list = await api.gtmAdmin(acc.id).listAccounts();
			if (!list.length) gtm = { state: 'no-account', accountId: acc.id };
			else gtm = { state: 'create', accountId: acc.id, accounts: list, account: list.find((a) => a.path === choices.gtmAccount)?.path ?? (list.length === 1 ? list[0].path : null), name: host, domain: host };
		}
	}

	// ── the tag
	const measurementId = ga4.state === 'linked' || ga4.state === 'match' ? ga4.measurementId : null;
	const base = { tagName: GA4_TAG_NAME, measurementId, existing: [] as TagStep['existing'], newContainer: false, canPublish: false };
	let tag: TagStep;
	if (gtm.state === 'create') tag = { ...base, state: 'add', newContainer: true, canPublish: true };
	else if (gtm.state === 'linked' || gtm.state === 'match') {
		const gacc = accountRow(gtm.accountId);
		const live = await api.gtmRead(gtm.accountId).liveVersion(gtm.container);
		const found = (live?.tags ?? []).filter((t) => GA4_TAG_TYPES.has(t.type)).map((t) => ({ name: t.name, type: t.type, measurementId: t.measurementId, firing: t.firing, paused: t.paused }));
		if (found.length) {
			const ids = found.map((t) => t.measurementId).filter((m): m is string => !!m);
			const mismatch = measurementId && ids.length && !ids.includes(measurementId) ? `The container sends to ${ids.join(', ')}, but this site's GA4 property uses ${measurementId}. SEOConsole does not change existing tags: fix it in Tag Manager.` : undefined;
			tag = { ...base, state: 'present', existing: found, mismatch };
		} else {
			// Publishing is safe only when the newest version is the live one (otherwise someone's unpublished work would go live too).
			let canPublish = false;
			let publishBlocked: string | undefined;
			if (gacc && hasGtmWrite(gacc)) {
				const latest = await api.writer(gtm.accountId).latestVersionId(gtm.container);
				const liveId = live?.versionId ?? null;
				canPublish = !!liveId && latest === liveId;
				if (!canPublish) publishBlocked = !liveId ? 'The container has never been published, so publishing now would put everything in it live for the first time.' : `The container has a newer version (${latest}) than the live one (${liveId}). Publishing would put that version live too, so SEOConsole only prepares the tag for you to publish.`;
			}
			tag = { ...base, state: 'add', canPublish, publishBlocked };
		}
	} else tag = { ...base, state: 'unknown' };

	// ── what is still missing
	const blockers: string[] = [];
	if (ga4.state === 'blocked') blockers.push(ga4.reason);
	if (ga4.state === 'choose') blockers.push('Several GA4 properties match this site: choose which one to use.');
	if (ga4.state === 'create' && !ga4.account) blockers.push('Choose the Google Analytics account to create the property in.');
	if (ga4.state === 'tos') blockers.push('You have no Google Analytics account yet: accept Google’s Terms of Service first.');
	if (ga4.state === 'match' && !ga4.measurementId) blockers.push('Found the GA4 property but could not read its measurement ID. Open the property in Google Analytics and check it has a web data stream.');
	if (gtm.state === 'blocked') blockers.push(gtm.reason);
	if (gtm.state === 'choose') blockers.push('Several Tag Manager containers match this site: choose which one to use.');
	if (gtm.state === 'create' && !gtm.account) blockers.push('Choose the Tag Manager account to create the container in.');
	if (gtm.state === 'no-account') blockers.push('You have no Tag Manager account yet. The Tag Manager API cannot create one: create it at tagmanager.google.com, then try again.');

	const needs = new Set<string>();
	const need = (id: number, ok: (a: AccountRow) => boolean) => {
		const a = accountRow(id);
		if (a && !ok(a)) needs.add(a.email);
	};
	if (ga4.state === 'create' || ga4.state === 'stream' || ga4.state === 'tos') need(ga4.accountId, hasGa4Write);
	if (gtm.state === 'create' || ((gtm.state === 'linked' || gtm.state === 'match') && tag.state === 'add')) need(gtm.accountId, hasGtmWrite);
	const needsGrant = [...needs];

	return { ok: true, site: { id: site.id, name: site.label || host, host }, ga4, gtm, tag, needsGrant: needsGrant.length ? needsGrant : undefined, blockers, ready: !needsGrant.length && !blockers.length };
}

// ── doing it ─────────────────────────────────────────────────────────────────
export interface SetupStepResult { id: 'ga4' | 'gtm' | 'tag'; status: 'done' | 'skipped' | 'failed'; text: string }
export interface SetupResult {
	ok: boolean;
	error?: string;
	steps: SetupStepResult[];
	published: boolean;
	reviewUrl?: string;
	measurementId?: string;
	container?: { publicId: string; name: string; path: string };
	/** The code to put on the site: SEOConsole cannot do that part. */
	snippet?: GtmSnippet | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Make the change shown by planSetup. mode "publish" also publishes the Google tag (only when that is safe, which the plan says);
 * "workspace" leaves it in a new workspace to review in Tag Manager. Stops at the first failure and says what had been done.
 */
export async function runSetup(siteId: number, choices: SetupChoices, mode: 'publish' | 'workspace', o: SetupOptions = {}): Promise<SetupResult> {
	const steps: SetupStepResult[] = [];
	const stop = (error: string): SetupResult => ({ ok: false, error, steps, published: false });
	const plan = await planSetup(siteId, choices, o);
	if (!plan.ok) return stop(plan.error!);
	if (plan.needsGrant) return stop(`SEOConsole may not edit Google Analytics / Tag Manager yet for ${plan.needsGrant.join(', ')}. Allow it first.`);
	if (plan.blockers.length) return stop(plan.blockers[0]);
	const { ga4, gtm, tag } = plan as Required<Pick<SetupPlan, 'ga4' | 'gtm' | 'tag'>>;
	if (mode === 'publish' && tag.state === 'add' && !tag.canPublish) return stop(tag.publishBlocked ?? 'It is not safe to publish this container from here. Choose “review first”.');
	let tz = '';
	let currency = '';
	if (ga4.state === 'create') {
		tz = choices.timeZone || ga4.timeZone;
		currency = (choices.currencyCode || ga4.currencyCode).toUpperCase();
		if (!validTimeZone(tz)) return stop('That is not a time zone Google Analytics accepts. Use a name like Europe/Berlin or America/New_York.');
		if (!validCurrency(currency)) return stop('Enter the currency as a three-letter code, like USD or EUR.');
	}
	const api = apiOf(o);
	const site = getSite(siteId)!;
	const host = plan.site!.host;
	const fail = (id: SetupStepResult['id'], e: unknown, what: string): SetupResult => {
		const m = message(e);
		steps.push({ id, status: 'failed', text: `${what}: ${m}` });
		audit('setup.failed', { siteId, accountId: site.account_id, detail: `${what}: ${m}` });
		return stop(`${what}: ${m}.${steps.some((s) => s.status === 'done') ? ' What was already done is kept: run it again to continue.' : ''}`);
	};

	// 1. Google Analytics 4
	let property = '';
	let measurementId = '';
	try {
		if (ga4.state === 'linked' || ga4.state === 'match') {
			property = ga4.property;
			measurementId = ga4.measurementId!;
			if (ga4.state === 'match') {
				setLink(siteId, 'ga4', { accountId: ga4.accountId, externalId: property, label: ga4.label });
				audit('setup.ga4_linked', { siteId, accountId: ga4.accountId, detail: `${property} (${measurementId}) matched by website address` });
				steps.push({ id: 'ga4', status: 'done', text: `Linked the existing GA4 property “${ga4.label}” (${measurementId}).` });
			} else steps.push({ id: 'ga4', status: 'skipped', text: `Already linked to “${ga4.label}” (${measurementId}).` });
		} else if (ga4.state === 'stream' || ga4.state === 'create') {
			const admin = api.ga4Admin(ga4.accountId);
			let label: string;
			if (ga4.state === 'create') {
				const p = await admin.createProperty(ga4.account!, { displayName: ga4.displayName, timeZone: tz, currencyCode: currency });
				property = p.property;
				label = p.displayName;
				// Linked at once, so a run that stops after this point continues with this property instead of making another.
				setLink(siteId, 'ga4', { accountId: ga4.accountId, externalId: property, label });
				audit('setup.ga4_property_created', { siteId, accountId: ga4.accountId, detail: `${property} “${label}” in ${ga4.account}, ${tz}, ${currency}` });
			} else {
				property = ga4.property;
				label = ga4.label;
			}
			const s = await admin.createWebStream(property, { displayName: host, uri: ga4.uri });
			measurementId = s.measurementId;
			audit('setup.ga4_stream_created', { siteId, accountId: ga4.accountId, detail: `${property}: web stream for ${ga4.uri}, ${measurementId || 'no measurement ID returned'}` });
			if (!measurementId) throw new Error('the web data stream was created but Google did not return its measurement ID (open the property in Google Analytics to read it)');
			steps.push({ id: 'ga4', status: 'done', text: `${ga4.state === 'create' ? `Created the GA4 property “${label}” with` : `Added to “${label}”`} a web data stream for ${ga4.uri} (${measurementId}).` });
		}
	} catch (e) {
		return fail('ga4', e, 'Google Analytics');
	}

	// 2. Tag Manager
	let container = '';
	let publicId = '';
	let containerName = '';
	try {
		if (gtm.state === 'linked' || gtm.state === 'match') {
			container = gtm.container;
			publicId = gtm.publicId;
			containerName = gtm.label;
			if (gtm.state === 'match') {
				setLink(siteId, 'gtm', { accountId: gtm.accountId, externalId: container, label: gtm.label });
				audit('setup.gtm_linked', { siteId, accountId: gtm.accountId, detail: `${gtm.label} matched by domain` });
				steps.push({ id: 'gtm', status: 'done', text: `Linked the existing container ${gtm.label}.` });
			} else steps.push({ id: 'gtm', status: 'skipped', text: `Already linked to ${gtm.label}.` });
		} else if (gtm.state === 'create') {
			const c = await api.gtmAdmin(gtm.accountId).createContainer(gtm.account!, { name: gtm.name, domainName: [gtm.domain] });
			container = c.path;
			publicId = c.publicId;
			containerName = `${c.publicId} · ${c.name}`;
			setLink(siteId, 'gtm', { accountId: gtm.accountId, externalId: container, label: containerName });
			audit('setup.gtm_container_created', { siteId, accountId: gtm.accountId, detail: `${containerName} in ${gtm.account} for ${gtm.domain}` });
			steps.push({ id: 'gtm', status: 'done', text: `Created the web container ${containerName} for ${gtm.domain}.` });
		}
	} catch (e) {
		return fail('gtm', e, 'Tag Manager');
	}
	const gtmAccountId = (gtm.state === 'linked' || gtm.state === 'match' || gtm.state === 'create') ? gtm.accountId : site.account_id;

	// 3. the Google tag
	let published = false;
	let reviewUrl: string | undefined;
	if (tag.state === 'present') {
		steps.push({ id: 'tag', status: 'skipped', text: `The live container already has ${tag.existing.map((t) => `“${t.name}”`).join(', ')}, so no tag was added.${tag.mismatch ? ` ${tag.mismatch}` : ''}` });
	} else {
		const demo = isDemoAccount(gtmAccountId);
		const r = await installTagViaWorkspace(
			api.writer(gtmAccountId),
			{
				siteId,
				accountId: gtmAccountId,
				isDemo: demo,
				container,
				publicId,
				tag: ga4TagBody(measurementId),
				audit: 'setup.tag',
				workspaceName: `SEOConsole: Google tag ${new Date().toISOString().slice(0, 10)}`,
				workspaceDescription: `Adds the Google tag for ${measurementId} on all pages. Created from SEOConsole.`,
				versionName: 'Add Google tag (SEOConsole)',
				versionNotes: `Google tag for GA4 ${measurementId} on all pages.`,
				what: `GA4 ${measurementId}`,
				onTag: () => {
					if (demo) demoSetup.ga4Tags.set(container, measurementId);
				}
			},
			mode
		);
		reviewUrl = r.reviewUrl;
		if (!r.ok) {
			steps.push({ id: 'tag', status: 'failed', text: r.error ?? 'Tag Manager refused the change.' });
			return { ok: false, error: `${r.error} What was already done is kept: run it again to continue.`, steps, published: false, reviewUrl, measurementId, container: { publicId, name: containerName, path: container }, snippet: gtmSnippet(publicId) };
		}
		published = r.published;
		steps.push({ id: 'tag', status: 'done', text: published ? `Added the Google tag (${measurementId}) on All Pages and published it${r.versionId ? ` as version ${r.versionId}` : ''}.` : `Added the Google tag (${measurementId}) on All Pages in a new workspace. Review it in Tag Manager and press Submit to publish.` });
	}

	// 4. read both back
	enqueueLinkSync(siteId, 'ga4');
	enqueueLinkSync(siteId, 'gtm');
	audit('setup.completed', { siteId, accountId: site.account_id, detail: `${property} / ${publicId} / ${measurementId}: ${steps.map((s) => `${s.id} ${s.status}`).join(', ')}` });
	return { ok: true, steps, published, reviewUrl, measurementId, container: { publicId, name: containerName, path: container }, snippet: gtmSnippet(publicId) };
}

// ── no GA4 account yet ───────────────────────────────────────────────────────
/**
 * Start creating a GA4 account for someone who has none: Google issues a ticket, and the person accepts the Terms of Service
 * in the browser at the returned link. The address it sends them back to must be registered in the Google Cloud OAuth client;
 * SEOConsole uses its own sign-in return address, which already is.
 */
export async function startGa4Account(siteId: number, o: SetupOptions = {}): Promise<{ ok: boolean; error?: string; url?: string }> {
	const plan = await planSetup(siteId, {}, o);
	if (!plan.ok) return { ok: false, error: plan.error };
	if (plan.ga4?.state !== 'tos') return { ok: false, error: 'This Google account already has a Google Analytics account.' };
	if (plan.needsGrant) return { ok: false, error: `SEOConsole may not edit Google Analytics yet for ${plan.needsGrant.join(', ')}. Allow it first.` };
	try {
		const ticket = await apiOf(o).ga4Admin(plan.ga4.accountId).provisionTicket(plan.site!.host, redirectUri());
		audit('setup.ga4_account_started', { siteId, accountId: plan.ga4.accountId, detail: `ticket issued; waiting for the Terms of Service` });
		return { ok: true, url: ga4TosUrl(ticket) };
	} catch (e) {
		const m = message(e);
		audit('setup.failed', { siteId, accountId: plan.ga4.accountId, detail: `Google Analytics account: ${m}` });
		return { ok: false, error: `Google Analytics said: ${m}` };
	}
}

// ── is the container on the site? ────────────────────────────────────────────
/**
 * Whether the pages SEOConsole last fetched load this container. The same page check the Clarity tab runs (home page and the
 * two biggest pages; a script that JavaScript adds later is invisible to it). null = never checked.
 */
export function gtmOnSite(siteId: number, publicId: string): { checkedAt: number; seen: boolean; pagesRead: number } | null {
	const scan = storedClarityScan(siteId);
	if (!scan) return null;
	const read = scan.pages.filter((p) => p.ok);
	return { checkedAt: scan.checkedAt, seen: read.some((p) => p.gtmIds.map((g) => g.toUpperCase()).includes(publicId.toUpperCase())), pagesRead: read.length };
}
