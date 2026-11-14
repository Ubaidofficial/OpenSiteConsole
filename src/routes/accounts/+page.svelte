<script lang="ts">
	import { ConfirmButton } from '$lib/components/ui/confirm';
	import { enhance } from '$app/forms';
	let { data, form } = $props();
</script>

<div class="mb-4 flex items-center gap-3">
	<h1 class="text-lg font-semibold">Google accounts</h1>
	{#if data.googleConfigured}<a class="btn btn-primary ml-auto" href="/auth/connect">+ Connect Google account</a>{/if}
</div>

{#if data.googleConfigured}<p class="mb-3 text-xs text-muted-foreground">By connecting you agree to the <a class="underline" href="/terms">terms</a> and <a class="underline" href="/privacy">privacy policy</a>. Your Google data is used only to show it to you here and to do what you ask.</p>{/if}

{#if data.connected}<p class="mb-3 text-sm text-good">Connected {data.connected}. Properties are importing and syncing in the background.</p>{/if}
{#if data.error}<p class="mb-3 text-sm text-bad">Google returned: {data.error}</p>{/if}
{#if form?.ok}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}
{#if form?.error}<p class="mb-3 text-sm text-bad">{form.error}</p>{/if}

{#if !data.googleConfigured}
	<div class="card mb-5 p-4 text-sm">
		<p class="mb-2 font-medium">Set up Google OAuth to connect real accounts</p>
		<ol class="ml-5 list-decimal space-y-1 text-muted-foreground">
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
					<div class="pii font-medium">{a.label ?? a.email} {#if a.is_demo}<span class="chip">demo</span>{/if}</div>
					<div class="text-xs text-muted-foreground"><span class="pii">{a.email}</span> · {a.sites} properties</div>
				</div>
				{#if a.status === 'revoked'}
					<span class="chip text-bad">access revoked</span>
					<a class="btn btn-primary" href="/auth/connect">Reconnect</a>
				{/if}
				<div class="ml-auto flex flex-wrap gap-2">
					<form method="POST" action="?/refresh" use:enhance><input type="hidden" name="id" value={a.id} /><button class="btn">Refresh properties</button></form>
					<form method="POST" action="?/relabel" use:enhance class="flex gap-1">
						<input type="hidden" name="id" value={a.id} />
						<input class="input w-36" name="label" aria-label="Label" placeholder="Label" value={a.label ?? ''} />
						<button class="btn">Save</button>
					</form>
					<form method="POST" action="?/remove" use:enhance>
						<input type="hidden" name="id" value={a.id} /><input type="hidden" name="confirm" value="yes" />
						<ConfirmButton title="Remove this account?" description="The account's tokens and all stored Search Console data for its sites will be deleted from this app. Nothing changes in Google." confirmLabel="Remove account">Remove</ConfirmButton>
					</form>
				</div>
			</div>
			{#if !data.readOnly}
				<form method="POST" action="?/addSite" use:enhance class="mt-3 flex flex-wrap gap-2 border-t pt-3" style="border-color:var(--border)">
					<input type="hidden" name="id" value={a.id} />
					<input class="input min-w-64 flex-1 sm:max-w-xl" name="siteUrl" placeholder="sc-domain:example.com or https://example.com/" aria-label="Property to add" />
					<button class="btn">Add property</button>
				</form>
				<details class="mt-2 text-sm">
					<summary class="cursor-pointer text-xs text-muted-foreground">Prove ownership here (no need to open Search Console)</summary>
					<form method="POST" use:enhance class="mt-2 flex flex-wrap items-center gap-2">
						<input type="hidden" name="id" value={a.id} />
						<input class="input min-w-64 flex-1 sm:max-w-md" name="siteUrl" placeholder="example.com or https://example.com/" aria-label="Site to verify" />
						<select class="input" name="method" aria-label="Verification method">
							<option value="DNS_TXT">Domain: DNS TXT record</option><option value="DNS_CNAME">Domain: DNS CNAME record</option>
							<option value="META">URL site: meta tag</option><option value="FILE">URL site: HTML file</option>
						</select>
						<button class="btn" formaction="?/verifyToken">1 · Get token</button>
						<button class="btn btn-primary" formaction="?/verifyNow">2 · Verify and add</button>
					</form>
					{#if form?.verify && form.verify.accountId === a.id}<p class="mt-2 max-w-3xl rounded bg-black/5 p-2 text-xs dark:bg-white/10"><b>{form.verify.property}</b>: {form.verify.help}<br />When it is in place, press <i>2 · Verify and add</i>.</p>{/if}
					<p class="mt-2 max-w-3xl text-xs text-muted-foreground">Google gives a token; you place it on the site or in DNS (this app cannot change your site or DNS); then Google checks and the site is added to Search Console.
						{#if !data.siteVerification}<b class="text-warn">Off on this server:</b> set <code>GOOGLE_INCLUDE_SITE_VERIFICATION=1</code> and reconnect the Google account (an extra permission is asked).{/if}</p>
				</details>
			{/if}
		</div>
	{:else}
		<div class="card p-6 text-center text-muted-foreground">No accounts connected yet.</div>
	{/each}
</div>
<p class="mt-4 text-xs text-muted-foreground">OAuth tokens are encrypted at rest (AES-256-GCM). Scope requested: {data.readOnly ? 'webmasters.readonly' : 'webmasters (read/write, needed for sitemaps and property management)'}.</p>
