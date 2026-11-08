import { googleJson, accessToken, type HttpOptions } from './google';
import { assistantOf, GA4_SOURCE_PATTERN, type Assistant } from '../ai';

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

/**
 * Measurement IDs (G-XXXXXXX) of a property's web data streams, used to check that the Tag Manager container sends data to
 * the property that is linked here. `webStreamData.measurementId` comes from my reading of the Admin API's DataStream
 * resource and is not confirmed against a live response; if absent this returns [] and the cross-check is skipped.
 */
export async function webStreamMeasurementIds(accountId: number, property: string, http: HttpOptions = {}): Promise<string[]> {
	const r = await googleJson<{ dataStreams?: { webStreamData?: { measurementId?: string } }[] }>(tok(accountId), `${ADMIN}/${property}/dataStreams`, {}, http);
	return (r.dataStreams ?? []).map((s) => s.webStreamData?.measurementId).filter((m): m is string => !!m);
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

export interface Ga4Ai { assistant: Assistant; page: string; sessions: number; engagedSessions: number; keyEvents: number }

/**
 * Sessions that arrived from AI assistants (ChatGPT, Perplexity, Gemini, Claude, Copilot), by landing page. Sources are
 * picked with a regular-expression filter and then named by `assistantOf`; rows it does not recognise are dropped.
 */
export async function aiAssistantTraffic(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4Ai[]> {
	const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
		tok(accountId),
		`${DATA}/${property}:runReport`,
		{
			method: 'POST',
			body: JSON.stringify({
				dateRanges: [{ startDate, endDate }],
				dimensions: [{ name: 'sessionSource' }, { name: 'landingPagePlusQueryString' }],
				metrics: ['sessions', 'engagedSessions', 'keyEvents'].map((name) => ({ name })),
				dimensionFilter: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: GA4_SOURCE_PATTERN, caseSensitive: false } } },
				orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
				limit: 10000
			})
		},
		http
	);
	const merged = new Map<string, Ga4Ai>();
	for (const row of r.rows ?? []) {
		const assistant = assistantOf(row.dimensionValues[0].value);
		if (!assistant) continue;
		const page = landingPath(row.dimensionValues[1].value);
		const m = row.metricValues.map((v) => Number(v.value));
		const key = `${assistant}\n${page}`;
		const cur = merged.get(key) ?? { assistant, page, sessions: 0, engagedSessions: 0, keyEvents: 0 };
		cur.sessions += m[0];
		cur.engagedSessions += m[1];
		cur.keyEvents += m[2];
		merged.set(key, cur);
	}
	return [...merged.values()];
}

export interface Ga4PageDay { date: string; page: string; sessions: number; keyEvents: number }

/**
 * Google-organic sessions and key events by day and landing page: what an SEO test needs to be judged on conversions as well as
 * clicks. Paged (100,000 rows a request, 600,000 in all) and merged by landing path, so query-string variants of a page count once.
 */
export async function organicLandingDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4PageDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 600_000;
	const merged = new Map<string, Ga4PageDay>();
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'landingPagePlusQueryString' }],
					metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
					dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: 'google / organic' } } },
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: 'landingPagePlusQueryString' } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const date = ymd(row.dimensionValues[0].value);
			const page = landingPath(row.dimensionValues[1].value);
			const k = `${date}\n${page}`;
			const cur = merged.get(k) ?? { date, page, sessions: 0, keyEvents: 0 };
			cur.sessions += Number(row.metricValues[0].value);
			cur.keyEvents += Number(row.metricValues[1].value);
			merged.set(k, cur);
		}
		if (rows.length < LIMIT) break;
		// Rows come oldest day first, so stopping here would silently drop the most recent days and read as a collapse after a change.
		if (offset + LIMIT >= MAX_ROWS) throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} landing-page rows for ${startDate} to ${endDate}; conversions cannot be judged on a partial load.`);
	}
	return [...merged.values()];
}

export interface Ga4AiDay { date: string; assistant: Assistant; page: string; sessions: number; keyEvents: number }

/**
 * Sessions from AI assistants by day, assistant and landing page: what an LLM test (an SEO test judged on AI-assistant sessions)
 * needs. Same source filter as aiAssistantTraffic, so the same assistants are recognised and the same caveat holds: an assistant
 * that sends no referrer lands in Direct and cannot be counted. Paged like organicLandingDaily; AI traffic is small, so the cap is
 * rarely near.
 */
export async function aiAssistantDaily(accountId: number, property: string, startDate: string, endDate: string, http: HttpOptions = {}): Promise<Ga4AiDay[]> {
	const LIMIT = 100_000;
	const MAX_ROWS = 300_000;
	const merged = new Map<string, Ga4AiDay>();
	for (let offset = 0; offset < MAX_ROWS; offset += LIMIT) {
		const r = await googleJson<{ rows?: { dimensionValues: { value: string }[]; metricValues: { value: string }[] }[] }>(
			tok(accountId),
			`${DATA}/${property}:runReport`,
			{
				method: 'POST',
				body: JSON.stringify({
					dateRanges: [{ startDate, endDate }],
					dimensions: [{ name: 'date' }, { name: 'sessionSource' }, { name: 'landingPagePlusQueryString' }],
					metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
					dimensionFilter: { filter: { fieldName: 'sessionSource', stringFilter: { matchType: 'PARTIAL_REGEXP', value: GA4_SOURCE_PATTERN, caseSensitive: false } } },
					orderBys: [{ dimension: { dimensionName: 'date' } }, { dimension: { dimensionName: 'sessionSource' } }, { dimension: { dimensionName: 'landingPagePlusQueryString' } }],
					limit: LIMIT,
					offset
				})
			},
			http
		);
		const rows = r.rows ?? [];
		for (const row of rows) {
			const assistant = assistantOf(row.dimensionValues[1].value);
			if (!assistant) continue;
			const date = ymd(row.dimensionValues[0].value);
			const page = landingPath(row.dimensionValues[2].value);
			const k = `${date}\n${assistant}\n${page}`;
			const cur = merged.get(k) ?? { date, assistant, page, sessions: 0, keyEvents: 0 };
			cur.sessions += Number(row.metricValues[0].value);
			cur.keyEvents += Number(row.metricValues[1].value);
			merged.set(k, cur);
		}
		if (rows.length < LIMIT) break;
		// Oldest day first, so a cut-off load would drop the latest days and read as a collapse after the change.
		if (offset + LIMIT >= MAX_ROWS) throw new Error(`GA4 returned more than ${MAX_ROWS.toLocaleString('en-US')} AI-assistant rows for ${startDate} to ${endDate}; the test cannot be judged on a partial load.`);
	}
	return [...merged.values()];
}
