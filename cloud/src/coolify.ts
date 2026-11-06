/** The Coolify API calls the control app needs, written against Coolify's documented endpoints (Bearer token, /api/v1). */
export class CoolifyError extends Error {
	constructor(message: string, readonly status = 0) {
		super(message);
	}
}

export interface CoolifyApi {
	createApp(o: { name: string; repo: string; branch: string; composeLocation: string }): Promise<string>;
	setEnv(uuid: string, key: string, value: string): Promise<void>;
	setDomain(uuid: string, service: string, domain: string): Promise<void>;
	deploy(uuid: string): Promise<void>;
	start(uuid: string): Promise<void>;
	stop(uuid: string): Promise<void>;
	destroy(uuid: string): Promise<void>;
}

export interface CoolifyConfig { baseUrl: string; token: string; projectUuid: string; serverUuid: string; environmentName: string; fetchImpl?: typeof fetch }

export class CoolifyClient implements CoolifyApi {
	constructor(private cfg: CoolifyConfig) {}

	private async call(method: string, path: string, body?: unknown): Promise<Record<string, any>> {
		const f = this.cfg.fetchImpl ?? fetch;
		const res = await f(`${this.cfg.baseUrl}/api/v1${path}`, {
			method,
			headers: { authorization: `Bearer ${this.cfg.token}`, 'content-type': 'application/json', accept: 'application/json' },
			body: body === undefined ? undefined : JSON.stringify(body),
			redirect: 'error',
			signal: AbortSignal.timeout(30_000)
		});
		const text = await res.text();
		let json: Record<string, any> = {};
		try {
			json = text ? JSON.parse(text) : {};
		} catch {
			/* not JSON */
		}
		// Never put the token or a whole response into an error message: only Coolify's own short message.
		if (!res.ok) throw new CoolifyError(`Coolify refused ${method} ${path.split('?')[0].replace(/[0-9a-f-]{20,}/gi, ':uuid')} (${res.status}): ${String(json?.message ?? 'no detail').slice(0, 200)}`, res.status);
		return json;
	}

	async createApp(o: { name: string; repo: string; branch: string; composeLocation: string }): Promise<string> {
		const r = await this.call('POST', '/applications/public', {
			project_uuid: this.cfg.projectUuid,
			server_uuid: this.cfg.serverUuid,
			environment_name: this.cfg.environmentName,
			git_repository: o.repo,
			git_branch: o.branch,
			build_pack: 'dockercompose',
			docker_compose_location: o.composeLocation,
			name: o.name,
			instant_deploy: false
		});
		if (typeof r.uuid !== 'string' || !r.uuid) throw new CoolifyError('Coolify did not return an application id');
		return r.uuid;
	}

	/** The value is stored literally (no variable expansion) and hidden after it is saved. */
	async setEnv(uuid: string, key: string, value: string): Promise<void> {
		await this.call('POST', `/applications/${encodeURIComponent(uuid)}/envs`, { key, value, is_literal: true, is_shown_once: true });
	}

	async setDomain(uuid: string, service: string, domain: string): Promise<void> {
		await this.call('PATCH', `/applications/${encodeURIComponent(uuid)}`, { docker_compose_domains: [{ name: service, domain }] });
	}

	async deploy(uuid: string): Promise<void> {
		await this.call('POST', `/deploy?uuid=${encodeURIComponent(uuid)}`);
	}

	async start(uuid: string): Promise<void> {
		await this.call('POST', `/applications/${encodeURIComponent(uuid)}/start`);
	}

	async stop(uuid: string): Promise<void> {
		await this.call('POST', `/applications/${encodeURIComponent(uuid)}/stop`);
	}

	/** Deletes the application AND its volumes, which is the customer's data. Only ever called after the retention period. */
	async destroy(uuid: string): Promise<void> {
		await this.call('DELETE', `/applications/${encodeURIComponent(uuid)}?delete_volumes=true&delete_configurations=true&docker_cleanup=true`);
	}
}
