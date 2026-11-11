import { googleJson, accessToken, type HttpOptions } from './google';

/**
 * Creating a GA4 property and web data stream through the Analytics Admin API (v1beta), and starting the creation of a GA4
 * account. The one place SEOConsole writes to Google Analytics, and only for the "Set up GA4 & Tag Manager" button.
 *
 * Checked against Google's Admin API reference when this was written:
 *  - properties.create:        POST /v1beta/properties, body = Property {parent "accounts/123", displayName (required),
 *                              timeZone (required, IANA), currencyCode (ISO 4217)}; scope analytics.edit.
 *  - dataStreams.create:       POST /v1beta/{properties/123}/dataStreams, body = DataStream {type "WEB_DATA_STREAM",
 *                              displayName, webStreamData {defaultUri}}; the response's webStreamData.measurementId is "G-…".
 *  - accounts.provisionAccountTicket: POST /v1beta/accounts:provisionAccountTicket, body {account {displayName}, redirectUri};
 *                              returns accountTicketId, which goes in the Terms of Service link below (Google's Admin API guide).
 *  - accountSummaries.list:    GET /v1beta/accountSummaries (analytics.readonly or analytics.edit), each with `account`.
 * Not run against a live Google account here: check the first real run in Google Analytics.
 */
const ADMIN = 'https://analyticsadmin.googleapis.com/v1beta';
export const SCOPE_GA4_EDIT = 'https://www.googleapis.com/auth/analytics.edit';

export interface Ga4AdminAccount { account: string; displayName: string }
export interface Ga4WebStream { measurementId: string; uri: string }

export interface Ga4Admin {
	/** GA4 accounts the person can see ("accounts/123"). */
	listAccounts(): Promise<Ga4AdminAccount[]>;
	/** The property's web data streams. */
	webStreams(property: string): Promise<Ga4WebStream[]>;
	createProperty(account: string, p: { displayName: string; timeZone: string; currencyCode: string }): Promise<{ property: string; displayName: string }>;
	createWebStream(property: string, s: { displayName: string; uri: string }): Promise<{ stream: string; measurementId: string }>;
	/** Step one of creating a GA4 account; returns the ticket for the Terms of Service link. */
	provisionTicket(displayName: string, redirectUri: string): Promise<string>;
}

export const hasGa4Write = (a: { scopes: string; is_demo: number }) => !!a.is_demo || a.scopes.split(/\s+/).includes(SCOPE_GA4_EDIT);

/** Where the person accepts Google's Terms of Service to finish creating an account (Admin API guide: the ticket ID goes at the end). */
export const ga4TosUrl = (ticketId: string) => `https://analytics.google.com/analytics/web/?provisioningSignup=false#/termsofservice/${encodeURIComponent(ticketId)}`;

export function realGa4Admin(accountId: number, http: HttpOptions = {}): Ga4Admin {
	const call = <T>(url: string, init?: RequestInit) => googleJson<T>(() => accessToken(accountId), url, init, http);
	const post = <T>(url: string, body: object) => call<T>(url, { method: 'POST', body: JSON.stringify(body) });
	return {
		async listAccounts() {
			const out: Ga4AdminAccount[] = [];
			let pageToken = '';
			do {
				const q = new URLSearchParams({ pageSize: '200', ...(pageToken ? { pageToken } : {}) });
				const r = await call<{ accountSummaries?: { account?: string; displayName?: string }[]; nextPageToken?: string }>(`${ADMIN}/accountSummaries?${q}`);
				for (const a of r.accountSummaries ?? []) if (a.account) out.push({ account: a.account, displayName: a.displayName ?? a.account });
				pageToken = r.nextPageToken ?? '';
			} while (pageToken);
			return out;
		},
		async webStreams(property) {
			const r = await call<{ dataStreams?: { type?: string; webStreamData?: { measurementId?: string; defaultUri?: string } }[] }>(`${ADMIN}/${property}/dataStreams`);
			return (r.dataStreams ?? []).filter((s) => s.webStreamData?.measurementId).map((s) => ({ measurementId: s.webStreamData!.measurementId!, uri: s.webStreamData!.defaultUri ?? '' }));
		},
		async createProperty(account, p) {
			const r = await post<{ name?: string; displayName?: string }>(`${ADMIN}/properties`, { parent: account, displayName: p.displayName, timeZone: p.timeZone, currencyCode: p.currencyCode });
			if (!r.name) throw new Error('Google Analytics did not return the new property.');
			return { property: r.name, displayName: r.displayName ?? p.displayName };
		},
		async createWebStream(property, s) {
			const r = await post<{ name?: string; webStreamData?: { measurementId?: string } }>(`${ADMIN}/${property}/dataStreams`, { type: 'WEB_DATA_STREAM', displayName: s.displayName, webStreamData: { defaultUri: s.uri } });
			return { stream: r.name ?? '', measurementId: r.webStreamData?.measurementId ?? '' };
		},
		async provisionTicket(displayName, redirectUri) {
			const r = await post<{ accountTicketId?: string }>(`${ADMIN}/accounts:provisionAccountTicket`, { account: { displayName }, redirectUri });
			if (!r.accountTicketId) throw new Error('Google Analytics did not return an account ticket.');
			return r.accountTicketId;
		}
	};
}
