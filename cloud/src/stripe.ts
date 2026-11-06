import { createHmac, timingSafeEqual } from 'node:crypto';

/** The few Stripe calls the control app needs, written against Stripe's documented HTTP API (form-encoded requests, Bearer key). */
export interface StripeEvent {
	id: string;
	type: string;
	data: { object: Record<string, any> };
}

export class StripeError extends Error {
	constructor(message: string, readonly status = 0) {
		super(message);
	}
}

export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * Check a webhook the way Stripe documents it: the Stripe-Signature header holds t=<timestamp> and one or more v1=<signature>; the
 * signature is HMAC-SHA256 over "<t>.<raw body>" with the endpoint secret, compared in constant time, and a timestamp more than
 * five minutes off is refused (a replay). Only v1 counts. The body must be the raw text exactly as received.
 */
export function verifyWebhook(rawBody: string, header: string | null | undefined, secret: string, nowMs = Date.now(), toleranceSeconds = WEBHOOK_TOLERANCE_SECONDS): StripeEvent {
	if (!header) throw new StripeError('Missing Stripe-Signature header', 400);
	let t: string | null = null;
	const sigs: string[] = [];
	for (const part of header.split(',')) {
		const i = part.indexOf('=');
		if (i < 1) continue;
		const k = part.slice(0, i).trim();
		const v = part.slice(i + 1).trim();
		if (k === 't') t = v;
		else if (k === 'v1') sigs.push(v);
	}
	if (!t || !/^\d+$/.test(t) || !sigs.length) throw new StripeError('Malformed Stripe-Signature header', 400);
	if (!Number.isFinite(toleranceSeconds) || toleranceSeconds <= 0) throw new StripeError('A tolerance of zero would switch the replay check off', 500);
	if (Math.abs(nowMs / 1000 - Number(t)) > toleranceSeconds) throw new StripeError('Webhook timestamp is outside the allowed window', 400);
	const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
	const ok = sigs.some((s) => {
		if (!/^[0-9a-f]{64}$/i.test(s)) return false;
		const actual = Buffer.from(s, 'hex');
		return actual.length === expected.length && timingSafeEqual(actual, expected);
	});
	if (!ok) throw new StripeError('Webhook signature does not match', 400);
	let event: StripeEvent;
	try {
		event = JSON.parse(rawBody) as StripeEvent;
	} catch {
		throw new StripeError('Webhook body is not JSON', 400);
	}
	if (!event || typeof event.id !== 'string' || typeof event.type !== 'string' || !event.data?.object) throw new StripeError('Webhook body is not an event', 400);
	return event;
}

export interface StripeClientConfig { secretKey: string; priceId: string; fetchImpl?: typeof fetch }

export class StripeClient {
	constructor(private cfg: StripeClientConfig) {}

	private async post(path: string, body: URLSearchParams, idempotencyKey?: string): Promise<Record<string, any>> {
		const f = this.cfg.fetchImpl ?? fetch;
		const res = await f(`https://api.stripe.com/v1${path}`, {
			method: 'POST',
			headers: { authorization: `Bearer ${this.cfg.secretKey}`, 'content-type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) },
			body: body.toString(),
			signal: AbortSignal.timeout(20_000)
		});
		const json = (await res.json().catch(() => ({}))) as Record<string, any>;
		if (!res.ok) throw new StripeError(`Stripe refused the request (${res.status}): ${String(json?.error?.message ?? 'no detail').slice(0, 200)}`, res.status);
		return json;
	}

	/** A hosted Checkout page for the monthly subscription. `signupId` comes back as client_reference_id on the completed session. */
	async createCheckoutSession(o: { signupId: string; email: string; successUrl: string; cancelUrl: string }): Promise<{ id: string; url: string }> {
		const p = new URLSearchParams();
		p.set('mode', 'subscription');
		p.set('line_items[0][price]', this.cfg.priceId);
		p.set('line_items[0][quantity]', '1');
		p.set('success_url', o.successUrl);
		p.set('cancel_url', o.cancelUrl);
		p.set('client_reference_id', o.signupId);
		p.set('customer_email', o.email);
		p.set('metadata[signup_id]', o.signupId);
		p.set('subscription_data[metadata][signup_id]', o.signupId);
		const s = await this.post('/checkout/sessions', p, `signup-${o.signupId}`);
		if (typeof s.id !== 'string' || typeof s.url !== 'string') throw new StripeError('Stripe did not return a checkout address');
		return { id: s.id, url: s.url };
	}

	/** A link to Stripe's hosted billing portal (update card, cancel). The portal must be configured in the Stripe dashboard first. */
	async createPortalSession(customerId: string, returnUrl: string): Promise<{ url: string }> {
		const p = new URLSearchParams({ customer: customerId, return_url: returnUrl });
		const s = await this.post('/billing_portal/sessions', p);
		if (typeof s.url !== 'string') throw new StripeError('Stripe did not return a portal address');
		return { url: s.url };
	}
}
