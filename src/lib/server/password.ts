import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashes for ADMIN_PASSWORD_HASH, so a deployment never has to hold the login password itself (the cloud control app
 * hashes the password a customer chooses and gives the instance only the hash). Format: scrypt:N:r:p:salt:hash (base64url). Colons, not dollar signs: a $ in an environment value is
 * rewritten by Docker Compose and shells as a variable reference, which would silently corrupt the hash.
 * The cost is Node's own default for scrypt (N=16384, r=8, p=1), which fits in its default memory limit.
 */
const N = 16384, R = 8, P = 1, KEYLEN = 32;
export const MIN_PASSWORD_LENGTH = 12;

export function hashPassword(password: string): string {
	const salt = randomBytes(16);
	const hash = scryptSync(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P });
	return ['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':');
}

export function verifyPassword(password: string, stored: string): boolean {
	const [scheme, n, r, p, salt, hash] = stored.split(':');
	if (scheme !== 'scrypt' || !salt || !hash) return false;
	const params = { N: Number(n), r: Number(r), p: Number(p) };
	// A stored value is read from configuration, but refuse absurd costs rather than let a typo exhaust memory.
	if (![params.N, params.r, params.p].every(Number.isInteger) || params.N < 2 || params.N > 1 << 20 || params.r < 1 || params.r > 32 || params.p < 1 || params.p > 16) return false;
	try {
		const expected = Buffer.from(hash, 'base64url');
		const actual = scryptSync(password.normalize('NFKC'), Buffer.from(salt, 'base64url'), expected.length, { ...params, maxmem: 256 * 1024 * 1024 });
		return expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual);
	} catch {
		return false;
	}
}
