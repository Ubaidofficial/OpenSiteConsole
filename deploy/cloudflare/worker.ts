/**
 * Runs OpenSiteConsole in a Cloudflare Container.
 *
 * Why a container and not plain Worker code: the app is a Node server that keeps its data in a SQLite file and runs its own
 * background scheduler (syncs, digests, alerts, indexing checks). Workers cannot load that native database module or keep a
 * disk. A Container can run the app as it is. Its disk is wiped whenever it sleeps, so the image starts Litestream, which
 * restores the database from your R2 bucket on start and copies every change back to it (see entrypoint.sh).
 *
 *  - Every request goes to the one container.
 *  - A cron trigger wakes the container so scheduled work (the app's own scheduler) keeps running while nobody is browsing.
 *  - Every string variable or secret on this Worker is passed to the app as an environment variable.
 *
 * Not tested against a real Cloudflare account by the author: see deploy/cloudflare/README.md.
 */
import { Container, getContainer } from '@cloudflare/containers';

interface Env {
	OSC: DurableObjectNamespace<OpenSiteConsole>;
	[name: string]: unknown;
}

/** The app's port inside the container (Dockerfile.cloudflare sets PORT=3000). */
const PORT = 3000;

/** Variables that belong to this Worker, not to the app. */
const WORKER_ONLY = new Set(['SLEEP_AFTER']);

export class OpenSiteConsole extends Container<Env> {
	defaultPort = PORT;
	sleepAfter: string | number = '20m';

	constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
		super(ctx, env);
		if (typeof env.SLEEP_AFTER === 'string' && env.SLEEP_AFTER) this.sleepAfter = env.SLEEP_AFTER;
		// Everything the owner set as a variable or secret goes to the app (ADMIN_PASSWORD, APP_SECRET, GOOGLE_*, R2_*, ...).
		const vars: Record<string, string> = {};
		for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && !WORKER_ONLY.has(k)) vars[k] = v;
		vars.PORT = String(PORT);
		vars.HOST = '0.0.0.0';
		this.envVars = vars;
	}

	/**
	 * The app needs to know its public address (OAuth redirect URI, form-post origin check). If ORIGIN was not set, the first
	 * request's address is remembered and used, so a first deploy works without configuration. Set ORIGIN to pin it.
	 */
	private async withOrigin(request?: Request): Promise<void> {
		const vars = (this.envVars ?? {}) as Record<string, string>;
		if (typeof this.env.ORIGIN === 'string' && this.env.ORIGIN) return void (vars.ORIGIN = this.env.ORIGIN);
		let origin = await this.ctx.storage.get<string>('origin');
		if (!origin && request) {
			origin = new URL(request.url).origin;
			await this.ctx.storage.put('origin', origin);
		}
		if (origin) vars.ORIGIN = origin;
		this.envVars = vars;
	}

	override async fetch(request: Request): Promise<Response> {
		await this.withOrigin(request);
		return super.fetch(request);
	}

	/** Called by the cron trigger: start the container if it is asleep and let the app's own scheduler do its work. */
	async wake(): Promise<string> {
		await this.withOrigin();
		await this.startAndWaitForPorts({ ports: PORT });
		const res = await this.containerFetch('http://container/login');
		void res.body?.cancel().catch(() => {});
		return `awake (HTTP ${res.status})`;
	}
}

/** Refuse to run open to the internet: the app itself also refuses remote requests without a password. */
function missingSetup(env: Env): string | null {
	if (!env.ADMIN_PASSWORD) return 'ADMIN_PASSWORD is not set. Run: npx wrangler secret put ADMIN_PASSWORD (see deploy/cloudflare/README.md).';
	if (!env.APP_SECRET) return 'APP_SECRET is not set. Run: npx wrangler secret put APP_SECRET (a random string of 32+ characters).';
	if (env.ALLOW_EPHEMERAL !== '1') {
		const need = ['R2_BUCKET', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((k) => !env[k]);
		if (need.length) return `${need.join(', ')} not set. The database is kept in your R2 bucket so it survives the container sleeping; see deploy/cloudflare/README.md.`;
	}
	return null;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const problem = missingSetup(env);
		if (problem) return new Response(`OpenSiteConsole is not configured yet.\n\n${problem}\n`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
		return getContainer(env.OSC).fetch(request);
	},

	async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		if (missingSetup(env)) return;
		ctx.waitUntil(
			getContainer(env.OSC)
				.wake()
				.then((m) => console.log('cron:', m))
				.catch((e) => console.error('cron wake failed:', e instanceof Error ? e.message : e))
		);
	}
} satisfies ExportedHandler<Env>;
