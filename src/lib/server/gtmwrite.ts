import { GoogleApiError, googleJson, accessToken, type HttpOptions } from './google';
import { db, audit } from './db';
import { config } from './config';
import { linksFor } from './links';
import { gtmSourceFor } from './channels';
import { claritySnippet, parseClarityId } from '../clarityinstall';
import { demoInstalled } from './demo-channels';

/**
 * Adding Microsoft Clarity to a site through its Tag Manager container: the one place SEOConsole writes to Tag Manager.
 *
 * The permission is separate and opt-in: the normal Google sign-in asks for read-only Tag Manager access, and these three
 * scopes are requested only when the owner clicks "Allow SEOConsole to edit Tag Manager" (never with READ_ONLY=1).
 *
 * Safety: the tag goes into a NEW workspace, so nobody's unfinished work is touched, and SEOConsole publishes only when the
 * container's newest version is the live one (otherwise publishing would also push someone else's unpublished version).
 * Every change is shown first and needs a confirming click.
 *
 * The Tag Manager API v2 calls below (workspaces.create, tags.create, workspaces.create_version, versions.publish,
 * version_headers.latest) and the built-in All Pages trigger ID are from my knowledge of the API and were NOT checked against a
 * live account here; check the first real install in Tag Manager.
 */
const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';
export const SCOPE_GTM_EDIT = 'https://www.googleapis.com/auth/tagmanager.edit.containers';
export const SCOPE_GTM_VERSIONS = 'https://www.googleapis.com/auth/tagmanager.edit.containerversions';
export const SCOPE_GTM_PUBLISH = 'https://www.googleapis.com/auth/tagmanager.publish';
export const GTM_WRITE_SCOPES = [SCOPE_GTM_EDIT, SCOPE_GTM_VERSIONS, SCOPE_GTM_PUBLISH];
/** Tag Manager's built-in "All Pages" trigger. */
export const ALL_PAGES_TRIGGER = '2147479553';
export const TAG_NAME = 'Microsoft Clarity (added by SEOConsole)';

export const hasGtmWrite = (a: { scopes: string; is_demo: number }) => !!a.is_demo || GTM_WRITE_SCOPES.every((s) => a.scopes.split(/\s+/).includes(s));

export interface GtmWriter {
	/** The newest container version's ID, live or not; null if there is none. */
	latestVersionId(container: string): Promise<string | null>;
	createWorkspace(container: string, name: string, description: string): Promise<{ path: string; workspaceId: string }>;
	createTag(workspace: string, tag: object): Promise<{ tagId: string }>;
	createVersion(workspace: string, name: string, notes: string): Promise<{ path: string; versionId: string; compilerError: boolean }>;
	publish(version: string): Promise<{ versionId: string; compilerError: boolean }>;
}

export function realGtmWriter(accountId: number, http: HttpOptions = {}): GtmWriter {
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	const post = <T>(url: string, body: object) => call<T>(url, { method: 'POST', body: JSON.stringify(body) });
	return {
		async latestVersionId(container) {
			try {
				return (await call<{ containerVersionId?: string }>(`${BASE}/${container}/version_headers:latest`)).containerVersionId ?? null;
			} catch (e) {
				if (e instanceof GoogleApiError && e.status === 404) return null;
				throw e;
			}
		},
		async createWorkspace(container, name, description) {
			const w = await post<{ path?: string; workspaceId?: string }>(`${BASE}/${container}/workspaces`, { name, description });
			if (!w.path) throw new Error('Tag Manager did not return the new workspace.');
			return { path: w.path, workspaceId: w.workspaceId ?? w.path.split('/').pop()! };
		},
		async createTag(workspace, tag) {
			const t = await post<{ tagId?: string }>(`${BASE}/${workspace}/tags`, tag);
			return { tagId: t.tagId ?? '' };
		},
		async createVersion(workspace, name, notes) {
			const r = await post<{ compilerError?: boolean; containerVersion?: { path?: string; containerVersionId?: string } }>(`${BASE}/${workspace}:create_version`, { name, notes });
			return { path: r.containerVersion?.path ?? '', versionId: r.containerVersion?.containerVersionId ?? '', compilerError: !!r.compilerError };
		},
		async publish(version) {
			const r = await post<{ compilerError?: boolean; containerVersion?: { containerVersionId?: string } }>(`${BASE}/${version}:publish`, {});
			return { versionId: r.containerVersion?.containerVersionId ?? '', compilerError: !!r.compilerError };
		}
	};
}

