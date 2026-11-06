import { config } from './config';
import { safeEqual } from './crypto';
import { verifyPassword } from './password';

/** Is this the login password? A configured hash (ADMIN_PASSWORD_HASH) wins over a plain ADMIN_PASSWORD; with neither, nothing matches. */
export function checkAdminPassword(candidate: string): boolean {
	const hash = config.adminPasswordHash;
	if (hash) return verifyPassword(candidate, hash);
	const plain = config.adminPassword;
	return !!plain && safeEqual(candidate, plain);
}
