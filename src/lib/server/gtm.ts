import { GoogleApiError, googleJson, accessToken, type HttpOptions } from './google';
import { hostKey } from './hosts';

/**
 * Tag Manager API v2, read-only. Endpoint shapes and field names below come from my knowledge of the API and have NOT
 * been checked against a live response (no credentials were available), so every field is read defensively and a
 * missing one degrades to "unknown" rather than throwing. Check Google's current docs, including quotas, before relying on it.
 */
const BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

export interface GtmContainer {
	/** accounts/123/containers/456 */
	path: string;
	/** GTM-XXXXXXX, the ID that appears in the site's snippet */
	publicId: string;
	name: string;
	/** The container's domainName values; often empty, since filling it in is optional. */
	domains: string[];
	usage: string[];
	accountName: string;
}

export interface GtmTag {
	id: string;
	name: string;
	/** GTM tag type code: googtag, gaawc, gaawe, html, ua, awct, ... */
	type: string;
	paused: boolean;
	/** Names of the triggers that fire this tag. */
	firing: string[];
	blocking: string[];
	/** G-XXXXXXX the tag sends to, when it is a Google tag / GA4 tag and the ID is a literal or a constant variable. */
	measurementId: string | null;
	eventName: string | null;
}
export interface GtmTrigger { id: string; name: string; type: string }
export interface GtmVariable { id: string; name: string; type: string }

/** A container's live version, reduced to what the UI and the audit need. */
export interface GtmLive {
	versionId: string;
	versionName: string;
	tags: GtmTag[];
	triggers: GtmTrigger[];
	variables: GtmVariable[];
}

export interface GtmSource {
	listContainers(): Promise<GtmContainer[]>;
	/** null when the container has never been published. */
	liveVersion(containerPath: string): Promise<GtmLive | null>;
}

const tok = (accountId: number) => () => accessToken(accountId);
const MAX_ACCOUNTS = 50;
const MAX_ITEMS = 1000;

interface RawParam { key?: string; value?: string; list?: RawParam[]; map?: RawParam[] }
interface RawItem { name?: string; type?: string; parameter?: RawParam[]; tagId?: string; triggerId?: string; variableId?: string; paused?: boolean; firingTriggerId?: string[]; blockingTriggerId?: string[] }
interface RawVersion { containerVersionId?: string; name?: string; tag?: RawItem[]; trigger?: RawItem[]; variable?: RawItem[] }

export async function listContainers(accountId: number, http: HttpOptions = {}): Promise<GtmContainer[]> {
	const accounts = await googleJson<{ account?: { accountId: string; name?: string }[] }>(tok(accountId), `${BASE}/accounts`, {}, http);
	const out: GtmContainer[] = [];
	for (const a of (accounts.account ?? []).slice(0, MAX_ACCOUNTS)) {
		const r = await googleJson<{ container?: { path?: string; containerId: string; name?: string; publicId?: string; domainName?: string[]; usageContext?: string[] }[] }>(
			tok(accountId),
			`${BASE}/accounts/${a.accountId}/containers`,
			{},
			http
		);
		for (const c of r.container ?? []) {
			out.push({
				path: c.path ?? `accounts/${a.accountId}/containers/${c.containerId}`,
				publicId: c.publicId ?? '',
				name: c.name ?? c.publicId ?? c.containerId,
				domains: c.domainName ?? [],
				usage: c.usageContext ?? [],
				accountName: a.name ?? a.accountId
			});
		}
	}
	return out;
}

export async function liveVersion(accountId: number, containerPath: string, http: HttpOptions = {}): Promise<GtmLive | null> {
	try {
		const v = await googleJson<RawVersion>(tok(accountId), `${BASE}/${containerPath}/versions:live`, {}, http);
		return summarizeVersion(v);
	} catch (e) {
		if (e instanceof GoogleApiError && e.status === 404) return null; // never published
		throw e;
	}
}

// ── summarising ──────────────────────────────────────────────────────────────
const MEASUREMENT_ID = /^G-[A-Z0-9]{4,}$/;
export const GA4_TAG_TYPES = new Set(['googtag', 'gaawc', 'gaawe']);

