/**
 * Hosted plan: every customer's instance has its own address, but a Google OAuth client allows only a limited number of redirect
 * addresses, so all instances share ONE (the control app's /oauth/callback). The instance puts its own origin into the OAuth
 * `state`, and the control app, after checking it names a real customer, forwards the browser back to that instance.
 * Pure helpers used by both sides.
 */
const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const unb64 = (s: string) => Buffer.from(s, 'base64url').toString('utf8');

/** `<random state>.<origin>`: the instance still compares the whole value with its cookie, exactly as before. */
export function stateWithOrigin(state: string, origin: string): string {
	return `${state}.${b64(origin)}`;
}

/** The origin an instance put into a state value, or null. It is NOT trusted: the caller must check it names a customer. */
export function originFromState(state: string): string | null {
	const i = state.lastIndexOf('.');
	if (i < 1) return null;
	try {
		const o = new URL(unb64(state.slice(i + 1)));
		return o.protocol === 'https:' && !o.username && !o.password && o.pathname === '/' && !o.search && !o.hash ? o.origin : null;
	} catch {
		return null;
	}
}

/** The customer slug for an instance origin like https://c-abc123.cloud.example.com, given the base domain; null if it does not fit. */
export function slugOfOrigin(origin: string, baseDomain: string): string | null {
	try {
		const h = new URL(origin).hostname.toLowerCase();
		const suffix = '.' + baseDomain.toLowerCase();
		if (!h.endsWith(suffix)) return null;
		const slug = h.slice(0, -suffix.length);
		return /^[a-z0-9][a-z0-9-]{2,40}$/.test(slug) ? slug : null;
	} catch {
		return null;
	}
}
