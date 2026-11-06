// Prints an ADMIN_PASSWORD_HASH for a password read from the terminal (not from a command-line argument, which would sit in the shell history).
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';

const N = 16384, R = 8, P = 1;
const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: process.stdin.isTTY });
rl.question('Password (12 or more characters): ', (pw) => {
	rl.close();
	if (pw.length < 12) {
		console.error('Use at least 12 characters.');
		process.exit(1);
	}
	const salt = randomBytes(16);
	const hash = scryptSync(pw.normalize('NFKC'), salt, 32, { N, r: R, p: P });
	console.log(['scrypt', N, R, P, salt.toString('base64url'), hash.toString('base64url')].join(':'));
});
