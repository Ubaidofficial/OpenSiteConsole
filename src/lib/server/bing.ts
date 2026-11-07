import { db } from './db';
import { decrypt, encrypt } from './crypto';
import { env } from './config';
import { sleep } from './google';

/** Verified against Microsoft Learn (Bing Webmaster API docs). */
const KEY_BASE = 'https://ssl.bing.com/webmaster/api.svc/json';
const OAUTH_BASE = 'https://www.bing.com/webmaster/api.svc/json';
export const BING_AUTHORIZE = 'https://www.bing.com/webmasters/oauth/authorize';
export const BING_TOKEN = 'https://www.bing.com/webmasters/oauth/token';

export class BingApiError extends Error {
	constructor(message: string, readonly status: number, readonly code?: number) {
		super(message);
	}
}

export interface BingSite { url: string; isVerified: boolean }
export interface BingDay { date: string; clicks: number; impressions: number }
export interface BingTermRow { date: string; term: string; clicks: number; impressions: number; clickPos: number | null; imprPos: number | null }

export interface BingClient {
	listSites(): Promise<BingSite[]>;
	dailyStats(siteUrl: string): Promise<BingDay[]>;
	queryStats(siteUrl: string): Promise<BingTermRow[]>;
	pageStats(siteUrl: string): Promise<BingTermRow[]>;
	/** Tell Bing about URLs (its URL submission API, up to 500 per call). Throws BingApiError when Bing refuses. */
	submitUrlBatch(siteUrl: string, urls: string[]): Promise<void>;
	/** URLs Bing still accepts today and this month; null where Bing did not say. */
	urlSubmissionQuota(siteUrl: string): Promise<{ daily: number | null; monthly: number | null }>;
}

/** Bing takes at most this many URLs in one SubmitUrlBatch call (Microsoft Learn / the Bing webmaster blog). */
export const BING_MAX_URLS_PER_CALL = 500;

/**
 * Bing returns WCF dates like "/Date(1316156400000-0700)/": epoch ms plus the offset the day was
 * bucketed in. Applying the offset recovers the calendar day Bing meant (here 2011-09-16).
 */
export function parseBingDate(s: string): string {
	const m = /\/Date\((-?\d+)(?:([+-])(\d{2})(\d{2}))?\)\//.exec(s);
	if (!m) throw new Error(`Unrecognised Bing date: ${s}`);
	const offMin = m[2] ? (m[2] === '-' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) : 0;
	return new Date(Number(m[1]) + offMin * 60_000).toISOString().slice(0, 10);
}

type Secret = { apiKey?: string; refreshToken?: string; accessToken?: string; expiresAt?: number };
interface HttpOpts { fetchImpl?: typeof fetch; sleepImpl?: (ms: number) => Promise<void>; retries?: number }

export function bingSecret(integrationId: number): Secret {
	const row = db().prepare('SELECT secret_enc FROM integrations WHERE id = ?').get(integrationId) as { secret_enc: string | null } | undefined;
	return row?.secret_enc ? (JSON.parse(decrypt(row.secret_enc)) as Secret) : {};
}

async function bearer(integrationId: number, f: typeof fetch): Promise<string> {
	const s = bingSecret(integrationId);
	if (s.accessToken && s.expiresAt && s.expiresAt > Date.now() + 60_000) return s.accessToken;
	if (!s.refreshToken) throw new BingApiError('Bing connection has no refresh token; reconnect it', 401);
	const res = await f(BING_TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: env('BING_CLIENT_ID'),
			client_secret: env('BING_CLIENT_SECRET'),
			grant_type: 'refresh_token',
			refresh_token: s.refreshToken
		})
	});
	const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; refresh_token?: string };
	if (!res.ok || !j.access_token) {
		db().prepare("UPDATE integrations SET status = 'revoked' WHERE id = ?").run(integrationId);
		throw new BingApiError('Bing refused to refresh the token; reconnect the account', res.status || 401);
	}
	const next: Secret = { ...s, accessToken: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000, refreshToken: j.refresh_token ?? s.refreshToken };
	db().prepare("UPDATE integrations SET secret_enc = ?, status = 'active' WHERE id = ?").run(encrypt(JSON.stringify(next)), integrationId);
	return next.accessToken!;
}