/** Demo: pretends to succeed; demoInstalled remembers the tag, so the demo container shows it afterwards. */
function demoGtmWriter(): GtmWriter {
	let n = 0;
	return {
		latestVersionId: async () => '12',
		createWorkspace: async (c) => ({ path: `${c}/workspaces/${90 + ++n}`, workspaceId: String(90 + n) }),
		createTag: async () => ({ tagId: '99' }),
		createVersion: async (w) => ({ path: w.replace(/workspaces\/\d+$/, 'versions/13'), versionId: '13', compilerError: false }),
		publish: async () => ({ versionId: '13', compilerError: false })
	};
}

/** The Custom HTML tag Tag Manager stores: Clarity's own snippet, firing on All Pages. */
export function clarityTagBody(projectId: string) {
	return {
		name: TAG_NAME,
		type: 'html',
		parameter: [
			{ type: 'template', key: 'html', value: claritySnippet(projectId) },
			{ type: 'boolean', key: 'supportDocumentWrite', value: 'false' }
		],
		firingTriggerId: [ALL_PAGES_TRIGGER],
		tagFiringOption: 'oncePerEvent',
		notes: 'Added from SEOConsole so Microsoft Clarity records visits. Safe to edit or delete here.'
	};
}

export interface InstallPlan {
	ok: boolean;
	/** Why it cannot go ahead (no container, no permission, read-only server, bad ID). */
	error?: string;
	/** The owner must first allow SEOConsole to edit Tag Manager. */
	needsGrant?: boolean;
	projectId?: string;
	container?: { path: string; publicId: string; name: string };
	/** Clarity tags already in the live version. */
	existing?: { name: string; clarityId: string | null; firing: string[]; paused: boolean }[];
	/** Publishing is safe only when the newest version is the live one. */
	canPublish?: boolean;
	publishBlocked?: string;
	tagName?: string;
	snippet?: string;
}

function context(siteId: number) {
	const link = linksFor(siteId).gtm;
	if (!link?.account_id) return { error: 'Link a Tag Manager container to this site first (Connect page).' } as const;
	const acc = db().prepare('SELECT id, scopes, is_demo FROM accounts WHERE id = ?').get(link.account_id) as { id: number; scopes: string; is_demo: number } | undefined;
	if (!acc) return { error: 'The Google account that owns the container is no longer connected.' } as const;
	return { link, acc } as const;
}

/** What would change, without changing anything. */
export async function planClarityInstall(siteId: number, input: string, o: { writer?: GtmWriter } = {}): Promise<InstallPlan> {
	if (config.readOnly) return { ok: false, error: 'This server runs with READ_ONLY=1, so it never changes Tag Manager.' };
	const projectId = parseClarityId(input);
	if (!projectId) return { ok: false, error: 'Paste your Clarity project ID (like abc123xyz9) or the whole tracking code from Clarity.' };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error, projectId };
	if (!hasGtmWrite(ctx.acc)) return { ok: false, needsGrant: true, projectId, error: 'SEOConsole can read this container but not edit it yet.' };
	const src = gtmSourceFor(ctx.acc.id);
	const [containers, live] = await Promise.all([src.listContainers(), src.liveVersion(ctx.link.external_id)]);
	const c = containers.find((x) => x.path === ctx.link.external_id);
	const writer = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	const latest = await writer.latestVersionId(ctx.link.external_id);
	const liveId = live?.versionId ?? null;
	const canPublish = !!liveId && latest === liveId;
	const existing = (live?.tags ?? []).filter((t) => t.clarity).map((t) => ({ name: t.name, clarityId: t.clarityId ?? null, firing: t.firing, paused: t.paused }));
	return {
		ok: true,
		projectId,
		container: { path: ctx.link.external_id, publicId: c?.publicId ?? ctx.link.label ?? ctx.link.external_id, name: c?.name ?? '' },
		existing,
		canPublish,
		publishBlocked: canPublish ? undefined : !liveId ? 'The container has never been published, so publishing now would put everything in it live for the first time.' : `The container has a newer version (${latest}) than the live one (${liveId}). Publishing would put that version live too, so SEOConsole only prepares the tag for you to publish.`,
		tagName: TAG_NAME,
		snippet: claritySnippet(projectId)
	};
}

