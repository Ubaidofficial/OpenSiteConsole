import { createHmac, randomBytes } from 'node:crypto';
import type { CloudConfig } from './config';
import type { CoolifyApi } from './coolify';
import type { Customer, Store } from './store';
import type { StripeEvent } from './stripe';
import { originFromState, slugOfOrigin } from '../../src/lib/oauthrelay';

const SERVICE = 'opensiteconsole'; // the service name in compose.coolify.yaml
const MAX_ATTEMPTS = 6;
const DEPLOY_TIMEOUT_MS = 25 * 60_000;
const DAY = 86_400_000;

export interface Deps {
	store: Store;
	coolify: CoolifyApi;
	cfg: CloudConfig;
	now?: () => number;
	/** is the instance answering? default: GET <origin>/login returns 200 */
	health?: (origin: string) => Promise<boolean>;
	/** random slug source, replaceable in tests */
	random?: (n: number) => Buffer;
	log?: (msg: string) => void;
}

/** What a Stripe subscription status means for the instance. */
export function planFor(subStatus: string): 'run' | 'grace' | 'stop' | 'ignore' {
	switch (subStatus) {
		case 'active':
		case 'trialing':
			return 'run';
		case 'past_due':
			return 'grace'; // payment failed, Stripe is retrying: keep it running for a grace period
		case 'unpaid':
		case 'canceled':
		case 'incomplete_expired':
		case 'paused':
			return 'stop';
		default:
			return 'ignore'; // incomplete: the first payment has not gone through yet
	}
}

export const instanceOrigin = (cfg: CloudConfig, slug: string) => `https://${slug}.${cfg.instanceDomain}`;

/** Each instance's APP_SECRET, derived from the master key so it is never stored and always reproducible. */
export const appSecretFor = (cfg: CloudConfig, slug: string) => createHmac('sha256', cfg.secretKey).update('instance-app-secret:' + slug).digest('base64url');

/** The settings every instance is created with, in the order they are stored. */
export function instanceEnv(cfg: CloudConfig, slug: string, passwordHash: string): [string, string][] {
	return [
		['ORIGIN', instanceOrigin(cfg, slug)],
		['ADMIN_PASSWORD_HASH', passwordHash],
		['APP_SECRET', appSecretFor(cfg, slug)],
		['GOOGLE_CLIENT_ID', cfg.google.clientId],
		['GOOGLE_CLIENT_SECRET', cfg.google.clientSecret],
		['OAUTH_REDIRECT_URI', `${cfg.baseUrl}/oauth/callback`]
	];
}

const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // no look-alike characters

export class Provisioner {
	private now: () => number;
	constructor(private d: Deps) {
		this.now = d.now ?? Date.now;
	}
	private log = (m: string) => this.d.log?.(m);

	private newSlug(): string {
		for (let i = 0; i < 20; i++) {
			const bytes = (this.d.random ?? randomBytes)(8);
			const slug = 'c-' + Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
			if (!this.d.store.customerBySlug(slug)) return slug;
		}
		throw new Error('Could not find a free customer address');
	}

	/** One Stripe event. Throws only when Stripe should try again later (a 5xx answer); everything else returns normally. */
	async handleEvent(e: StripeEvent): Promise<{ handled: boolean; note?: string; customerId?: number }> {
		const { store } = this.d;
		if (store.eventSeen(e.id, e.type)) return { handled: false, note: 'duplicate' };
		let out: { handled: boolean; note?: string; customerId?: number };
		switch (e.type) {
			case 'checkout.session.completed':
			case 'checkout.session.async_payment_succeeded':
				out = this.onCheckout(e.data.object);
				break;
			case 'customer.subscription.updated':
			case 'customer.subscription.deleted':
				out = await this.onSubscription(e.data.object, e.type === 'customer.subscription.deleted');
				break;
			default:
				out = { handled: false, note: 'ignored type' };
		}
		store.eventDone(e.id);
		return out;
	}

