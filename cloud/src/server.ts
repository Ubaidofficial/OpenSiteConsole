import { randomUUID } from 'node:crypto';
import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http';
import type { CloudConfig } from './config';
import type { Provisioner } from './provision';
import type { Store } from './store';
import { StripeError, verifyWebhook, type StripeEvent } from './stripe';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../../src/lib/server/password';

export interface Checkout {
	createCheckoutSession(o: { signupId: string; email: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }>;
}

export interface AppDeps {
	cfg: CloudConfig;
	store: Store;
	provisioner: Provisioner;
	stripe: Checkout;
	/** start creating a customer's instance without making the webhook wait (replaceable in tests) */
	kick?: (customerId: number) => void;
	now?: () => number;
	log?: (msg: string) => void;
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SIGNUPS_PER_HOUR = 5;
const FORM_LIMIT = 8 * 1024;
const WEBHOOK_LIMIT = 1024 * 1024;
const EMAIL = /^[^\s@<>"'`,;:\\]{1,64}@[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

class TooLarge extends Error {}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
	const declared = Number(req.headers['content-length'] ?? 0);
	if (declared > limit) throw new TooLarge();
	const chunks: Buffer[] = [];
	let n = 0;
	for await (const c of req) {
		n += (c as Buffer).length;
		if (n > limit) throw new TooLarge();
		chunks.push(c as Buffer);
	}
	return Buffer.concat(chunks).toString('utf8');
}

export function createApp(deps: AppDeps): RequestListener {
	const { cfg, store, provisioner, stripe } = deps;
	const now = deps.now ?? Date.now;
	const baseOrigin = new URL(cfg.baseUrl).origin;
	const attempts = new Map<string, number[]>();

	const headers = (extra: Record<string, string> = {}) => ({
		'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://checkout.stripe.com; base-uri 'none'; frame-ancestors 'none'",
		'x-content-type-options': 'nosniff',
		'x-frame-options': 'DENY',
		'referrer-policy': 'no-referrer',
		'cache-control': 'no-store',
		...(baseOrigin.startsWith('https:') ? { 'strict-transport-security': 'max-age=15552000' } : {}),
		...extra
	});
	const send = (res: ServerResponse, status: number, body: string, extra: Record<string, string> = {}) => {
		res.writeHead(status, headers({ 'content-type': 'text/html; charset=utf-8', ...extra }));
		res.end(body);
	};
	const json = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, headers({ 'content-type': 'application/json' }));
		res.end(JSON.stringify(body));
	};
	const redirect = (res: ServerResponse, status: 302 | 303, to: string) => {
		res.writeHead(status, headers({ location: to }));
		res.end();
	};

	const clientIp = (req: IncomingMessage) => {
		if (cfg.trustProxy) {
			const xff = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
			if (xff.length) return xff[xff.length - 1]; // the address the trusted proxy saw, not anything the visitor added in front
		}
		return req.socket.remoteAddress ?? 'unknown';
	};
	const limited = (ip: string) => {
		const t = now();
		const recent = (attempts.get(ip) ?? []).filter((x) => t - x < 3_600_000);
		if (recent.length >= SIGNUPS_PER_HOUR) {
			attempts.set(ip, recent);
			return true;
		}
		recent.push(t);
		attempts.set(ip, recent);
		if (attempts.size > 5000) for (const [k, v] of attempts) if (!v.some((x) => t - x < 3_600_000)) attempts.delete(k);
		return false;
	};