/** Bing prefixes messages like "ERROR!!! InvalidApiKey"; turn the common ones into something a user can act on. */
export function friendlyBingError(message: string | undefined, code: number | undefined, status: number): string {
	const m = (message ?? '').replace(/^ERROR!+\s*/i, '').trim();
	if (m === 'InvalidApiKey' || code === 3) return 'Bing rejected this API key. Generate one in Bing Webmaster Tools → Settings → API Access, and paste it exactly.';
	return m || `Bing API ${status}`;
}

export class RealBingClient implements BingClient {
	constructor(
		private integrationId: number,
		private http: HttpOpts = {}
	) {}

	private async call<T>(method: string, params: Record<string, string> = {}, payload?: unknown): Promise<T> {
		const f = this.http.fetchImpl ?? fetch;
		const wait = this.http.sleepImpl ?? sleep;
		const secret = bingSecret(this.integrationId);
		for (let attempt = 0; ; attempt++) {
			const q = new URLSearchParams(params);
			const headers: Record<string, string> = {};
			let base = KEY_BASE;
			if (secret.apiKey) q.set('apikey', secret.apiKey);
			else (base = OAUTH_BASE), (headers.authorization = `Bearer ${await bearer(this.integrationId, f)}`);
			let res: Response;
			try {
				res = await f(`${base}/${method}?${q}`, payload === undefined ? { headers } : { method: 'POST', headers: { ...headers, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) });
			} catch {
				// Never surface the raw error: its message can contain the URL, and the URL contains the API key.
				throw new BingApiError('Could not reach Bing Webmaster API', 0);
			}
			if (res.ok) return ((await res.json().catch(() => ({}))) as { d: T }).d;
			if ((res.status === 429 || res.status >= 500) && attempt < (this.http.retries ?? 3)) {
				await wait(800 * 2 ** attempt);
				continue;
			}
			const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
			throw new BingApiError(friendlyBingError(body.Message, body.ErrorCode, res.status), res.status, body.ErrorCode);
		}
	}

	async listSites() {
		const r = await this.call<{ Url: string; IsVerified: boolean }[]>('GetUserSites');
		return r.map((s) => ({ url: s.Url, isVerified: !!s.IsVerified }));
	}
	async dailyStats(siteUrl: string) {
		const r = await this.call<{ Date: string; Clicks: number; Impressions: number }[]>('GetRankAndTrafficStats', { siteUrl });
		return r.map((x) => ({ date: parseBingDate(x.Date), clicks: x.Clicks, impressions: x.Impressions }));
	}
	private terms(r: { Date: string; Query: string; Clicks: number; Impressions: number; AvgClickPosition?: number; AvgImpressionPosition?: number }[]): BingTermRow[] {
		return r.map((x) => ({ date: parseBingDate(x.Date), term: x.Query, clicks: x.Clicks, impressions: x.Impressions, clickPos: x.AvgClickPosition ?? null, imprPos: x.AvgImpressionPosition ?? null }));
	}
	async queryStats(siteUrl: string) {
		return this.terms(await this.call('GetQueryStats', { siteUrl }));
	}
	async submitUrlBatch(siteUrl: string, urls: string[]) {
		if (urls.length > BING_MAX_URLS_PER_CALL) throw new BingApiError(`At most ${BING_MAX_URLS_PER_CALL} URLs per call.`, 400);
		await this.call('SubmitUrlBatch', {}, { siteUrl, urlList: urls });
	}
	async urlSubmissionQuota(siteUrl: string) {
		const r = await this.call<{ DailyQuota?: number; MonthlyQuota?: number } | null>('GetUrlSubmissionQuota', { siteUrl });
		const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
		return { daily: n(r?.DailyQuota), monthly: n(r?.MonthlyQuota) };
	}
	async pageStats(siteUrl: string) {
		// Per Microsoft's docs GetPageStats reuses the QueryStats shape, with the page URL in `Query`.
		return this.terms(await this.call('GetPageStats', { siteUrl }));
	}
}