	private onCheckout(s: Record<string, any>): { handled: boolean; note?: string; customerId?: number } {
		const { store } = this.d;
		if (s.mode !== 'subscription') return { handled: false, note: 'not a subscription' };
		if (s.payment_status !== 'paid' && s.payment_status !== 'no_payment_required') return { handled: false, note: 'not paid yet' };
		const signupId = String(s.client_reference_id ?? s.metadata?.signup_id ?? '');
		const signup = signupId ? store.signup(signupId) : undefined;
		const sessionId = String(s.id ?? '');
		const existing = store.customerBySession(sessionId);
		if (existing) return { handled: false, note: 'already created', customerId: existing.id };
		if (!signup) {
			this.log(`checkout ${sessionId} paid but no matching sign-up: needs a manual look (and maybe a refund)`);
			return { handled: false, note: 'unknown sign-up' };
		}
		const customer = String(s.customer ?? '');
		const subscription = String(s.subscription ?? '');
		if (!customer || !subscription) return { handled: false, note: 'no customer or subscription on the session' };
		const c = store.createCustomer({ signupId: signup.id, email: signup.email, stripeCustomer: customer, stripeSubscription: subscription, checkoutSessionId: sessionId, slug: this.newSlug() });
		return { handled: true, customerId: c.id };
	}

	private async onSubscription(sub: Record<string, any>, deleted: boolean): Promise<{ handled: boolean; note?: string; customerId?: number }> {
		const { store, cfg } = this.d;
		// Only our own product: other prices in the same Stripe account are none of our business.
		const prices: string[] = (sub.items?.data ?? []).map((i: any) => i?.price?.id).filter(Boolean);
		if (prices.length && !prices.includes(cfg.stripe.priceId)) return { handled: false, note: 'other product' };
		const c = store.customerBySubscription(String(sub.id ?? ''));
		// Stripe does not promise order: the subscription event can beat the checkout event. Ask Stripe to send it again later.
		if (!c) throw new Error(`subscription ${String(sub.id)} is not known yet; retry later`);
		const status = deleted ? 'canceled' : String(sub.status ?? '');
		store.update(c.id, { sub_status: status });
		await this.apply(c.id, planFor(status));
		return { handled: true, customerId: c.id };
	}

	/** Bring the instance in line with what the subscription now allows. Safe to repeat. */
	async apply(id: number, plan: 'run' | 'grace' | 'stop' | 'ignore') {
		const { store, coolify, cfg } = this.d;
		const c = store.customer(id)!;
		const t = this.now();
		if (plan === 'ignore' || c.status === 'destroyed') return;
		if (plan === 'run') {
			if (c.status === 'past_due') store.update(id, { status: 'active', past_due_since: null });
			else if ((c.status === 'suspended' || c.status === 'canceled') && c.coolify_uuid) {
				await coolify.start(c.coolify_uuid);
				store.update(id, { status: 'deploying', deployed_at: t, past_due_since: null, canceled_at: null, destroy_after: null, attempts: 0, last_error: null });
			}
			return;
		}
		if (plan === 'grace') {
			if (c.status === 'active') store.update(id, { status: 'past_due', past_due_since: t });
			return;
		}
		// stop
		if (c.status === 'suspended' || c.status === 'canceled') return;
		if (c.coolify_uuid) await coolify.stop(c.coolify_uuid);
		store.update(id, { status: 'canceled', canceled_at: t, destroy_after: t + cfg.retentionDays * DAY });
	}

