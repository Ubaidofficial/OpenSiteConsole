/**
 * Counts failed attempts per visitor (the sign-in form, invite links): after `max` failures within `windowMs` the visitor is refused until the
 * window ends. A success clears the count. Kept in memory, like the other limits: a restart forgets it.
 */
export class FailureLimiter {
	private attempts = new Map<string, { n: number; reset: number }>();
	constructor(
		private max = 5,
		private windowMs = 15 * 60_000,
		private maxTracked = 5000
	) {}

	/** Forget expired entries; if an attacker still fills the table, start over rather than grow without bound. */
	private prune(now: number) {
		if (this.attempts.size < this.maxTracked) return;
		for (const [k, v] of this.attempts) if (v.reset <= now) this.attempts.delete(k);
		if (this.attempts.size >= this.maxTracked) this.attempts.clear();
	}

	blocked(key: string, now = Date.now()): boolean {
		this.prune(now);
		const a = this.attempts.get(key);
		return !!a && a.reset > now && a.n >= this.max;
	}

	fail(key: string, now = Date.now()) {
		const a = this.attempts.get(key);
		const cur = a && a.reset > now ? a : { n: 0, reset: now + this.windowMs };
		this.attempts.set(key, { n: cur.n + 1, reset: cur.reset });
	}

	clear(key: string) {
		this.attempts.delete(key);
	}

	reset() {
		this.attempts.clear();
	}
}

/** Sign-in: 5 wrong passwords per visitor per 15 minutes. */
export const loginLimiter = new FailureLimiter(5, 15 * 60_000);
/** Invite links: 10 unknown, used or expired links (or refused acceptances) per visitor per 15 minutes. */
export const inviteLimiter = new FailureLimiter(10, 15 * 60_000);
/** Password reset links: 10 unknown, used or expired links per visitor per 15 minutes. */
export const resetLimiter = new FailureLimiter(10, 15 * 60_000);
/** Someone signed in re-typing their current password to change their email or password: 5 wrong tries per member per 15 minutes. */
export const profileLimiter = new FailureLimiter(5, 15 * 60_000);
/** Google sign-ins that were turned away (not on the team, unverified, disabled): 10 per visitor per 15 minutes. */
export const googleLoginLimiter = new FailureLimiter(10, 15 * 60_000);