export interface InstallResult {
	ok: boolean;
	error?: string;
	published: boolean;
	/** Where to review the change in Tag Manager. */
	reviewUrl?: string;
	versionId?: string;
}

/** Make the change shown by planClarityInstall: a new workspace with the Clarity tag, then (if safe and asked) a version and publish. */
export async function installClarityViaGtm(siteId: number, input: string, mode: 'publish' | 'workspace', o: { writer?: GtmWriter } = {}): Promise<InstallResult> {
	const plan = await planClarityInstall(siteId, input, o);
	if (!plan.ok) return { ok: false, error: plan.error, published: false };
	if (mode === 'publish' && !plan.canPublish) return { ok: false, error: plan.publishBlocked, published: false };
	const ctx = context(siteId);
	if ('error' in ctx) return { ok: false, error: ctx.error, published: false };
	const writer = o.writer ?? (ctx.acc.is_demo ? demoGtmWriter() : realGtmWriter(ctx.acc.id));
	const container = plan.container!.path;
	const [, accountNum, , containerNum] = container.split('/');
	const ui = (ws: string) => `https://tagmanager.google.com/#/container/accounts/${accountNum}/containers/${containerNum}/workspaces/${ws}`;
	try {
		const ws = await writer.createWorkspace(container, `SEOConsole: Microsoft Clarity ${new Date().toISOString().slice(0, 10)}`, `Adds Microsoft Clarity (project ${plan.projectId}) on all pages. Created from SEOConsole.`);
		await writer.createTag(ws.path, clarityTagBody(plan.projectId!));
		if (ctx.acc.is_demo) demoInstalled.set(container, plan.projectId!);
		if (mode === 'workspace') {
			audit('gtm.clarity_prepared', { siteId, accountId: ctx.acc.id, detail: `${plan.container!.publicId}: tag in workspace ${ws.workspaceId}, not published` });
			return { ok: true, published: false, reviewUrl: ui(ws.workspaceId) };
		}
		const v = await writer.createVersion(ws.path, `Add Microsoft Clarity (SEOConsole)`, `Microsoft Clarity project ${plan.projectId} on all pages.`);
		if (v.compilerError || !v.path) return { ok: false, error: 'Tag Manager could not build a version from the workspace. The tag is there: open the workspace in Tag Manager to see why.', published: false, reviewUrl: ui(ws.workspaceId) };
		const p = await writer.publish(v.path);
		if (p.compilerError) return { ok: false, error: 'Tag Manager refused to publish the version. Open it in Tag Manager to see why.', published: false };
		audit('gtm.clarity_published', { siteId, accountId: ctx.acc.id, detail: `${plan.container!.publicId}: version ${p.versionId || v.versionId} published with Clarity ${plan.projectId}` });
		return { ok: true, published: true, versionId: p.versionId || v.versionId, reviewUrl: `https://tagmanager.google.com/#/versions/accounts/${accountNum}/containers/${containerNum}` };
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		audit('gtm.clarity_failed', { siteId, accountId: ctx.acc.id, detail: msg });
		// Standard containers allow three workspaces; this is the most likely refusal.
		const hint = /workspace/i.test(msg) && /limit|maximum|exceed/i.test(msg) ? ' Tag Manager allows three workspaces on a standard container; delete an old one and try again.' : '';
		return { ok: false, error: `Tag Manager said: ${msg}.${hint}`, published: false };
	}
}
