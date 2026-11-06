import { createServer } from 'node:http';
import { loadConfig } from './config';
import { CoolifyClient } from './coolify';
import { Provisioner } from './provision';
import { createApp } from './server';
import { openStore } from './store';
import { StripeClient } from './stripe';

let cfg: ReturnType<typeof loadConfig>;
try {
	cfg = loadConfig();
} catch (e) {
	console.error(e instanceof Error ? e.message : String(e));
	process.exit(1);
}
const store = openStore(cfg.dbPath);
const log = (m: string) => console.log(new Date().toISOString(), m);
const provisioner = new Provisioner({ store, coolify: new CoolifyClient(cfg.coolify), cfg, log });
const stripe = new StripeClient({ secretKey: cfg.stripe.secretKey, priceId: cfg.stripe.priceId });

const app = createApp({ cfg, store, provisioner, stripe, log, kick: (id) => void setImmediate(() => provisioner.advance(id).catch((e) => log(`advance ${id}: ${e instanceof Error ? e.message : String(e)}`))) });
const server = createServer(app);
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(cfg.port, '0.0.0.0', () => log(`control app listening on ${cfg.port} (${cfg.baseUrl})`));

// Finishes creations that were interrupted, notices instances that came up, enforces the grace and retention periods.
let running = false;
const tick = async () => {
	if (running) return;
	running = true;
	try {
		await provisioner.reconcile();
	} catch (e) {
		log(`reconcile: ${e instanceof Error ? e.message : String(e)}`);
	} finally {
		running = false;
	}
};
const timer = setInterval(tick, 60_000);
void tick();

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
	process.on(sig, () => {
		clearInterval(timer);
		server.close(() => {
			store.close();
			process.exit(0);
		});
		setTimeout(() => process.exit(0), 10_000).unref();
	});
}
