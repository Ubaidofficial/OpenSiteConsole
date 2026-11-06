import { randomBytes } from 'node:crypto';
import { db } from './db';
import { config } from './config';
import { decrypt, encrypt } from './crypto';

export interface SearchRow {
	keys: string[];
	clicks: number;
	impressions: number;
	ctr: number;
	position: number;
}

export interface QueryBody {
	startDate: string;
	endDate: string;
	dimensions?: string[];
	rowLimit?: number;
	startRow?: number;
	type?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
	/** Current name of `type`. The real client sends both, so an API that only knows one still filters correctly. */
	searchType?: 'web' | 'image' | 'video' | 'news' | 'discover' | 'googleNews';
	dataState?: 'all' | 'final';
	aggregationType?: 'auto' | 'byPage' | 'byProperty';
	dimensionFilterGroups?: unknown[];
}

export interface SiteEntry {
	siteUrl: string;
	permissionLevel: string;
}

export interface SitemapInfo {
	path: string;
	lastSubmitted?: string;
	lastDownloaded?: string;
	isPending?: boolean;
	isSitemapsIndex?: boolean;
	type?: string;
	warnings?: number;
	errors?: number;
	contents?: { type: string; submitted?: number; indexed?: number }[];
}

export interface InspectionResult {
	inspectionResultLink?: string;
	indexStatusResult?: {
		verdict?: string;
		coverageState?: string;
		robotsTxtState?: string;
		indexingState?: string;
		lastCrawlTime?: string;
		pageFetchState?: string;
		googleCanonical?: string;
		userCanonical?: string;
		crawledAs?: string;
		sitemap?: string[];
		referringUrls?: string[];
	};
	mobileUsabilityResult?: { verdict?: string; issues?: { issueType?: string; message?: string }[] };
	richResultsResult?: { verdict?: string };
}

/** Everything the app needs from Search Console. Real and demo implementations share it. */
export interface GscClient {
	listSites(): Promise<SiteEntry[]>;
	addSite(siteUrl: string): Promise<void>;
	deleteSite(siteUrl: string): Promise<void>;
	query(siteUrl: string, body: QueryBody): Promise<SearchRow[]>;
	listSitemaps(siteUrl: string): Promise<SitemapInfo[]>;
	submitSitemap(siteUrl: string, feedpath: string): Promise<void>;
	deleteSitemap(siteUrl: string, feedpath: string): Promise<void>;
	inspectUrl(siteUrl: string, url: string): Promise<InspectionResult>;
}

export class GoogleApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly reason?: string
	) {
		super(message);
	}
	get isRevoked() {
		return this.reason === 'invalid_grant' || this.status === 401;
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const SCOPE_WRITE = 'https://www.googleapis.com/auth/webmasters';
export const SCOPE_READ = 'https://www.googleapis.com/auth/webmasters.readonly';

export const SCOPE_GA4_READ = 'https://www.googleapis.com/auth/analytics.readonly';
/** Read-only on purpose: OpenSiteConsole inspects Tag Manager containers, it never edits or publishes them. */
export const SCOPE_GTM_READ = 'https://www.googleapis.com/auth/tagmanager.readonly';

/** One consent covers Search Console and (unless GOOGLE_INCLUDE_GA4=0 / GOOGLE_INCLUDE_GTM=0) GA4 and Tag Manager, so users click once. */
export function scopes(): string {
	const ga4 = process.env.GOOGLE_INCLUDE_GA4 === '0' ? '' : ` ${SCOPE_GA4_READ}`;
	const gtm = process.env.GOOGLE_INCLUDE_GTM === '0' ? '' : ` ${SCOPE_GTM_READ}`;
	return `openid email ${config.readOnly ? SCOPE_READ : SCOPE_WRITE}${ga4}${gtm}`;
}

export function redirectUri(): string {
	return `${config.origin}/auth/callback`;
}

export function buildAuthUrl(state: string): string {
	const p = new URLSearchParams({
		client_id: config.googleClientId,
		redirect_uri: redirectUri(),
		response_type: 'code',
		scope: scopes(),
		access_type: 'offline',
		prompt: 'consent select_account',
		include_granted_scopes: 'true',
		state
	});
	return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}

export const newState = () => randomBytes(24).toString('base64url');

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	id_token?: string;
	scope?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
	const res = await fetch('https://oauth2.googleapis.com/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: config.googleClientId,
			client_secret: config.googleClientSecret,
			...params
		})
	});
	const json = (await res.json().catch(() => ({}))) as Record<string, string>;
	if (!res.ok) {
		throw new GoogleApiError(json.error_description ?? json.error ?? `Token endpoint ${res.status}`, res.status, json.error);
	}
	return json as unknown as TokenResponse;
}

