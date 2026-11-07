import { audit } from './db';
import { config } from './config';
import { accessToken, googleJson, GoogleApiError } from './google';
import { clientForAccount, type AccountLite } from './clients';
import { db } from './db';
import { syncAccountSites } from './accounts';

/**
 * Prove ownership of a site to Google from inside the app (Google's Site Verification API), then add it to Search Console, so
 * nobody has to open Search Console for it. A site is verified by putting a token Google hands out on the site (a meta tag or
 * file) or in its DNS (a TXT or CNAME record); this module asks for the token and later asks Google to check for it. The app
 * cannot place the token for you: that is a change to your site or your DNS.
 *
 * Opt-in: it needs an extra Google permission, requested only when GOOGLE_INCLUDE_SITE_VERIFICATION=1 (never in READ_ONLY mode).
 * Written from Google's documentation and not yet run against the live API: the first real use may need small fixes.
 */
export const SCOPE_SITE_VERIFICATION = 'https://www.googleapis.com/auth/siteverification.verify_only';
export const siteVerificationEnabled = () => process.env.GOOGLE_INCLUDE_SITE_VERIFICATION === '1';
const BASE = 'https://www.googleapis.com/siteVerification/v1';

export type VerifyMethod = 'META' | 'FILE' | 'DNS_TXT' | 'DNS_CNAME';
export const VERIFY_METHODS: VerifyMethod[] = ['META', 'FILE', 'DNS_TXT', 'DNS_CNAME'];

export interface PropertyRef { type: 'SITE' | 'INET_DOMAIN'; identifier: string; /** the name Search Console uses for it */ gscUrl: string }

/** "example.com" or "sc-domain:example.com" is a whole domain; "https://example.com/blog/" is one site (URL prefix). Anything else is refused. */
export function propertyFor(input: string): PropertyRef | null {
	const t = input.trim();
	const dom = /^(?:sc-domain:)?((?:[a-z0-9-]+\.)+[a-z]{2,})$/i.exec(t);
	if (dom) return { type: 'INET_DOMAIN', identifier: dom[1].toLowerCase(), gscUrl: `sc-domain:${dom[1].toLowerCase()}` };
	try {
		const u = new URL(t);
		if ((u.protocol === 'https:' || u.protocol === 'http:') && u.hostname.includes('.') && !u.username && !u.password) {
			const id = `${u.origin}${u.pathname.endsWith('/') ? u.pathname : u.pathname + '/'}`;
			return { type: 'SITE', identifier: id, gscUrl: id };
		}
	} catch {
		/* not a URL */
	}
	return null;
}

/** A whole domain can only be proven in DNS; a URL-prefix site with a meta tag or a file. */
export const methodsFor = (p: PropertyRef): VerifyMethod[] => (p.type === 'INET_DOMAIN' ? ['DNS_TXT', 'DNS_CNAME'] : ['META', 'FILE']);

/** What to do with a token, in words. The token is Google's; if Google's own wording differs, follow Google's. */
export function placementHelp(method: VerifyMethod, token: string): string {
	switch (method) {
		case 'META': return `Put this tag inside the <head> of the site's home page: ${token}`;
		case 'FILE': return `Create a file named ${token} in the site's root so https://<site>/${token} opens, with exactly this single line as its content: google-site-verification: ${token}`;
		case 'DNS_TXT': return `Add a TXT record on the domain (host @) with exactly this value: ${token}`;
		case 'DNS_CNAME': return `Add a CNAME record as Google specifies for this token (${token}); DNS changes can take a while to spread.`;
	}
}

interface Opts { fetchImpl?: typeof fetch }

export function explainVerifyError(e: unknown): string {
	if (!(e instanceof GoogleApiError)) return 'Could not reach Google.';
	if (e.status === 403) return 'Google refused: set GOOGLE_INCLUDE_SITE_VERIFICATION=1 and reconnect this Google account (an extra permission is asked).';
	if (e.status === 401) return 'Google rejected the sign-in: reconnect the Google account.';
	return e.message;
}

/** The token Google wants placed on the site or in DNS. */
export async function getVerificationToken(accountId: number, siteInput: string, method: VerifyMethod, o: Opts = {}): Promise<{ property: PropertyRef; method: VerifyMethod; token: string; help: string }> {
	const property = propertyFor(siteInput);
	if (!property) throw new Error('Use a domain such as example.com, or a full address such as https://example.com/.');
	if (!methodsFor(property).includes(method)) throw new Error(`${property.type === 'INET_DOMAIN' ? 'A whole domain' : 'A URL-prefix site'} can be verified with ${methodsFor(property).join(' or ')}, not ${method}.`);
	if ((db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(accountId) as { is_demo: number } | undefined)?.is_demo) {
		const token = method === 'META' ? '<meta name="google-site-verification" content="demo-token" />' : method === 'FILE' ? 'google0demo0token.html' : 'google-site-verification=demo-token';
		return { property, method, token, help: placementHelp(method, token) };
	}
	try {
		const r = await googleJson<{ token?: string }>(() => accessToken(accountId), `${BASE}/token`, { method: 'POST', body: JSON.stringify({ site: { type: property.type, identifier: property.identifier }, verificationMethod: method }) }, { fetchImpl: o.fetchImpl, retries: 1 });
		if (!r.token) throw new Error('Google returned no token.');
		return { property, method, token: r.token, help: placementHelp(method, r.token) };
	} catch (e) {
		throw new Error(explainVerifyError(e), { cause: e });
	}
}

/**
 * Ask Google to look for the token. When it is found the site is verified for this account; then it is added to Search Console and the
 * account's properties are refreshed, so the site appears in the app. A property that was already added stays added.
 */
export async function verifyAndAdd(account: AccountLite, siteInput: string, method: VerifyMethod, o: Opts = {}): Promise<{ property: PropertyRef; verified: true; added: boolean }> {
	if (config.readOnly) throw new Error('READ_ONLY=1: verifying and adding sites is disabled.');
	const property = propertyFor(siteInput);
	if (!property) throw new Error('Use a domain such as example.com, or a full address such as https://example.com/.');
	if (!methodsFor(property).includes(method)) throw new Error(`${property.type === 'INET_DOMAIN' ? 'A whole domain' : 'A URL-prefix site'} can be verified with ${methodsFor(property).join(' or ')}, not ${method}.`);
	const isDemo = !!(db().prepare('SELECT is_demo FROM accounts WHERE id = ?').get(account.id) as { is_demo: number } | undefined)?.is_demo;
	if (!isDemo) {
		try {
			await googleJson<unknown>(() => accessToken(account.id), `${BASE}/webResource?verificationMethod=${method}`, { method: 'POST', body: JSON.stringify({ site: { type: property.type, identifier: property.identifier } }) }, { fetchImpl: o.fetchImpl, retries: 1 });
		} catch (e) {
			throw new Error(`Google could not verify ${property.identifier}: ${explainVerifyError(e)}`, { cause: e });
		}
	}
	audit('site.verified', { accountId: account.id, detail: `${property.gscUrl} via ${method}` });
	let added = false;
	try {
		await clientForAccount(account).addSite(property.gscUrl);
		added = true;
		audit('site.added', { accountId: account.id, detail: property.gscUrl });
	} catch {
		/* verified but not added: it may already be in Search Console; the refresh below shows what is there */
	}
	await syncAccountSites(account.id).catch(() => {});
	return { property, verified: true, added };
}
