import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type CloudConfig } from '../cloud/src/config';
import { CoolifyClient, CoolifyError, type CoolifyApi } from '../cloud/src/coolify';
import { appSecretFor, instanceEnv, instanceOrigin, planFor, Provisioner } from '../cloud/src/provision';
import { createApp, esc } from '../cloud/src/server';
import { openStore, type Store } from '../cloud/src/store';
import { StripeClient, StripeError, verifyWebhook, type StripeEvent } from '../cloud/src/stripe';
import { stateWithOrigin } from '../src/lib/oauthrelay';
import { verifyPassword } from '../src/lib/server/password';

const SECRET = 'whsec_testsecret';
const CFG: CloudConfig = {
	baseUrl: 'https://cloud.example.com', instanceDomain: 'cloud.example.com', secretKey: 'k'.repeat(40),
	stripe: { secretKey: 'sk_test_abc', priceId: 'price_123', webhookSecret: SECRET },
	coolify: { baseUrl: 'https://coolify.example.com', token: '1|supersecrettoken', projectUuid: 'proj', serverUuid: 'srv', environmentName: 'production' },
	repo: { url: 'https://github.com/x/y', branch: 'main', composeLocation: '/compose.coolify.yaml' },
	google: { clientId: 'gid', clientSecret: 'gsecret' }, graceDays: 7, retentionDays: 30, allowDestroy: false, priceLabel: '$10 / month', dbPath: ':memory:', port: 0, trustProxy: false
};
const sign = (body: string, secret = SECRET, t = Math.floor(Date.now() / 1000)) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;

describe('verifyWebhook', () => {
	const body = JSON.stringify({ id: 'evt_1', type: 'x', data: { object: { a: 1 } } });
	const now = Date.now();
	const t = Math.floor(now / 1000);
	const err = (f: () => unknown) => { try { f(); } catch (e) { return e as StripeError; } return null; };
	it('accepts a correctly signed, recent body', () => {
		expect(verifyWebhook(body, sign(body), SECRET, now).id).toBe('evt_1');
	});
	it('refuses a changed body, the wrong secret, a stale or future timestamp, a missing or malformed header', () => {
		expect(err(() => verifyWebhook(body + ' ', sign(body), SECRET, now))?.status).toBe(400);
		expect(err(() => verifyWebhook(body, sign(body, 'whsec_other'), SECRET, now))).not.toBeNull();
		expect(err(() => verifyWebhook(body, sign(body, SECRET, t - 301), SECRET, now))?.message).toMatch(/window/);
		expect(err(() => verifyWebhook(body, sign(body, SECRET, t + 301), SECRET, now))?.message).toMatch(/window/);
		expect(err(() => verifyWebhook(body, sign(body, SECRET, t - 299), SECRET, now))).toBeNull(); // inside the tolerance
		for (const h of [null, '', 'garbage', 't=abc,v1=00', `t=${t}`, `v1=${'0'.repeat(64)}`]) expect(err(() => verifyWebhook(body, h, SECRET, now)), String(h)).not.toBeNull();
	});
	it('only the v1 scheme counts (a v0 signature is ignored), and a rolled secret works while both signatures are sent', () => {
		const good = createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex');
		expect(err(() => verifyWebhook(body, `t=${t},v0=${good}`, SECRET, now))).not.toBeNull();
		expect(err(() => verifyWebhook(body, `t=${t},v1=${'0'.repeat(64)},v1=${good}`, SECRET, now))).toBeNull();
		expect(err(() => verifyWebhook(body, `t=${t},v1=${good.toUpperCase()}`, SECRET, now))).toBeNull();
		expect(err(() => verifyWebhook(body, `t=${t},v1=${good.slice(0, 62)}`, SECRET, now))).not.toBeNull(); // wrong length
	});
	it('refuses a zero tolerance (it would switch the replay check off) and bodies that are not events', () => {
		// timestamp exactly equal to "now": only the zero-tolerance guard itself can refuse this
		const exact = sign(body, SECRET, t);
		expect(err(() => verifyWebhook(body, exact, SECRET, t * 1000, 0))?.message).toMatch(/zero/);
		expect(err(() => verifyWebhook(body, exact, SECRET, t * 1000, 300))).toBeNull();
		const notJson = 'not json';
		expect(err(() => verifyWebhook(notJson, sign(notJson), SECRET, now))?.message).toMatch(/JSON/);
		const notEvent = JSON.stringify({ hello: 1 });
		expect(err(() => verifyWebhook(notEvent, sign(notEvent), SECRET, now))?.message).toMatch(/event/);
	});
});