export async function exchangeCode(code: string) {
	const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri() });
	const info = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
		headers: { authorization: `Bearer ${t.access_token}` }
	}).then((r) => r.json() as Promise<{ sub: string; email: string }>);
	return { tokens: t, sub: info.sub, email: info.email };
}

interface AccountRow {
	id: number;
	refresh_token_enc: string | null;
	access_token_enc: string | null;
	expires_at: number | null;
}

export async function accessToken(accountId: number): Promise<string> {
	const row = db().prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) as AccountRow | undefined;
	if (!row) throw new Error(`Unknown account ${accountId}`);
	if (row.access_token_enc && row.expires_at && row.expires_at > Date.now() + 60_000) {
		return decrypt(row.access_token_enc);
	}
	if (!row.refresh_token_enc) throw new GoogleApiError('No refresh token stored; reconnect the account', 401, 'invalid_grant');
	try {
		const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(row.refresh_token_enc) });
		db()
			.prepare('UPDATE accounts SET access_token_enc = ?, expires_at = ?, status = ? WHERE id = ?')
			.run(encrypt(t.access_token), Date.now() + t.expires_in * 1000, 'active', accountId);
		return t.access_token;
	} catch (e) {
		if (e instanceof GoogleApiError && e.reason === 'invalid_grant') {
			db().prepare("UPDATE accounts SET status = 'revoked' WHERE id = ?").run(accountId);
		}
		throw e;
	}
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export interface HttpOptions {
	retries?: number;
	baseDelayMs?: number;
	fetchImpl?: typeof fetch;
	sleepImpl?: (ms: number) => Promise<void>;
}

/** fetch + JSON with bounded retry on 429/5xx (honours Retry-After). */
export async function googleJson<T>(
	token: () => Promise<string>,
	url: string,
	init: RequestInit = {},
	o: HttpOptions = {}
): Promise<T> {
	const { retries = 4, baseDelayMs = 800, fetchImpl = fetch, sleepImpl = sleep } = o;
	for (let attempt = 0; ; attempt++) {
		const res = await fetchImpl(url, {
			...init,
			headers: {
				...(init.body ? { 'content-type': 'application/json' } : {}),
				...(init.headers as Record<string, string>),
				authorization: `Bearer ${await token()}`
			}
		});
		if (res.ok) {
			const text = await res.text();
			return (text ? JSON.parse(text) : {}) as T;
		}
		if (RETRYABLE.has(res.status) && attempt < retries) {
			const ra = Number(res.headers.get('retry-after'));
			const wait = ra > 0 ? ra * 1000 : baseDelayMs * 2 ** attempt + Math.random() * 250;
			await sleepImpl(wait);
			continue;
		}
		const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; status?: string } };
		throw new GoogleApiError(body.error?.message ?? `Google API ${res.status}`, res.status, body.error?.status);
	}
}

const WM = 'https://www.googleapis.com/webmasters/v3';
const enc = encodeURIComponent;

export class RealClient implements GscClient {
	constructor(
		private accountId: number,
		private http: HttpOptions = {}
	) {}
	private call<T>(url: string, init?: RequestInit) {
		return googleJson<T>(() => accessToken(this.accountId), url, init, this.http);
	}
	async listSites() {
		const r = await this.call<{ siteEntry?: SiteEntry[] }>(`${WM}/sites`);
		return r.siteEntry ?? [];
	}
	async addSite(siteUrl: string) {
		await this.call(`${WM}/sites/${enc(siteUrl)}`, { method: 'PUT' });
	}
	async deleteSite(siteUrl: string) {
		await this.call(`${WM}/sites/${enc(siteUrl)}`, { method: 'DELETE' });
	}
	async query(siteUrl: string, body: QueryBody) {
		const r = await this.call<{ rows?: SearchRow[] }>(`${WM}/sites/${enc(siteUrl)}/searchAnalytics/query`, {
			method: 'POST',
			body: JSON.stringify(body.type && !body.searchType ? { ...body, searchType: body.type } : body)
		});
		return r.rows ?? [];
	}
	async listSitemaps(siteUrl: string) {
		const r = await this.call<{ sitemap?: SitemapInfo[] }>(`${WM}/sites/${enc(siteUrl)}/sitemaps`);
		return r.sitemap ?? [];
	}
	async submitSitemap(siteUrl: string, feedpath: string) {
		await this.call(`${WM}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, { method: 'PUT' });
	}
	async deleteSitemap(siteUrl: string, feedpath: string) {
		await this.call(`${WM}/sites/${enc(siteUrl)}/sitemaps/${enc(feedpath)}`, { method: 'DELETE' });
	}
	async inspectUrl(siteUrl: string, url: string) {
		const r = await this.call<{ inspectionResult: InspectionResult }>(
			'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect',
			{ method: 'POST', body: JSON.stringify({ inspectionUrl: url, siteUrl, languageCode: 'en-US' }) }
		);
		return r.inspectionResult;
	}
}
