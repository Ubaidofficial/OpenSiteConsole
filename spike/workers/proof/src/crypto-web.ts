/**
 * WebCrypto port of src/lib/server/crypto.ts, wire-compatible with it.
 *
 * Original format:  v1:<iv b64>:<tag b64>:<ciphertext b64>   AES-256-GCM, 12-byte IV, 16-byte tag, key = SHA-256(APP_SECRET)
 * WebCrypto's AES-GCM returns ciphertext||tag as one buffer, so the port splits/joins the last 16 bytes.
 * signValue/verifySigned: HMAC-SHA256 keyed by the same 32-byte digest, base64url, "<value>.<sig>".
 *
 * What does NOT port: the original's fallback that generates a secret file next to the database when APP_SECRET is unset
 * (there is no writable disk on Workers). On Workers APP_SECRET must be a Worker secret; if it is missing the port throws.
 */
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = (u: Uint8Array) => {
	let s = '';
	for (const b of u) s += String.fromCharCode(b);
	return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const b64url = (u: Uint8Array) => b64(u).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s: string) => unb64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));

async function digest(secret: string): Promise<Uint8Array> {
	if (secret.length < 16) throw new Error('APP_SECRET must be set (>= 16 chars) as a Worker secret');
	return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(secret)));
}
const aesKey = async (secret: string) => crypto.subtle.importKey('raw', await digest(secret), 'AES-GCM', false, ['encrypt', 'decrypt']);
const hmacKey = async (secret: string) => crypto.subtle.importKey('raw', await digest(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);

export async function encrypt(secret: string, plain: string): Promise<string> {
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, await aesKey(secret), enc.encode(plain)));
	return ['v1', b64(iv), b64(out.slice(-16)), b64(out.slice(0, -16))].join(':');
}

export async function decrypt(secret: string, blob: string): Promise<string> {
	const [v, iv, tag, ct] = blob.split(':');
	if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unrecognised ciphertext format');
	const joined = new Uint8Array([...unb64(ct), ...unb64(tag)]);
	return dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv), tagLength: 128 }, await aesKey(secret), joined));
}

export async function signValue(secret: string, value: string): Promise<string> {
	return value + '.' + b64url(new Uint8Array(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(value))));
}

/** crypto.subtle.verify compares in constant time, replacing node's timingSafeEqual. */
export async function verifySigned(secret: string, signed: string | undefined): Promise<string | null> {
	if (!signed) return null;
	const i = signed.lastIndexOf('.');
	if (i < 1) return null;
	const value = signed.slice(0, i);
	try {
		return (await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(signed.slice(i + 1)), enc.encode(value))) ? value : null;
	} catch {
		return null;
	}
}