describe('StripeClient', () => {
	it('creates a subscription checkout with the documented form fields, Bearer key and an idempotency key', async () => {
		let req: { url: string; init: RequestInit } | null = null;
		const c = new StripeClient({ secretKey: 'sk_test_abc', priceId: 'price_123', fetchImpl: (async (url: string, init: RequestInit) => ((req = { url, init }), new Response(JSON.stringify({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/1' }), { status: 200 }))) as never });
		const s = await c.createCheckoutSession({ signupId: 'sig-1', email: 'a@b.co', successUrl: 'https://x/welcome?cs={CHECKOUT_SESSION_ID}', cancelUrl: 'https://x/' });
		expect(s).toEqual({ id: 'cs_test_1', url: 'https://checkout.stripe.com/c/1' });
		expect(req!.url).toBe('https://api.stripe.com/v1/checkout/sessions');
		const h = req!.init.headers as Record<string, string>;
		expect(h.authorization).toBe('Bearer sk_test_abc');
		expect(h['idempotency-key']).toBe('signup-sig-1');
		const p = new URLSearchParams(String(req!.init.body));
		expect(Object.fromEntries(p)).toEqual({
			mode: 'subscription', 'line_items[0][price]': 'price_123', 'line_items[0][quantity]': '1', success_url: 'https://x/welcome?cs={CHECKOUT_SESSION_ID}', cancel_url: 'https://x/',
			client_reference_id: 'sig-1', customer_email: 'a@b.co', 'metadata[signup_id]': 'sig-1', 'subscription_data[metadata][signup_id]': 'sig-1'
		});
	});
	it('errors carry Stripe\'s message but never the secret key; a reply without an address is an error', async () => {
		const bad = new StripeClient({ secretKey: 'sk_test_SECRETVALUE', priceId: 'price_1', fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'No such price' } }), { status: 400 })) as never });
		await expect(bad.createCheckoutSession({ signupId: 's', email: 'a@b.co', successUrl: 'u', cancelUrl: 'u' })).rejects.toThrow(/400.*No such price/);
		await bad.createCheckoutSession({ signupId: 's', email: 'a@b.co', successUrl: 'u', cancelUrl: 'u' }).catch((e) => expect(String(e.message)).not.toContain('SECRETVALUE'));
		const empty = new StripeClient({ secretKey: 'sk_test_a', priceId: 'price_1', fetchImpl: (async () => new Response('{}', { status: 200 })) as never });
		await expect(empty.createCheckoutSession({ signupId: 's', email: 'a@b.co', successUrl: 'u', cancelUrl: 'u' })).rejects.toThrow(/address/);
	});
	it('creates a billing-portal session for a customer', async () => {
		let body = '';
		const c = new StripeClient({ secretKey: 'sk_test_a', priceId: 'p', fetchImpl: (async (u: string, i: RequestInit) => ((body = String(i.body)), new Response(JSON.stringify({ url: 'https://billing.stripe.com/p/1' }), { status: 200 }))) as never });
		expect((await c.createPortalSession('cus_1', 'https://x/')).url).toBe('https://billing.stripe.com/p/1');
		expect(Object.fromEntries(new URLSearchParams(body))).toEqual({ customer: 'cus_1', return_url: 'https://x/' });
	});
});

describe('CoolifyClient', () => {
	const mk = (reply: (u: string, i: RequestInit) => Response, calls: { u: string; i: RequestInit }[] = []) => new CoolifyClient({ ...CFG.coolify, fetchImpl: (async (u: string, i: RequestInit) => (calls.push({ u, i }), reply(u, i))) as never });
	it('uses the documented endpoints, methods and bodies', async () => {
		const calls: { u: string; i: RequestInit }[] = [];
		const c = mk((u) => new Response(JSON.stringify(u.endsWith('/applications/public') ? { uuid: 'app-uuid-1' } : {}), { status: 200 }), calls);
		expect(await c.createApp({ name: 'osc-c-1', repo: 'https://github.com/x/y', branch: 'main', composeLocation: '/compose.coolify.yaml' })).toBe('app-uuid-1');
		await c.setEnv('app-uuid-1', 'ORIGIN', 'https://a');
		await c.setDomain('app-uuid-1', 'opensiteconsole', 'https://a:3000');
		await c.deploy('app-uuid-1');
		await c.start('app-uuid-1');
		await c.stop('app-uuid-1');
		await c.destroy('app-uuid-1');
		const [create, env, dom, dep, start, stop, del] = calls;
		expect([create.i.method, create.u]).toEqual(['POST', 'https://coolify.example.com/api/v1/applications/public']);
		expect(JSON.parse(String(create.i.body))).toMatchObject({ project_uuid: 'proj', server_uuid: 'srv', environment_name: 'production', git_repository: 'https://github.com/x/y', git_branch: 'main', build_pack: 'dockercompose', docker_compose_location: '/compose.coolify.yaml', instant_deploy: false });
		expect([env.i.method, env.u]).toEqual(['POST', 'https://coolify.example.com/api/v1/applications/app-uuid-1/envs']);
		expect(JSON.parse(String(env.i.body))).toEqual({ key: 'ORIGIN', value: 'https://a', is_literal: true, is_shown_once: true });
		expect([dom.i.method, dom.u]).toEqual(['PATCH', 'https://coolify.example.com/api/v1/applications/app-uuid-1']);
		expect(JSON.parse(String(dom.i.body))).toEqual({ docker_compose_domains: [{ name: 'opensiteconsole', domain: 'https://a:3000' }] });
		expect([dep.i.method, dep.u]).toEqual(['POST', 'https://coolify.example.com/api/v1/deploy?uuid=app-uuid-1']);
		expect([start.i.method, start.u]).toEqual(['POST', 'https://coolify.example.com/api/v1/applications/app-uuid-1/start']);
		expect([stop.i.method, stop.u]).toEqual(['POST', 'https://coolify.example.com/api/v1/applications/app-uuid-1/stop']);
		expect(del.i.method).toBe('DELETE');
		expect(del.u).toContain('/applications/app-uuid-1?delete_volumes=true');
		for (const x of calls) {
			expect((x.i.headers as Record<string, string>).authorization).toBe('Bearer 1|supersecrettoken');
			expect(x.i.redirect).toBe('error'); // a redirect must never carry the token to another host
		}
	});
	it('errors never contain the token, and an application id is required', async () => {
		const c = mk(() => new Response(JSON.stringify({ message: 'Unauthenticated.' }), { status: 401 }));
		const e = (await c.createApp({ name: 'n', repo: 'r', branch: 'b', composeLocation: 'c' }).catch((x) => x)) as CoolifyError;
		expect(e).toBeInstanceOf(CoolifyError);
		expect(e.message).toMatch(/401.*Unauthenticated/);
		expect(e.message).not.toContain('supersecret');
		await expect(mk(() => new Response('{}', { status: 201 })).createApp({ name: 'n', repo: 'r', branch: 'b', composeLocation: 'c' })).rejects.toThrow(/application id/);
	});
});

describe('loadConfig', () => {
	const good = {
		CLOUD_BASE_URL: 'https://cloud.example.com/', CLOUD_INSTANCE_DOMAIN: 'Cloud.Example.com', CLOUD_SECRET_KEY: 'k'.repeat(32), STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_PRICE_ID: 'price_1', STRIPE_WEBHOOK_SECRET: 'whsec_x',
		COOLIFY_URL: 'https://coolify.example.com', COOLIFY_TOKEN: 't', COOLIFY_PROJECT_UUID: 'p', COOLIFY_SERVER_UUID: 's', GOOGLE_CLIENT_ID: 'g', GOOGLE_CLIENT_SECRET: 'gs'
	};
	it('reads a complete environment, with safe defaults (destroying instances is OFF)', () => {
		const c = loadConfig(good);
		expect(c.baseUrl).toBe('https://cloud.example.com');
		expect(c.instanceDomain).toBe('cloud.example.com');
		expect(c).toMatchObject({ graceDays: 7, retentionDays: 30, allowDestroy: false, port: 8080, trustProxy: false });
		expect(loadConfig({ ...good, CLOUD_ALLOW_DESTROY: '1' }).allowDestroy).toBe(true);
		expect(loadConfig({ ...good, CLOUD_ALLOW_DESTROY: 'true' }).allowDestroy).toBe(false); // only an explicit 1
	});
	it('lists every problem at once and refuses weak or malformed values', () => {
		expect(() => loadConfig({})).toThrow(/CLOUD_BASE_URL is not set[\s\S]*STRIPE_SECRET_KEY is not set[\s\S]*COOLIFY_TOKEN is not set/);
		for (const [k, v, msg] of [
			['CLOUD_BASE_URL', 'http://cloud.example.com', /https/], ['CLOUD_SECRET_KEY', 'short', /32/], ['STRIPE_SECRET_KEY', 'pk_live_x', /sk_/], ['STRIPE_PRICE_ID', 'prod_1', /price_/],
			['STRIPE_WEBHOOK_SECRET', 'secret', /whsec_/], ['CLOUD_INSTANCE_DOMAIN', 'localhost', /domain/], ['CLOUD_GRACE_DAYS', '-1', /0 to 60/], ['PORT', '70000', /1 to 65535/]
		] as [string, string, RegExp][]) expect(() => loadConfig({ ...good, [k]: v }), k).toThrow(msg);
		expect(() => loadConfig({ ...good, CLOUD_BASE_URL: 'http://localhost:8080' })).not.toThrow();
	});
});

class FakeCoolify implements CoolifyApi {
	calls: string[] = [];
	envs: [string, string][] = [];
	failOn: string | null = null;
	n = 0;
	private hit(name: string) {
		this.calls.push(name);
		if (this.failOn === name) throw new CoolifyError(`boom on ${name}`, 500);
	}
	async createApp() { this.hit('createApp'); return `uuid-${++this.n}`; }
	async setEnv(_u: string, k: string, v: string) { this.hit(`setEnv:${k}`); this.envs.push([k, v]); }
	async setDomain(_u: string, s: string, d: string) { this.hit(`setDomain:${s}:${d}`); }
	async deploy() { this.hit('deploy'); }
	async start() { this.hit('start'); }
	async stop() { this.hit('stop'); }
	async destroy() { this.hit('destroy'); }
}

describe('provisioning and subscription lifecycle', () => {
	let store: Store, coolify: FakeCoolify, prov: Provisioner, t: number, up: boolean, cfg: CloudConfig, evn = 0;
	const hash = 'scrypt:16384:8:1:c2FsdA:aGFzaA';
	const setup = (over: Partial<CloudConfig> = {}) => {
		cfg = { ...CFG, ...over };
		store = openStore(':memory:');
		coolify = new FakeCoolify();
		t = Date.UTC(2026, 10, 6);
		up = false;
		let r = 0;
		prov = new Provisioner({ store, coolify, cfg, now: () => t, health: async () => up, random: () => Buffer.from(Array.from({ length: 8 }, (_, i) => (r + i * 3) % 251)).subarray(0, 8) && (r += 7, Buffer.from(Array.from({ length: 8 }, (_, i) => r + i))) });
	};
	const checkout = (o: Record<string, unknown> = {}, id = `evt_${++evn}`): StripeEvent => ({ id, type: 'checkout.session.completed', data: { object: { id: 'cs_test_abc123', mode: 'subscription', payment_status: 'paid', client_reference_id: 'sig-1', customer: 'cus_1', subscription: 'sub_1', ...o } } });
	const sub = (status: string, type = 'customer.subscription.updated', o: Record<string, unknown> = {}): StripeEvent => ({ id: `evt_${++evn}`, type, data: { object: { id: 'sub_1', status, items: { data: [{ price: { id: 'price_123' } }] }, ...o } } });
	const paid = async () => {
		store.createSignup({ id: 'sig-1', email: 'a@b.co', passwordHash: hash });
		const r = await prov.handleEvent(checkout());
		return r.customerId!;
	};
	beforeEach(() => setup());

	it('a paid checkout creates the instance step by step, with the right settings and no stored password afterwards', async () => {
		const id = await paid();
		const c0 = store.customer(id)!;
		expect(c0).toMatchObject({ status: 'provisioning', email: 'a@b.co', stripe_customer: 'cus_1', stripe_subscription: 'sub_1' });
		expect(c0.slug).toMatch(/^c-[a-z0-9]{8}$/);
		await prov.advance(id);
		const origin = instanceOrigin(cfg, c0.slug);
		expect(coolify.calls).toEqual(['createApp', 'setEnv:ORIGIN', 'setEnv:ADMIN_PASSWORD_HASH', 'setEnv:APP_SECRET', 'setEnv:GOOGLE_CLIENT_ID', 'setEnv:GOOGLE_CLIENT_SECRET', 'setEnv:OAUTH_REDIRECT_URI', `setDomain:opensiteconsole:${origin}:3000`, 'deploy']);
		expect(Object.fromEntries(coolify.envs)).toEqual({ ORIGIN: origin, ADMIN_PASSWORD_HASH: hash, APP_SECRET: appSecretFor(cfg, c0.slug), GOOGLE_CLIENT_ID: 'gid', GOOGLE_CLIENT_SECRET: 'gsecret', OAUTH_REDIRECT_URI: 'https://cloud.example.com/oauth/callback' });
		expect(Object.fromEntries(coolify.envs)).not.toHaveProperty('ADMIN_PASSWORD'); // the plain password never exists here
		expect(store.signup('sig-1')).toMatchObject({ password_hash: '', consumed: 1 });
		expect(store.customer(id)).toMatchObject({ status: 'deploying', env_progress: 6, domain_done: 1, coolify_uuid: 'uuid-1' });
		await prov.reconcile();
		expect(store.customer(id)!.status).toBe('deploying'); // not answering yet
		up = true;
		await prov.reconcile();
		expect(store.customer(id)).toMatchObject({ status: 'active', active_at: t });
	});
	it('instance secrets are derived, differ per customer, and depend on the master key', () => {
		const a = appSecretFor(cfg, 'c-aaaaaaaa'), b = appSecretFor(cfg, 'c-bbbbbbbb');
		expect(a).not.toBe(b);
		expect(a).toBe(appSecretFor(cfg, 'c-aaaaaaaa'));
		expect(a).not.toBe(appSecretFor({ ...cfg, secretKey: 'z'.repeat(40) }, 'c-aaaaaaaa'));
		expect(a.length).toBeGreaterThanOrEqual(32);
		expect(instanceEnv(cfg, 'c-aaaaaaaa', hash).map(([k]) => k)).toEqual(['ORIGIN', 'ADMIN_PASSWORD_HASH', 'APP_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'OAUTH_REDIRECT_URI']);
	});
	it('a failure part-way resumes where it stopped: no second app, no repeated settings', async () => {
		const id = await paid();
		coolify.failOn = 'setEnv:APP_SECRET';
		await prov.advance(id);
		expect(store.customer(id)).toMatchObject({ status: 'failed', attempts: 1, env_progress: 2, coolify_uuid: 'uuid-1' });
		expect(store.customer(id)!.last_error).toMatch(/boom on setEnv:APP_SECRET/);
		coolify.failOn = null;
		await prov.advance(id); // too early: backoff
		expect(coolify.calls.filter((c) => c === 'createApp')).toHaveLength(1);
		expect(store.customer(id)!.status).toBe('failed');
		t += 3 * 60_000;
		await prov.advance(id);
		expect(coolify.calls.filter((c) => c === 'createApp')).toHaveLength(1);
		expect(coolify.calls.filter((c) => c === 'setEnv:ORIGIN')).toHaveLength(1);
		expect(coolify.calls.filter((c) => c === 'setEnv:ADMIN_PASSWORD_HASH')).toHaveLength(1);
		expect(coolify.calls.filter((c) => c === 'setEnv:APP_SECRET')).toHaveLength(2); // the one that failed, then retried
		expect(store.customer(id)).toMatchObject({ status: 'deploying', env_progress: 6 });
		expect(coolify.calls.filter((c) => c === 'deploy')).toHaveLength(1);
	});
	it('gives up after six attempts instead of retrying forever', async () => {
		const id = await paid();
		coolify.failOn = 'createApp';
		for (let i = 0; i < 8; i++) {
			await prov.advance(id);
			t += 2 * 60 * 60_000;
		}
		expect(store.customer(id)).toMatchObject({ status: 'failed', attempts: 6 });
		expect(coolify.calls.filter((c) => c === 'createApp')).toHaveLength(6);
	});
	it('an instance that never comes up is marked failed after 25 minutes and retried', async () => {
		const id = await paid();
		await prov.advance(id);
		t += 24 * 60_000;
		await prov.reconcile();
		expect(store.customer(id)!.status).toBe('deploying');
		t += 2 * 60_000;
		await prov.reconcile();
		expect(store.customer(id)).toMatchObject({ status: 'failed', attempts: 1 });
		expect(store.customer(id)!.last_error).toMatch(/25 minutes/);
	});
	it('ignores what it should: duplicates, unpaid sessions, other modes, unknown sign-ups, other event types', async () => {
		store.createSignup({ id: 'sig-1', email: 'a@b.co', passwordHash: hash });
		const first = checkout({}, 'evt_dup');
		expect((await prov.handleEvent(first)).handled).toBe(true);
		expect(await prov.handleEvent(first)).toMatchObject({ handled: false, note: 'duplicate' });
		expect(store.all()).toHaveLength(1);
		expect((await prov.handleEvent(checkout({ id: 'cs_test_other', payment_status: 'unpaid' }))).note).toBe('not paid yet');
		expect((await prov.handleEvent(checkout({ id: 'cs_test_pay', mode: 'payment' }))).note).toBe('not a subscription');
		expect((await prov.handleEvent(checkout({ id: 'cs_test_x', client_reference_id: 'nope' }))).note).toBe('unknown sign-up');
		expect((await prov.handleEvent(checkout({ id: 'cs_test_abc123' }))).note).toBe('already created'); // same session, new event id
		expect((await prov.handleEvent({ id: 'evt_o', type: 'charge.refunded', data: { object: {} } })).note).toBe('ignored type');
		expect(store.all()).toHaveLength(1);
	});
	it('an event that crashed before it finished is handled again, one that finished is not', async () => {
		store.createSignup({ id: 'sig-1', email: 'a@b.co', passwordHash: hash });
		expect(store.eventSeen('evt_crash', 'checkout.session.completed')).toBe(false); // received, never finished
		expect((await prov.handleEvent(checkout({}, 'evt_crash'))).handled).toBe(true); // second delivery does the work
		expect((await prov.handleEvent(checkout({}, 'evt_crash'))).note).toBe('duplicate');
	});
	it('subscription events: payment trouble keeps it running for the grace period, then suspends; recovery restores it', async () => {
		const id = await paid();
		await prov.advance(id);
		up = true;
		await prov.reconcile();
		await prov.handleEvent(sub('past_due'));
		expect(store.customer(id)).toMatchObject({ status: 'past_due', past_due_since: t, sub_status: 'past_due' });
		expect(coolify.calls).not.toContain('stop');
		t += 6 * 86_400_000;
		await prov.reconcile();
		expect(store.customer(id)!.status).toBe('past_due');
		await prov.handleEvent(sub('active'));
		expect(store.customer(id)).toMatchObject({ status: 'active', past_due_since: null });
		await prov.handleEvent(sub('past_due'));
		t += 8 * 86_400_000;
		await prov.reconcile();
		expect(store.customer(id)!.status).toBe('suspended');
		expect(coolify.calls.filter((c) => c === 'stop')).toHaveLength(1);
		await prov.handleEvent(sub('active'));
		expect(coolify.calls.filter((c) => c === 'start')).toHaveLength(1);
		expect(store.customer(id)!.status).toBe('deploying');
	});
	it('cancelling stops the instance at once and keeps the data for the retention period; deleting happens only when explicitly allowed', async () => {
		const id = await paid();
		await prov.advance(id);
		up = true;
		await prov.reconcile();
		await prov.handleEvent(sub('canceled', 'customer.subscription.deleted'));
		expect(coolify.calls).toContain('stop');
		expect(store.customer(id)).toMatchObject({ status: 'canceled', canceled_at: t, destroy_after: t + 30 * 86_400_000 });
		t += 31 * 86_400_000;
		await prov.reconcile();
		expect(coolify.calls).not.toContain('destroy'); // CLOUD_ALLOW_DESTROY is off
		expect(store.customer(id)!.status).toBe('canceled');
		setup({ allowDestroy: true });
		const id2 = await paid();
		await prov.advance(id2);
		await prov.handleEvent(sub('unpaid'));
		t += 29 * 86_400_000;
		await prov.reconcile();
		expect(coolify.calls).not.toContain('destroy'); // before the retention period ends
		t += 2 * 86_400_000;
		await prov.reconcile();
		expect(coolify.calls).toContain('destroy');
		expect(store.customer(id2)!.status).toBe('destroyed');
		await prov.handleEvent(sub('active')); // a destroyed customer is never revived by a late event
		expect(store.customer(id2)!.status).toBe('destroyed');
		const stops = coolify.calls.filter((c) => c === 'stop').length;
		await prov.handleEvent(sub('canceled')); // nor touched again by a late cancel
		expect(store.customer(id2)!.status).toBe('destroyed');
		expect(coolify.calls.filter((c) => c === 'stop')).toHaveLength(stops);
	});
	it('a returning customer within the retention window gets the instance started again', async () => {
		const id = await paid();
		await prov.advance(id);
		await prov.handleEvent(sub('canceled'));
		await prov.handleEvent(sub('active'));
		expect(coolify.calls.filter((c) => c === 'start')).toHaveLength(1);
		expect(store.customer(id)).toMatchObject({ status: 'deploying', canceled_at: null, destroy_after: null });
	});
	it('a subscription Stripe sends before the checkout event is retried later (an error), another product is ignored, incomplete does nothing', async () => {
		await expect(prov.handleEvent(sub('active'))).rejects.toThrow(/not known yet/);
		expect((await prov.handleEvent({ ...sub('active'), data: { object: { id: 'sub_9', status: 'active', items: { data: [{ price: { id: 'price_other' } }] } } } })).note).toBe('other product');
		const id = await paid();
		await prov.handleEvent(sub('incomplete'));
		expect(store.customer(id)!.status).toBe('provisioning');
		// the failed first attempt must not be recorded as handled, so the redelivery works once the checkout has arrived
		expect(store.all()).toHaveLength(1);
	});
	it('planFor maps every Stripe status', () => {
		expect(['active', 'trialing', 'past_due', 'unpaid', 'canceled', 'incomplete_expired', 'paused', 'incomplete', 'weird'].map(planFor)).toEqual(['run', 'run', 'grace', 'stop', 'stop', 'stop', 'stop', 'ignore', 'ignore']);
	});
	it('the OAuth relay forwards only to a real, running customer instance', async () => {
		const id = await paid();
		const slug = store.customer(id)!.slug;
		const origin = instanceOrigin(cfg, slug);
		expect(prov.relayTarget(stateWithOrigin('s1', origin))).toBeNull(); // still provisioning: not running yet
		await prov.advance(id);
		expect(prov.relayTarget(stateWithOrigin('s1', origin))).toBe(origin);
		for (const bad of ['', 'x', stateWithOrigin('s', 'https://evil.example.com'), stateWithOrigin('s', `https://${slug}.cloud.example.com.evil.com`), stateWithOrigin('s', 'https://c-unknown1.cloud.example.com'), stateWithOrigin('s', `http://${slug}.cloud.example.com`), stateWithOrigin('s', `${origin}/path`)]) expect(prov.relayTarget(bad), bad).toBeNull();
		await prov.handleEvent(sub('canceled'));
		expect(prov.relayTarget(stateWithOrigin('s1', origin))).toBeNull(); // stopped
	});
});

describe('the control app over HTTP', () => {
	let server: Server, base: string, store: Store, prov: Provisioner, kicked: number[], checkoutCalls: { signupId: string; email: string }[], stripeFail: boolean, cfg: CloudConfig, logs: string[];
	const fakeStripe = { createCheckoutSession: async (o: { signupId: string; email: string }) => { checkoutCalls.push(o); if (stripeFail) throw new Error('stripe down'); return { id: 'cs_test_http1234567', url: 'https://checkout.stripe.com/c/pay/cs_test_http1234567' }; } };
	beforeEach(async () => {
		cfg = { ...CFG };
		store = openStore(':memory:');
		kicked = []; checkoutCalls = []; stripeFail = false; logs = [];
		prov = new Provisioner({ store, coolify: new FakeCoolify(), cfg, health: async () => true });
		server = createServer(createApp({ cfg, store, provisioner: prov, stripe: fakeStripe, kick: (id) => kicked.push(id), log: (m) => logs.push(m) }));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	});
	afterEach(() => new Promise<void>((r) => server.close(() => r())));
	const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
	const post = (path: string, body: string, h: Record<string, string> = {}) => fetch(base + path, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded', ...h }, body });
	const good = { email: 'Person@Example.com', password: 'a long password 1', confirm: 'a long password 1' };

	it('shows both options and security headers on every page', async () => {
		const r = await fetch(base + '/');
		const html = await r.text();
		expect(r.status).toBe(200);
		expect(html).toContain('Free');
		expect(html).toContain('$10 / month');
		expect(html).toContain('AGPL');
		expect(r.headers.get('content-security-policy')).toMatch(/default-src 'none'.*form-action 'self' https:\/\/checkout\.stripe\.com.*frame-ancestors 'none'/);
		expect(r.headers.get('x-frame-options')).toBe('DENY');
		expect(r.headers.get('cache-control')).toBe('no-store');
		expect(r.headers.get('strict-transport-security')).toMatch(/max-age/);
		for (const p of ['/healthz', '/nope', '/welcome']) expect((await fetch(base + p, { redirect: 'manual' })).headers.get('x-content-type-options'), p).toBe('nosniff');
		expect((await fetch(base + '/nope')).status).toBe(404);
		expect((await fetch(base + '/healthz')).status).toBe(200);
	});
	it('sign-up stores only a hash, lower-cases the email, and sends the visitor to Stripe', async () => {
		const r = await post('/signup', form(good));
		expect(r.status).toBe(303);
		expect(r.headers.get('location')).toBe('https://checkout.stripe.com/c/pay/cs_test_http1234567');
		expect(checkoutCalls).toHaveLength(1);
		expect(checkoutCalls[0].email).toBe('person@example.com');
		const s = store.signup(checkoutCalls[0].signupId)!;
		expect(s.password_hash).toMatch(/^scrypt:/);
		expect(s.password_hash).not.toContain('a long password');
		expect(verifyPassword('a long password 1', s.password_hash)).toBe(true);
		expect(s.checkout_session_id).toBe('cs_test_http1234567');
	});
	it('rejects bad input without creating anything or echoing the password', async () => {
		for (const [o, msg] of [
			[{ ...good, email: 'not-an-email' }, /valid email/], [{ ...good, email: 'a@b' }, /valid email/], [{ ...good, email: '<script>@x.co' }, /valid email/], [{ ...good, password: 'short', confirm: 'short' }, /at least 12/],
			[{ ...good, confirm: 'different password' }, /do not match/], [{ ...good, password: 'x'.repeat(201), confirm: 'x'.repeat(201) }, /too long/]
		] as [Record<string, string>, RegExp][]) {
			const r = await post('/signup', form(o));
			const html = await r.text();
			expect(r.status).toBe(400);
			expect(html).toMatch(msg);
			expect(html).not.toContain(o.password);
		}
		expect(checkoutCalls).toHaveLength(0);
		expect(store.raw.prepare('SELECT COUNT(*) n FROM signups').get()).toEqual({ n: 0 });
	});
	it('an email is shown back escaped (no markup injection)', async () => {
		const r = await post('/signup', form({ ...good, email: '"><img src=x onerror=1>@x.co', confirm: 'nope' }));
		const html = await r.text();
		expect(html).not.toContain('<img');
		expect(esc('"><img>')).toBe('&quot;&gt;&lt;img&gt;');
	});
	it('refuses sign-ups from another site, with the wrong content type, too large, wrong method', async () => {
		expect((await post('/signup', form(good), { origin: 'https://evil.example' })).status).toBe(403);
		expect((await post('/signup', form(good), { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
		expect((await post('/signup', form(good), { origin: 'https://cloud.example.com' })).status).toBe(303);
		expect((await post('/signup', JSON.stringify(good), { 'content-type': 'application/json' })).status).toBe(415);
		expect((await post('/signup', 'email=' + 'a'.repeat(20_000))).status).toBe(413);
		expect((await fetch(base + '/signup')).status).toBe(405);
		expect(checkoutCalls).toHaveLength(1);
	});
	it('limits sign-ups to five an hour per visitor', async () => {
		const codes: number[] = [];
		for (let i = 0; i < 7; i++) codes.push((await post('/signup', form(good))).status);
		expect(codes).toEqual([303, 303, 303, 303, 303, 429, 429]);
	});
	it('a Stripe outage shows a retry message, not an error page, and logs the cause', async () => {
		stripeFail = true;
		const r = await post('/signup', form(good));
		expect(r.status).toBe(502);
		expect(await r.text()).toMatch(/try again/);
		expect(logs.join(' ')).toMatch(/stripe down/);
	});
	it('webhook: a signed event is processed once, a bad signature is a 400, an event for an unknown subscription is a 500 so Stripe retries', async () => {
		store.createSignup({ id: 'sig-1', email: 'a@b.co', passwordHash: 'scrypt:16384:8:1:c2FsdA:aGFzaA' });
		const ev = JSON.stringify({ id: 'evt_http1', type: 'checkout.session.completed', data: { object: { id: 'cs_test_http1234567', mode: 'subscription', payment_status: 'paid', client_reference_id: 'sig-1', customer: 'cus_1', subscription: 'sub_1' } } });
		const wh = (body: string, sig: string | null) => fetch(base + '/stripe/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(sig ? { 'stripe-signature': sig } : {}) }, body });
		expect((await wh(ev, null)).status).toBe(400);
		expect((await wh(ev, sign(ev, 'whsec_wrong'))).status).toBe(400);
		expect((await wh(ev + ' ', sign(ev))).status).toBe(400);
		expect(store.all()).toHaveLength(0);
		expect((await wh(ev, sign(ev))).status).toBe(200);
		expect(store.all()).toHaveLength(1);
		expect(kicked).toEqual([store.all()[0].id]);
		expect((await wh(ev, sign(ev))).status).toBe(200); // redelivery
		expect(store.all()).toHaveLength(1);
		expect(kicked).toHaveLength(1);
		const early = JSON.stringify({ id: 'evt_http2', type: 'customer.subscription.updated', data: { object: { id: 'sub_unknown', status: 'active', items: { data: [{ price: { id: 'price_123' } }] } } } });
		expect((await wh(early, sign(early))).status).toBe(500);
		expect((await fetch(base + '/stripe/webhook')).status).toBe(405);
		expect((await fetch(base + '/stripe/webhook', { method: 'POST', body: 'x'.repeat(1_100_000), headers: { 'stripe-signature': 't=1,v1=00' } })).status).toBe(413);
	});
	it('the welcome page follows the customer: confirming, setting up, ready, trouble; and shows nothing for a bad id', async () => {
		const cs = 'cs_test_welcome12345';
		expect(await (await fetch(`${base}/welcome?cs=${cs}`)).text()).toMatch(/Confirming your payment/);
		store.createSignup({ id: 'sig-w', email: 'a@b.co', passwordHash: 'h' });
		const c = store.createCustomer({ signupId: 'sig-w', email: 'a@b.co', stripeCustomer: 'cus', stripeSubscription: 'sub', checkoutSessionId: cs, slug: 'c-welcome1' });
		const view = async () => (await fetch(`${base}/welcome?cs=${cs}`)).text();
		expect(await view()).toMatch(/Setting up your instance/);
		store.update(c.id, { status: 'deploying' });
		expect(await view()).toMatch(/Setting up your instance/);
		store.update(c.id, { status: 'active' });
		const ready = await view();
		expect(ready).toContain('https://c-welcome1.cloud.example.com');
		expect(ready).toMatch(/password you chose/);
		store.update(c.id, { status: 'failed', last_error: 'secret internal detail' });
		const failed = await view();
		expect(failed).toMatch(/Still working on it/);
		expect(failed).not.toContain('secret internal detail');
		for (const bad of ['', 'x', 'cs_live_', '../../etc', `cs_test_${'a'.repeat(300)}`]) {
			const r = await fetch(`${base}/welcome?cs=${encodeURIComponent(bad)}`, { redirect: 'manual' });
			expect(r.status, bad).toBe(303);
		}
	});
	it('the OAuth relay forwards Google\'s answer to a real instance and refuses everything else', async () => {
		store.createSignup({ id: 'sig-r', email: 'a@b.co', passwordHash: 'h' });
		const c = store.createCustomer({ signupId: 'sig-r', email: 'a@b.co', stripeCustomer: 'cus', stripeSubscription: 'sub', checkoutSessionId: 'cs_test_relay12345', slug: 'c-relay123' });
		store.update(c.id, { status: 'active' });
		const state = stateWithOrigin('nonce', 'https://c-relay123.cloud.example.com');
		const r = await fetch(`${base}/oauth/callback?code=4/abc&state=${encodeURIComponent(state)}&scope=email&injected=1&authuser=0`, { redirect: 'manual' });
		expect(r.status).toBe(302);
		const loc = new URL(r.headers.get('location')!);
		expect(loc.origin).toBe('https://c-relay123.cloud.example.com');
		expect(loc.pathname).toBe('/auth/callback');
		expect(Object.fromEntries(loc.searchParams)).toEqual({ code: '4/abc', state, scope: 'email', authuser: '0' }); // nothing extra is passed on
		for (const bad of [stateWithOrigin('n', 'https://evil.example.com'), stateWithOrigin('n', 'https://c-nobody1.cloud.example.com'), 'plain', '', 'x'.repeat(3000)]) {
			const x = await fetch(`${base}/oauth/callback?code=1&state=${encodeURIComponent(bad)}`, { redirect: 'manual' });
			expect(x.status, bad.slice(0, 20)).toBe(400);
			expect(x.headers.get('location')).toBeNull();
		}
		expect((await fetch(`${base}/oauth/callback`, { redirect: 'manual' })).status).toBe(400);
		expect((await fetch(`${base}/oauth/callback`, { method: 'POST' })).status).toBe(405);
	});
	it('behind a trusted proxy the sign-up limit counts the visitor the proxy saw, not a header they invented', async () => {
		await new Promise<void>((r) => server.close(() => r()));
		cfg = { ...CFG, trustProxy: true };
		server = createServer(createApp({ cfg, store, provisioner: prov, stripe: fakeStripe, kick: () => {} }));
		await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const codes: number[] = [];
		for (let i = 0; i < 7; i++) codes.push((await post('/signup', form(good), { 'x-forwarded-for': `10.9.8.${i}, 203.0.113.7` })).status); // the proxy appended the real address last
		expect(codes).toEqual([303, 303, 303, 303, 303, 429, 429]);
		expect((await post('/signup', form(good), { 'x-forwarded-for': '203.0.113.8' })).status).toBe(303); // a different real visitor
	});
});