	/** Move one customer's creation along: each step is recorded, so a failure resumes where it stopped. */
	async advance(id: number): Promise<void> {
		const { store, coolify, cfg } = this.d;
		let c = store.customer(id);
		if (!c || (c.status !== 'provisioning' && c.status !== 'failed')) return;
		const t = this.now();
		if (c.status === 'failed' && (c.attempts >= MAX_ATTEMPTS || c.next_try_at > t)) return;
		try {
			if (!c.coolify_uuid) {
				const uuid = await coolify.createApp({ name: `osc-${c.slug}`, repo: cfg.repo.url, branch: cfg.repo.branch, composeLocation: cfg.repo.composeLocation });
				store.update(id, { coolify_uuid: uuid });
				c = store.customer(id)!;
			}
			const signup = store.signup(c.signup_id);
			const hash = signup?.password_hash ?? '';
			if (c.env_progress < 6) {
				if (!hash) throw new Error('the password hash for this sign-up is gone; the instance cannot be given a login');
				const env = instanceEnv(cfg, c.slug, hash);
				for (let i = c.env_progress; i < env.length; i++) {
					await coolify.setEnv(c.coolify_uuid!, env[i][0], env[i][1]);
					store.update(id, { env_progress: i + 1 });
				}
				store.consumeSignup(c.signup_id);
				c = store.customer(id)!;
			}
			if (!c.domain_done) {
				await coolify.setDomain(c.coolify_uuid!, SERVICE, `${instanceOrigin(cfg, c.slug)}:3000`);
				store.update(id, { domain_done: 1 });
			}
			if (!c.deployed_at) {
				await coolify.deploy(c.coolify_uuid!);
				store.update(id, { deployed_at: this.now(), status: 'deploying', last_error: null });
			} else {
				store.update(id, { status: 'deploying', last_error: null });
			}
		} catch (e) {
			const attempts = (store.customer(id)?.attempts ?? 0) + 1;
			const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
			this.log(`provisioning ${c.slug} failed (attempt ${attempts}): ${msg}`);
			store.update(id, { attempts, last_error: msg, status: 'failed', next_try_at: t + Math.min(60, 2 ** attempts) * 60_000 });
		}
	}

	private async healthy(origin: string): Promise<boolean> {
		if (this.d.health) return this.d.health(origin);
		try {
			const r = await fetch(origin + '/login', { redirect: 'manual', signal: AbortSignal.timeout(6000) });
			void r.body?.cancel().catch(() => {});
			return r.status === 200;
		} catch {
			return false;
		}
	}

	/** The periodic pass: finish creations, notice instances that came up, enforce the grace period and the retention period. */
	async reconcile(): Promise<{ checked: number }> {
		const { store, coolify, cfg } = this.d;
		const t = this.now();
		store.purgeStaleSignups(2 * DAY);
		const list = store.due(t);
		for (const c of list) {
			try {
				if (c.status === 'provisioning' || c.status === 'failed') await this.advance(c.id);
				else if (c.status === 'deploying') {
					if (await this.healthy(instanceOrigin(cfg, c.slug))) store.update(c.id, { status: 'active', active_at: t, attempts: 0, last_error: null });
					else if (c.deployed_at && t - c.deployed_at > DEPLOY_TIMEOUT_MS) store.update(c.id, { status: 'failed', attempts: c.attempts + 1, last_error: 'the instance did not come up within 25 minutes', next_try_at: t + 30 * 60_000, deployed_at: null });
				} else if (c.status === 'past_due' && c.past_due_since && t - c.past_due_since > cfg.graceDays * DAY) {
					if (c.coolify_uuid) await coolify.stop(c.coolify_uuid);
					store.update(c.id, { status: 'suspended' });
				} else if (c.status === 'canceled' && c.destroy_after && t >= c.destroy_after && cfg.allowDestroy && c.coolify_uuid) {
					await coolify.destroy(c.coolify_uuid);
					store.update(c.id, { status: 'destroyed' });
				}
			} catch (e) {
				this.log(`reconcile ${c.slug}: ${(e instanceof Error ? e.message : String(e)).slice(0, 200)}`);
			}
		}
		return { checked: list.length };
	}

	/** Where the shared Google redirect should send the browser: the instance named in the state, if it is a real customer. */
	relayTarget(state: string): string | null {
		const origin = originFromState(state);
		if (!origin) return null;
		const slug = slugOfOrigin(origin, this.d.cfg.instanceDomain);
		if (!slug) return null;
		const c = this.d.store.customerBySlug(slug);
		return c && (c.status === 'active' || c.status === 'deploying' || c.status === 'past_due') ? origin : null;
	}
}
