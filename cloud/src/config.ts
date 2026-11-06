/** Settings for the hosted-plan control app, all from the environment. It refuses to start with anything missing or malformed. */
export interface CloudConfig {
	/** public address of this control app, e.g. https://cloud.example.com (no trailing slash) */
	baseUrl: string;
	/** customers' instances live at <slug>.<instanceDomain>; a wildcard DNS record must point there */
	instanceDomain: string;
	/** a long random string; every instance's APP_SECRET is derived from it, so it must never change or leak */
	secretKey: string;
	stripe: { secretKey: string; priceId: string; webhookSecret: string };
	coolify: { baseUrl: string; token: string; projectUuid: string; serverUuid: string; environmentName: string };
	repo: { url: string; branch: string; composeLocation: string };
	google: { clientId: string; clientSecret: string };
	graceDays: number;
	retentionDays: number;
	/** deleting an instance (and its data) is off unless this is explicitly turned on */
	allowDestroy: boolean;
	priceLabel: string;
	dbPath: string;
	port: number;
	trustProxy: boolean;
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): CloudConfig {
	const problems: string[] = [];
	const need = (k: string, check?: (v: string) => string | null): string => {
		const v = (env[k] ?? '').trim();
		if (!v) problems.push(`${k} is not set`);
		else {
			const bad = check?.(v);
			if (bad) problems.push(`${k}: ${bad}`);
		}
		return v;
	};
	const num = (k: string, d: number, min: number, max: number) => {
		const raw = env[k];
		if (raw === undefined || raw === '') return d;
		const n = Number(raw);
		if (!Number.isFinite(n) || n < min || n > max) {
			problems.push(`${k} must be a number from ${min} to ${max}`);
			return d;
		}
		return n;
	};
	const url = (v: string) => {
		try {
			const u = new URL(v);
			if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(u.hostname))) return 'must be an https address';
			return null;
		} catch {
			return 'is not a valid URL';
		}
	};
	const cfg: CloudConfig = {
		baseUrl: need('CLOUD_BASE_URL', url).replace(/\/+$/, ''),
		instanceDomain: need('CLOUD_INSTANCE_DOMAIN', (v) => (/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(v) ? null : 'must be a domain name such as cloud.example.com')).toLowerCase(),
		secretKey: need('CLOUD_SECRET_KEY', (v) => (v.length >= 32 ? null : 'must be at least 32 characters')),
		stripe: {
			secretKey: need('STRIPE_SECRET_KEY', (v) => (/^(sk|rk)_(test|live)_/.test(v) ? null : 'must start with sk_test_, sk_live_, rk_test_ or rk_live_')),
			priceId: need('STRIPE_PRICE_ID', (v) => (v.startsWith('price_') ? null : 'must start with price_')),
			webhookSecret: need('STRIPE_WEBHOOK_SECRET', (v) => (v.startsWith('whsec_') ? null : 'must start with whsec_'))
		},
		coolify: {
			baseUrl: need('COOLIFY_URL', url).replace(/\/+$/, ''),
			token: need('COOLIFY_TOKEN'),
			projectUuid: need('COOLIFY_PROJECT_UUID'),
			serverUuid: need('COOLIFY_SERVER_UUID'),
			environmentName: (env.COOLIFY_ENVIRONMENT ?? 'production').trim() || 'production'
		},
		repo: { url: (env.CLOUD_REPO_URL ?? 'https://github.com/Ubaidofficial/OpenSiteConsole').trim(), branch: (env.CLOUD_REPO_BRANCH ?? 'main').trim(), composeLocation: (env.CLOUD_COMPOSE_LOCATION ?? '/compose.coolify.yaml').trim() },
		google: { clientId: need('GOOGLE_CLIENT_ID'), clientSecret: need('GOOGLE_CLIENT_SECRET') },
		graceDays: num('CLOUD_GRACE_DAYS', 7, 0, 60),
		retentionDays: num('CLOUD_RETENTION_DAYS', 30, 1, 365),
		allowDestroy: env.CLOUD_ALLOW_DESTROY === '1',
		priceLabel: (env.CLOUD_PRICE_LABEL ?? '$10 / month').trim().slice(0, 40),
		dbPath: (env.CLOUD_DB_PATH ?? './cloud-data/cloud.db').trim(),
		port: num('PORT', 8080, 1, 65535),
		trustProxy: env.CLOUD_TRUST_PROXY === '1'
	};
	if (problems.length) throw new Error('Control app configuration problems:\n- ' + problems.join('\n- '));
	return cfg;
}
