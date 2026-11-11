import type { Cookies } from '@sveltejs/kit';
import { buildLoginAuthUrl, exchangeLoginCode, newState } from './google';
import { googleLoginLimiter } from './attempts';
import { googleSignIn, linkGoogle } from './selfservice';
import { TeamError } from './users';
import { safeEqual } from './crypto';
import type { CurrentUser } from './roles';

/**
 * "Sign in with Google" for SEOConsole itself: the browser goes to Google, comes back to /login/google/callback with a code, and the
 * person Google names is looked up among the people already set up (selfservice.ts: googleSignIn). Nothing from Google is stored except,
 * for a team member, the stable account ID. It asks Google for "openid email" only, so it never touches Search Console, GA4 or Tag Manager.
 *
 * The start of the flow sets three short-lived cookies: the state (checked on return), where to go afterwards, and, when a signed-in member
 * is linking a Google account from their profile, whose profile it is.
 */
export const GOOGLE_STATE_COOKIE = 'osc_login_state';
export const GOOGLE_NEXT_COOKIE = 'osc_login_next';
export const GOOGLE_LINK_COOKIE = 'osc_login_link';
const ALL = [GOOGLE_STATE_COOKIE, GOOGLE_NEXT_COOKIE, GOOGLE_LINK_COOKIE];

/** What the sign-in page says for each way the Google flow can end without signing anyone in. */
export const GOOGLE_REFUSALS: Record<string, string> = {
	unknown: 'That Google account is not on the team. Ask an admin for an invite to the address you use with Google, or sign in with your email and password.',
	unverified: 'Google has not verified that email address, so it cannot be used to sign in.',
	disabled: 'This team member is disabled. Ask an admin to enable the account.',
	'other-google': 'That email belongs to a team member who signs in with a different Google account.',
	state: 'The Google sign-in expired or was started in another browser. Try again.',
	denied: 'Google sign-in was cancelled.',
	failed: 'Google could not confirm who you are. Try again.',
	toomany: 'Too many Google sign-ins were turned away from your address. Try again in a few minutes.'
};

export function startGoogle(cookies: Cookies, url: URL, o: { next?: string | null; linkUserId?: number | null } = {}): string {
	const state = newState();
	const opts = { path: '/', httpOnly: true, sameSite: 'lax' as const, secure: url.protocol === 'https:', maxAge: 600 };
	cookies.set(GOOGLE_STATE_COOKIE, state, opts);
	cookies.set(GOOGLE_NEXT_COOKIE, o.next ?? '', { ...opts, maxAge: o.next ? 600 : 0 });
	cookies.set(GOOGLE_LINK_COOKIE, o.linkUserId ? String(o.linkUserId) : '', { ...opts, maxAge: o.linkUserId ? 600 : 0 });
	return buildLoginAuthUrl(state);
}

export type GoogleOutcome =
	| { ok: true; kind: 'owner' | 'member'; userId: number | null; next: string | null }
	| { ok: true; kind: 'linked'; userId: number }
	| { ok: false; code: string; message: string; link: boolean };

/** The return from Google. `current` is whoever has a session in this browser (needed only to link). `ip` counts turned-away sign-ins. */
export async function finishGoogle(cookies: Cookies, url: URL, current: CurrentUser | null, ip: string, fetchImpl: typeof fetch = fetch): Promise<GoogleOutcome> {
	const expected = cookies.get(GOOGLE_STATE_COOKIE);
	const next = cookies.get(GOOGLE_NEXT_COOKIE) || null;
	const linkId = Number(cookies.get(GOOGLE_LINK_COOKIE) || 0) || null;
	for (const c of ALL) cookies.delete(c, { path: '/' });
	const no = (code: string): GoogleOutcome => ({ ok: false, code, message: GOOGLE_REFUSALS[code] ?? GOOGLE_REFUSALS.failed, link: !!linkId });
	const state = url.searchParams.get('state') ?? '';
	if (!expected || !safeEqual(state, expected)) return no('state');
	if (googleLoginLimiter.blocked(ip)) return no('toomany');
	if (url.searchParams.get('error')) return no('denied');
	const code = url.searchParams.get('code');
	if (!code) return no('failed');
	let who: { sub: string; email: string; emailVerified: boolean };
	try {
		who = await exchangeLoginCode(code, fetchImpl);
	} catch {
		return no('failed');
	}
	if (linkId) {
		// Linking from a profile: only the member who started it, and only while still signed in as them.
		if (!current || current.id !== linkId) return no('state');
		try {
			linkGoogle(linkId, who.sub);
		} catch (e) {
			return { ok: false, code: 'link', message: e instanceof TeamError ? e.message : GOOGLE_REFUSALS.failed, link: true };
		}
		return { ok: true, kind: 'linked', userId: linkId };
	}
	const r = googleSignIn(who);
	if (r.kind === 'refused') {
		googleLoginLimiter.fail(ip);
		return no(r.reason);
	}
	googleLoginLimiter.clear(ip);
	return { ok: true, kind: r.kind, userId: r.kind === 'member' ? r.user.id : null, next };
}