	const page = (title: string, body: string, refresh = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${refresh ? '<meta http-equiv="refresh" content="5">' : ''}<title>${esc(title)}</title>
<style>:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fafaf9;color:#171717;font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:760px;margin:0 auto;padding:40px 20px}h1{font-size:28px;margin:0 0 6px}h2{font-size:18px;margin:0 0 8px}p{margin:0 0 12px;color:#404040}.sub{color:#737373}.grid{display:grid;grid-template-columns:1fr;gap:16px;margin:28px 0}@media(min-width:640px){.grid{grid-template-columns:1fr 1fr}}.card{background:#fff;border:1px solid #e5e5e5;border-radius:14px;padding:20px}.price{font-size:26px;font-weight:600;margin:4px 0 12px}ul{margin:0 0 14px;padding-left:20px;color:#404040}li{margin:4px 0}label{display:block;font-size:14px;font-weight:600;margin:12px 0 4px}input{width:100%;padding:10px 12px;border:1px solid #d4d4d4;border-radius:10px;font:inherit}button,.btn{display:inline-block;margin-top:14px;padding:11px 18px;border:0;border-radius:10px;background:#171717;color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b;padding:10px 12px;border-radius:10px;margin:12px 0}.small{font-size:13px;color:#737373}a{color:#1d4ed8}</style></head><body><main>${body}</main></body></html>`;

	const home = (error = '', email = '') => page('OpenSiteConsole', `
<h1>OpenSiteConsole</h1>
<p class="sub">Your Google Search Console, GA4, Bing and Clarity data in one place, with a ranked list of what to fix first.</p>
<div class="grid">
<section class="card"><h2>Self-host</h2><div class="price">Free</div><ul><li>Run it on your own server or computer</li><li>Your data never leaves your machine</li><li>Open source (AGPL-3.0)</li></ul><a class="btn" href="https://github.com/Ubaidofficial/OpenSiteConsole">Get the code</a></section>
<section class="card"><h2>Cloud</h2><div class="price">${esc(cfg.priceLabel)}</div><ul><li>Your own private instance and database, run for you</li><li>Always on, with HTTPS and updates</li><li>Cancel any time; your data is kept ${cfg.retentionDays} days after you stop</li></ul>
<form method="post" action="/signup">${error ? `<div class="err" role="alert">${esc(error)}</div>` : ''}
<label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required maxlength="254" value="${esc(email)}">
<label for="password">Choose a password for your instance (${MIN_PASSWORD_LENGTH}+ characters)</label><input id="password" name="password" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="200">
<label for="confirm">Repeat the password</label><input id="confirm" name="confirm" type="password" autocomplete="new-password" required minlength="${MIN_PASSWORD_LENGTH}" maxlength="200">
<button type="submit">Continue to payment</button><p class="small">Payment is handled by Stripe. We never see your card, and we store only a hash of your password.</p></form></section>
</div>`);

	const welcome = (cs: string) => {
		const c = store.customerBySession(cs);
		if (!c) return page('Confirming payment', `<h1>Confirming your payment…</h1><p>This page refreshes by itself.</p>`, true);
		if (c.status === 'active') return page('Your instance is ready', `<h1>Your instance is ready</h1><p>Open it and sign in with the password you chose.</p><a class="btn" href="https://${esc(c.slug)}.${esc(cfg.instanceDomain)}">Open my instance</a><p class="small">Bookmark that address. Then connect your Google account from the Accounts page.</p>`);
		if (c.status === 'provisioning' || c.status === 'deploying') return page('Setting up', `<h1>Setting up your instance…</h1><p>This usually takes a few minutes. This page refreshes by itself.</p>`, true);
		if (c.status === 'failed') return page('Still working on it', `<h1>Still working on it</h1><p>Your payment went through, but your instance is taking longer than expected. We keep retrying automatically; reply to your receipt email if it is not ready within the hour.</p>`);
		return page('Subscription', `<h1>Subscription</h1><p>This subscription is not active.</p>`);
	};

	return async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', baseOrigin);
			const path = url.pathname;
			const method = req.method ?? 'GET';

			if (path === '/healthz') return json(res, 200, { ok: true });

			if (path === '/' ) return method === 'GET' ? send(res, 200, home()) : send(res, 405, page('Method not allowed', '<h1>Not allowed</h1>'), { allow: 'GET' });

			if (path === '/welcome') {
				const cs = url.searchParams.get('cs') ?? '';
				if (method !== 'GET') return send(res, 405, page('Method not allowed', '<h1>Not allowed</h1>'), { allow: 'GET' });
				if (!/^cs_(test|live)_[A-Za-z0-9]{10,200}$/.test(cs)) return redirect(res, 303, '/');
				return send(res, 200, welcome(cs));
			}

			if (path === '/signup') {
				if (method !== 'POST') return send(res, 405, page('Method not allowed', '<h1>Not allowed</h1>'), { allow: 'POST' });
				// A form from another site must not be able to start sign-ups on a visitor's behalf.
				const origin = req.headers.origin;
				if ((origin && origin !== baseOrigin) || req.headers['sec-fetch-site'] === 'cross-site') return send(res, 403, page('Not allowed', '<h1>Not allowed</h1><p>Start from the sign-up page.</p>'));
				if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) return send(res, 415, page('Unsupported', '<h1>Unsupported</h1>'));
				let form: URLSearchParams;
				try {
					form = new URLSearchParams(await readBody(req, FORM_LIMIT));
				} catch (e) {
					if (e instanceof TooLarge) return send(res, 413, page('Too large', '<h1>Request too large</h1>'));
					throw e;
				}
				const email = (form.get('email') ?? '').trim().toLowerCase();
				const password = form.get('password') ?? '';
				const confirm = form.get('confirm') ?? '';
				const problem =
					email.length > 254 || !EMAIL.test(email) ? 'Enter a valid email address.'
					: password.length < MIN_PASSWORD_LENGTH ? `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`
					: password.length > 200 ? 'That password is too long.'
					: password !== confirm ? 'The two passwords do not match.'
					: '';
				if (problem) return send(res, 400, home(problem, email.slice(0, 254)));
				// Only attempts that would really start a payment count (typos do not), and each one costs a password hash and a Stripe call.
				if (limited(clientIp(req))) return send(res, 429, page('Slow down', '<h1>Too many attempts</h1><p>Please try again in an hour.</p>'), { 'retry-after': '3600' });
				const id = randomUUID();
				store.createSignup({ id, email, passwordHash: hashPassword(password) });
				try {
					const s = await stripe.createCheckoutSession({ signupId: id, email, successUrl: `${cfg.baseUrl}/welcome?cs={CHECKOUT_SESSION_ID}`, cancelUrl: `${cfg.baseUrl}/` });
					store.attachCheckout(id, s.id);
					return redirect(res, 303, s.url);
				} catch (e) {
					deps.log?.(`checkout creation failed: ${e instanceof Error ? e.message : String(e)}`);
					return send(res, 502, home('We could not start the payment page. Please try again in a moment.', email));
				}
			}