const param = (item: RawItem, ...keys: string[]) => {
	for (const k of keys) {
		const v = item.parameter?.find((p) => p.key === k)?.value;
		if (v) return v;
	}
	return null;
};

/** Reduce a raw ContainerVersion. Variable references such as {{GA4 ID}} are resolved when the variable is a constant. */
export function summarizeVersion(v: RawVersion): GtmLive {
	const triggers = (v.trigger ?? []).slice(0, MAX_ITEMS);
	const triggerName = new Map(triggers.map((t) => [t.triggerId ?? '', t.name ?? t.triggerId ?? '']));
	// Constant variables (type "c") hold a literal in their `value` parameter.
	const constants = new Map<string, string>();
	for (const x of v.variable ?? []) if (x.type === 'c' && x.name) constants.set(x.name, param(x, 'value') ?? '');
	const resolve = (raw: string | null) => {
		if (!raw) return null;
		const ref = /^\{\{(.+)\}\}$/.exec(raw.trim());
		const val = ref ? constants.get(ref[1]) : raw.trim();
		return val && MEASUREMENT_ID.test(val.toUpperCase()) ? val.toUpperCase() : null;
	};
	const tags: GtmTag[] = (v.tag ?? []).slice(0, MAX_ITEMS).map((t) => {
		const type = t.type ?? 'unknown';
		const ga = GA4_TAG_TYPES.has(type);
		return {
			id: t.tagId ?? '',
			name: t.name ?? t.tagId ?? '(unnamed)',
			type,
			paused: !!t.paused,
			firing: (t.firingTriggerId ?? []).map((id) => triggerName.get(id) ?? `trigger ${id}`),
			blocking: (t.blockingTriggerId ?? []).map((id) => triggerName.get(id) ?? `trigger ${id}`),
			// googtag keeps its ID in `tagId`; GA4 configuration / event tags in `measurementId` / `measurementIdOverride`.
			measurementId: ga ? resolve(param(t, 'tagId', 'measurementId', 'measurementIdOverride')) : null,
			eventName: type === 'gaawe' ? param(t, 'eventName') : null
		};
	});
	return {
		versionId: v.containerVersionId ?? '',
		versionName: v.name ?? '',
		tags,
		triggers: triggers.map((t) => ({ id: t.triggerId ?? '', name: t.name ?? '(unnamed)', type: t.type ?? 'unknown' })),
		variables: (v.variable ?? []).slice(0, MAX_ITEMS).map((x) => ({ id: x.variableId ?? '', name: x.name ?? '(unnamed)', type: x.type ?? 'unknown' }))
	};
}

// ── matching containers to sites ─────────────────────────────────────────────
/**
 * Hostnames that identify a container's website: its domainName values, plus its name when that looks like a host or URL
 * (people very often name a container after the site, and leave domainName empty).
 */
export function containerHosts(c: Pick<GtmContainer, 'domains' | 'name'>): string[] {
	const hosts = c.domains.filter(Boolean).map(hostKey);
	const n = c.name.trim();
	if (/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(n)) hosts.push(hostKey(n));
	return [...new Set(hosts)];
}

export const isWebContainer = (c: Pick<GtmContainer, 'usage'>) => !c.usage.length || c.usage.includes('web');

/** Friendly names for the tag types people see most; anything else shows its raw code. */
export const TAG_TYPE_LABEL: Record<string, string> = {
	googtag: 'Google tag',
	gaawc: 'GA4 configuration',
	gaawe: 'GA4 event',
	html: 'Custom HTML',
	ua: 'Universal Analytics',
	awct: 'Google Ads conversion',
	sp: 'Google Ads remarketing',
	flc: 'Floodlight counter',
	fls: 'Floodlight sales',
	img: 'Custom image'
};
export const tagTypeLabel = (t: string) => TAG_TYPE_LABEL[t] ?? (t.startsWith('cvt_') ? 'Community template' : t);
