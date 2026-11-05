import { googleJson, accessToken, type HttpOptions } from './google';

/** Endpoints and scopes verified against Google's GA4 docs. */
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
const DATA = 'https://analyticsdata.googleapis.com/v1beta';
export const SCOPE_GA4 = 'https://www.googleapis.com/auth/analytics.readonly';

export interface Ga4Property { property: string; displayName: string; account: string }
export interface Ga4Day { date: string; channel: string; sessions: number; engagedSessions: number; users: number; keyEvents: number; pageviews: number }

const tok = (accountId: number) => () => accessToken(accountId);

export async function listProperties(accountId: number, http: HttpOptions = {}): Promise<Ga4Property[]> {
	const out: Ga4Property[] = [];
	let pageToken = '';
	do {
		const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
		const r = await googleJson<{
			accountSummaries?: { displayName?: string; propertySummaries?: { property: string; displayName: string }[] }[];
			nextPageToken?: string;
		}>(tok(accountId), `${ADMIN}/accountSummaries?${q}`, {}, http);
		for (const a of r.accountSummaries ?? []) for (const p of a.propertySummaries ?? []) out.push({ property: p.property, displayName: p.displayName, account: a.displayName ?? '' });
		pageToken = r.nextPageToken ?? '';
	} while (pageToken);
	return out;
}

/**
 * Website URLs of a property's web data streams, used to auto-match a property to a site.
 * `webStreamData.defaultUri` is not shown on the docs page I could fetch; if the field is absent
 * this returns [] and the UI falls back to manual selection.
 */
export async function webStreamUrls(accountId: number, property: string, http: HttpOptions = {}): Promise<string[]> {
	const r = await googleJson<{ dataStreams?: { webStreamData?: { defaultUri?: string } }[] }>(tok(accountId), `${ADMIN}/${property}/dataStreams`, {}, http);
	return (r.dataStreams ?? []).map((s) => s.webStreamData?.defaultUri).filter((u): u is string => !!u);
}

const ymd = (s: string) => `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;

/** Daily sessions etc. by default channel group. `date` values come back as YYYYMMDD. */
export async function dailyByChannel(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Day[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'date' }, { name: 'sessionDefaultChannelGroup' }],
				metrics: ['sessions', 'engagedSessions', 'totalUsers', 'keyEvents', 'screenPageViews'].map((name) => ({ name })),
				limit: 100000
			})
		},
		http
	);
	return (r.rows ?? []).map((row) => {
		const m = row.metricValues.map((v) => Number(v.value));
		return { date: ymd(row.dimensionValues[0].value), channel: row.dimensionValues[1].value, sessions: m[0], engagedSessions: m[1], users: m[2], keyEvents: m[3], pageviews: m[4] };
	});
}

export interface Ga4ChannelUsers { channel: string; users: number }
export interface Ga4Landing { page: string; sessions: number; engagedSessions: number; keyEvents: number }

/**
 * Unique users per channel over a whole window. Daily totalUsers cannot be added across days (a visitor on five days
 * would count five times), so this is a separate report with no date dimension, like GA4's own "Total users".
 */
export async function usersByChannel(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4ChannelUsers[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'sessionDefaultChannelGroup' }],
				metrics: [{ name: 'totalUsers' }],
				limit: 1000
			})
		},
		http
	);
	return (r.rows ?? []).map((row) => ({ channel: row.dimensionValues[0].value, users: Number(row.metricValues[0].value) }));
}

/** Path of a GA4 landing page: no query string or fragment. "/" stays "/". */
export function landingPath(landing: string): string {
	const path = landing.split(/[?#]/)[0] || '/';
	return path.length > 1 ? path.replace(/\/+$/, '') || '/' : path;
}

/**
 * Sessions, engaged sessions and key events for landing pages reached from Google organic search, the traffic that
 * Search Console clicks lead to. Rows that differ only by query string are merged.
 */
export async function organicGoogleLanding(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Landing[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'landingPagePlusQueryString' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } } },
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: 10000
			})
		},
		http
	);
	const merged = new Map<string, Ga4Landing>();
	for (const row of r.rows ?? []) {
		const page = landingPath(row.dimensionValues[0].value);
		const m = row.metricValues.map((v) => Number(v.value));
		const cur = merged.get(page) ?? { page, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		merged.set(page, cur);
	}
	return [...merged.values()];
}