			if (path === '/stripe/webhook') {
				if (method !== 'POST') return json(res, 405, { error: 'POST only' });
				let raw: string;
				try {
					raw = await readBody(req, WEBHOOK_LIMIT);
				} catch (e) {
					if (e instanceof TooLarge) return json(res, 413, { error: 'too large' });
					throw e;
				}
				let event: StripeEvent;
				try {
					event = verifyWebhook(raw, String(req.headers['stripe-signature'] ?? ''), cfg.stripe.webhookSecret, now());
				} catch (e) {
					return json(res, e instanceof StripeError ? e.status || 400 : 400, { error: 'invalid signature' });
				}
				try {
					const r = await provisioner.handleEvent(event);
					if (r.handled && r.customerId && deps.kick) deps.kick(r.customerId);
					return json(res, 200, { received: true });
				} catch (e) {
					deps.log?.(`webhook ${event.type} ${event.id} will be retried by Stripe: ${e instanceof Error ? e.message : String(e)}`);
					return json(res, 500, { error: 'try again later' }); // not 2xx: Stripe redelivers
				}
			}

			if (path === '/oauth/callback') {
				if (method !== 'GET') return send(res, 405, page('Method not allowed', '<h1>Not allowed</h1>'), { allow: 'GET' });
				const state = url.searchParams.get('state') ?? '';
				const target = state.length <= 2000 ? provisioner.relayTarget(state) : null;
				if (!target) return send(res, 400, page('Unknown instance', '<h1>We could not find that instance</h1><p>Start the Google connection again from your instance.</p>'));
				// Pass on only what Google sends back, and only to an instance that really belongs to a customer.
				const out = new URLSearchParams();
				for (const k of ['code', 'state', 'scope', 'error', 'authuser', 'prompt']) {
					const v = url.searchParams.get(k);
					if (v !== null && v.length <= 4096) out.set(k, v);
				}
				return redirect(res, 302, `${target}/auth/callback?${out.toString()}`);
			}

			return send(res, 404, page('Not found', '<h1>Not found</h1>'));
		} catch (e) {
			deps.log?.(`request failed: ${e instanceof Error ? e.message : String(e)}`);
			if (!res.headersSent) send(res, 500, page('Error', '<h1>Something went wrong</h1>'));
		}
	};
}
