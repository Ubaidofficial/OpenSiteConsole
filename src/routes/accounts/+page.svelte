<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<div class="mb-4 flex items-center gap-3">
	<h1 class="text-lg font-semibold">Google accounts</h1>
	{#if data.googleConfigured}<a class="btn btn-primary ml-auto" href="/auth/connect">+ Connect Google account</a>{/if}
</div>

{#if data.connected}<p class="mb-3 text-sm text-good">Connected {data.connected}. Properties are importing and syncing in the background.</p>{/if}
{#if data.error}<p class="mb-3 text-sm text-bad">Google returned: {data.error}</p>{/if}
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#if !data.googleConfigured}
	<div class="card mb-5 p-4 text-sm">
		<p class="mb-2 font-medium">Set up Google OAuth to connect real accounts</p>
		<ol class="ml-5 list-decimal space-y-1 text-muted">
			<li>In Google Cloud Console, enable the <b>Search Console API</b>, then create an <b>OAuth client ID</b> of type <i>Web application</i>.</li>
			<li>Add this authorised redirect URI: <code class="rounded bg-black/5 px-1 dark:bg-white/10">{data.redirectUri}</code></li>
			<li>Put <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code> in <code>.env</code> (see <code>.env.example</code>) and restart.</li>
			<li>Or set <code>DEMO_MODE=1</code> to explore with synthetic data.</li>
		</ol>
	</div>
{/if}

<div class="space-y-3">
	{#each data.accounts as a (a.id)}
		<div class="card p-4">
			<div class="flex flex-wrap items-center gap-3">
				<div>
					<div class="font-medium">{a.label ?? a.email} {#if a.is_demo}<span class="chip">demo</span>{/if}</div>
					<div class="text-xs text-muted">{a.email} · {a.sites} properties</div>
				</div>
				{#if a.status === 'revoked'}
					<span class="chip text-bad">access revoked</span>
					<a class="btn btn-primary" href="/auth/connect">Reconnect</a>
				{/if}
				<div class="ml-auto flex flex-wrap gap-2">
					<form method="POST" action="?/refresh" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn">Refresh properties</button></form>
					<form method="POST" action="?/relabel" use:enhance class="flex gap-1">
						<input type="hidden" name="id" value={a.id} />
						<input class="input w-36" name="label" placeholder="Label" value={a.label ?? ''} />
						<button class="btn">Save</button>
					</form>
					<form method="POST" action="?/remove" use:enhance onsubmit={(e) => { if (!confirm('Remove this account and all its stored data?')) e.preventDefault(); }}>
						<input type="hidden" name="id" value={a.id} /><input type="hidden" name="confirm" value="yes" />
						<button class="btn btn-danger">Remove</button>
					</form>
				</div>
			</div>
			{#if !data.readOnly}
				<form method="POST" action="?/addSite" use:enhance class="mt-3 flex flex-wrap gap-2 border-t pt-3" style="border-color:var(--line)">
					<input type="hidden" name="id" value={a.id} />
					<input class="input w-80" name="siteUrl" placeholder="Add property: sc-domain:example.com or https://example.com/" />
					<button class="btn">Add property</button>
				</form>
			{/if}
		</div>
	{:else}
		<div class="card p-6 text-center text-muted">No accounts connected yet.</div>
	{/each}
</div>
<p class="mt-4 text-xs text-muted">OAuth tokens are encrypted at rest (AES-256-GCM). Scope requested: {data.readOnly ? 'webmasters.readonly' : 'webmasters (read/write, needed for sitemaps and property management)'}.</p>
