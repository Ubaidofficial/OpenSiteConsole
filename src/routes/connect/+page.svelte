<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { privacy } from '$lib/privacy.svelte';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';

	let { data, form } = $props();
	const cards = ['google', 'bing', 'ga4', 'gtm', 'clarity', 'openseo'] as const;
	const label: Record<string, string> = { google: 'Search Console', bing: 'Bing', ga4: 'GA4', gtm: 'Tag Manager', clarity: 'Clarity', openseo: 'OpenSEO' };
	const done = $derived({ google: data.total, ...data.progress });
	let busy = $state<string | null>(null);
	const submit = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	};
	const msgFor = (s: string) => (form?.section === s ? form : null);
	let editing = $state(false);
	/** A source whose setup is finished folds down to one line; it opens again on click, and stays open while it has a message to show. */
	const full = (k: keyof typeof done) => data.total > 0 && done[k] === data.total;
	const complete = $derived({
		google: data.accounts.length > 0 && !msgFor('google'),
		bing: full('bing') && !msgFor('bing'),
		ga4: full('ga4') && !msgFor('ga4'),
		gtm: full('gtm') && !msgFor('gtm'),
		clarity: full('clarity') && !msgFor('clarity'),
		openseo: !!data.openseo && !msgFor('openseo'),
		crux: !!data.crux && !msgFor('crux')
	});
	const statusOf = $derived({
		google: data.accounts.length ? `✓ ${data.accounts.length} account(s) · ${data.total} site(s)` : 'Not connected',
		bing: `${done.bing ? '✓ ' : ''}${done.bing}/${data.total} sites`,
		ga4: `${done.ga4 ? '✓ ' : ''}${done.ga4}/${data.total} sites`,
		gtm: `${done.gtm ? '✓ ' : ''}${done.gtm}/${data.total} sites`,
		clarity: `${done.clarity ? '✓ ' : ''}${done.clarity}/${data.total} sites`,
		openseo: data.openseo ? `✓ ${data.openseo.linked} site(s)` : 'Optional, not connected',
		crux: data.crux ? '✓ connected' : 'Optional, not connected'
	});
</script>

<h1 class="mb-1 text-lg font-semibold">Connect your data</h1>
<p class="mb-4 text-sm text-muted-foreground">Each step is optional and independent. Sites are matched by domain automatically; whatever can't be matched is listed so you can link it by hand.</p>

{#if data.demo}<p class="card mb-4 p-3 text-sm">Demo mode: type <code>demo</code> as the key/token in any step to connect synthetic data.</p>{/if}
{#if form?.ok && !form.section}<p class="mb-3 text-sm text-good">{form.ok}</p>{/if}

<!-- Matrix: status at a glance; the controls only show while editing -->
<section class="mb-6">
	<div class="mb-2 flex items-center gap-2"><h2 class="font-medium">Connections by site</h2><button type="button" class="btn !h-7 ml-auto text-xs" onclick={() => (editing = !editing)}>{editing ? 'Done editing' : 'Edit links'}</button></div>
	<div class="card overflow-x-auto">
		<table class="w-full">
			<thead><tr><th class="th">Site</th><th class="th">Google</th><th class="th">Bing</th><th class="th">GA4</th><th class="th">GTM</th><th class="th">Clarity</th><th class="th">OpenSEO</th></tr></thead>
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="td whitespace-nowrap"><a class="pii hover:underline" href="/sites/{r.id}">{r.name}</a><div class="pii text-[11px] text-muted-foreground">{r.account}</div></td>
						<td class="td {r.google === 'synced' ? 'text-good' : 'text-muted-foreground'}">{r.google === 'synced' ? '✓' : r.google}</td>
						{#each ['bing', 'ga4', 'gtm', 'clarity', 'openseo'] as const as k}
							{@const l = r.links[k]}
							<td class="td text-xs">
								{#if l}
									<div class="flex items-center gap-1">
										<span class={l.status === 'error' ? 'text-bad' : 'text-good'}>{l.status === 'error' ? '⚠' : '✓'}</span>
										<span class="pii max-w-[11rem] truncate" title={privacy.on ? undefined : (l.label ?? l.id)}>{l.label ?? l.id}</span>
										{#if editing}<form method="POST" action="?/unlink" use:enhance><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} /><button class="text-muted-foreground hover:text-[color:var(--bad)]" title="Unlink" aria-label="Unlink {k}">✕</button></form>{/if}
									</div>
									<div class="text-[11px] text-muted-foreground">{k === 'openseo' ? 'linked by domain' : l.status === 'running' || l.status === 'queued' ? '⟳ ' + l.status : l.status === 'error' ? l.message : 'synced ' + ago(l.lastSync)}
										{#if editing && k !== 'openseo'}<form method="POST" action="?/resync" use:enhance class="inline"><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} /> <button class="underline">refresh</button></form>{/if}</div>
								{:else if editing && (k === 'bing' || k === 'ga4' || k === 'gtm')}
									<details><summary class="cursor-pointer text-muted-foreground">link…</summary>
										<form method="POST" action="?/manual" use:enhance class="mt-1 flex gap-1"><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value={k} />
											<input class="input w-40 !py-0.5 text-xs" name="externalId" placeholder={k === 'bing' ? 'https://www.site.com/' : k === 'gtm' ? 'GTM-ABC1234' : 'properties/123456'} /><button class="btn !py-0.5">Link</button></form></details>
								{:else}<span class="text-muted-foreground">–</span>{/if}
							</td>
						{/each}
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</section>

<h2 class="mb-2 font-medium">Sources</h2>
<div class="stagger grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
	<!-- 1 Google -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.google}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">1 · Google Search Console <span class="chip ml-1">+ GA4 &amp; Tag Manager access</span></h2><span class="ml-auto text-xs {complete.google ? 'text-good' : 'text-muted-foreground'}">{statusOf.google}</span></summary>
		<p class="mb-3 text-xs text-muted-foreground">One Google sign-in grants Search Console, GA4 and Tag Manager (read-only) together. Repeat for each Google account.</p>
		<ul class="mb-3 space-y-1 text-sm">
			{#each data.accounts as a}
				<li class="flex items-center gap-2">
					<span class="pii">{a.email}</span>
					{#if a.status === 'revoked'}<span class="chip text-bad">revoked</span>{/if}
					{#if a.ga4}<span class="chip text-good">GA4 ✓</span>{:else}<span class="chip text-warn" title="Reconnect to grant GA4 access">GA4 not granted</span>{/if}
					{#if a.gtm}<span class="chip text-good">GTM ✓</span>{:else}<span class="chip text-warn" title="Reconnect to grant Tag Manager access">GTM not granted</span>{/if}
				</li>
			{:else}<li class="text-muted-foreground">No accounts yet.</li>{/each}
		</ul>
		<a class="btn btn-primary" href="/accounts">Manage / connect accounts</a>
		{#if data.accounts.some((a) => !a.ga4 && !a.demo)}<p class="mt-2 text-xs text-warn">Some accounts connected before GA4 was added: use “Connect Google account” again on the Accounts page to grant it.</p>{/if}
	</details>

	<!-- 2 Bing -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.bing}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">2 · Bing Webmaster Tools</h2><span class="ml-auto text-xs {complete.bing ? 'text-good' : 'text-muted-foreground'}">{statusOf.bing}</span></summary>
		<ol class="mb-3 ml-4 list-decimal space-y-0.5 text-xs text-muted-foreground">
			<li>Sign in at <a class="underline" href="https://www.bing.com/webmasters" target="_blank" rel="noreferrer noopener">bing.com/webmasters</a> and make sure your sites are added and verified.</li>
			<li><b>Settings</b> (top right) → <b>API Access</b> → accept the terms → <b>API Key</b> → <b>Generate API Key</b>.</li>
			<li>Paste it below. One key covers every site in that Bing account.</li>
		</ol>
		<form method="POST" action="?/bingKey" use:enhance={submit('bing')} class="flex flex-wrap gap-2">
			<input class="input w-44" name="label" placeholder="Label (optional)" />
			<input class="input min-w-0 flex-1" name="apiKey" type="password" autocomplete="off" placeholder="Bing API key" required />
			<button class="btn btn-primary" disabled={busy === 'bing'}>{busy === 'bing' ? 'Checking…' : 'Connect'}</button>
		</form>
		{#if data.bingOAuth}<a class="btn mt-2" href="/auth/bing/connect">Or sign in with Bing (OAuth)</a>{/if}
		{#if msgFor('bing')?.ok}<p class="mt-2 text-sm text-good">{msgFor('bing')?.ok}</p>{/if}
		{#if msgFor('bing')?.error}<p class="mt-2 text-sm text-bad">{msgFor('bing')?.error}</p>{/if}
		{#each data.bing as b}
			<div class="mt-3 flex items-center gap-2 text-sm">
				<span>{b.label}</span><span class="chip">{b.auth === 'oauth' ? 'OAuth' : 'API key'}</span><span class="text-xs text-muted-foreground">{b.sites} site(s)</span>
				{#if b.status !== 'active'}<span class="chip text-bad">{b.status}</span>{/if}
				<form method="POST" action="?/bingRemove" use:enhance class="ml-auto"><input type="hidden" name="id" value={b.id} /><button class="btn btn-danger">Remove</button></form>
			</div>
		{/each}
	</details>

	<!-- 3 GA4 -->
	<details class="card p-4 [&[open]>summary]:mb-2" open={!complete.ga4}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">3 · Google Analytics 4</h2><span class="ml-auto text-xs {complete.ga4 ? 'text-good' : 'text-muted-foreground'}">{statusOf.ga4}</span></summary>
		<p class="mb-3 text-xs text-muted-foreground">Needs the <b>Analytics Admin API</b> and <b>Analytics Data API</b> enabled in your Google Cloud project. Properties are matched to sites by the website address of their web data stream.</p>
		<form method="POST" action="?/ga4Auto" use:enhance={submit('ga4')}><button class="btn btn-primary" disabled={busy === 'ga4'}>{busy === 'ga4' ? 'Matching…' : 'Find & link GA4 properties'}</button></form>
		{#if msgFor('ga4')?.ok}<p class="mt-2 text-sm text-good">{msgFor('ga4')?.ok}</p>{/if}
		{#if msgFor('ga4')?.error}<p class="mt-2 text-sm text-bad">{msgFor('ga4')?.error}</p>{/if}
	</details>

</div>

<!-- 4 Tag Manager -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.gtm}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">4 · Google Tag Manager <span class="chip ml-1">read-only</span></h2><span class="ml-auto text-xs {complete.gtm ? 'text-good' : 'text-muted-foreground'}">{statusOf.gtm}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">
		Reads each site's <b>published</b> container and checks it against GA4 and Search Console (Tag Manager tab). Needs the <b>Tag Manager API</b> enabled in your Google Cloud project. SEOConsole never edits or publishes a container.
	</p>
	<form method="POST" action="?/gtmAuto" use:enhance={submit('gtm')}><button class="btn btn-primary" disabled={busy === 'gtm'}>{busy === 'gtm' ? 'Matching…' : 'Find & link containers'}</button></form>
	{#if msgFor('gtm')?.ok}<p class="mt-2 text-sm text-good">{msgFor('gtm')?.ok}</p>{/if}
	{#if msgFor('gtm')?.error}<p class="mt-2 text-sm text-bad">{msgFor('gtm')?.error}</p>{/if}
</details>

<!-- 5 Clarity -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.clarity}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">5 · Microsoft Clarity</h2><span class="ml-auto text-xs {complete.clarity ? 'text-good' : 'text-muted-foreground'}">{statusOf.clarity}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">
		One token per project: Clarity → <b>Settings</b> → <b>Data Export</b> → <b>Generate new API token</b>. Clarity allows <b>10 API calls per project per day</b> and shows only the last 1–3 days, so one snapshot is stored daily.
		The token only reads data: Clarity's <b>script</b> must also be on the site to record anything. Each site's <b>Clarity</b> tab checks the pages for it and can add it through Tag Manager.
	</p>
	{#if msgFor('clarity')?.ok}<p class="mb-2 text-sm text-good">{msgFor('clarity')?.ok}</p>{/if}
	{#if msgFor('clarity')?.error}<p class="mb-2 text-sm text-bad">{msgFor('clarity')?.error}</p>{/if}
	<div class="overflow-x-auto">
		<table class="w-full">
			<tbody>
				{#each data.rows as r (r.id)}
					<tr>
						<td class="td pii whitespace-nowrap">{r.name}</td>
						<td class="td">
							{#if r.links.clarity}
								<span class="text-good">✓ connected</span> <span class="text-xs text-muted-foreground">· {r.clarityCallsLeft} calls left today</span>
							{:else}
								<form method="POST" action="?/clarity" use:enhance={submit('c' + r.id)} class="flex gap-2">
									<input type="hidden" name="siteId" value={r.id} />
									<input class="input min-w-0 flex-1" name="token" type="password" autocomplete="off" placeholder="Clarity API token" />
									<button class="btn" disabled={busy === 'c' + r.id}>Connect</button>
								</form>
							{/if}
						</td>
						<td class="td w-px">
							{#if r.links.clarity}<form method="POST" action="?/unlink" use:enhance><input type="hidden" name="siteId" value={r.id} /><input type="hidden" name="kind" value="clarity" /><button class="btn btn-danger">Unlink</button></form>{/if}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	</div>
</details>

<!-- 5 OpenSEO -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.openseo}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">6 · OpenSEO <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.openseo ? 'text-good' : 'text-muted-foreground'}">{statusOf.openseo}</span></summary>
	<p class="mb-3 text-xs text-muted-foreground">Links each site to its OpenSEO project (matched by domain) so an AI agent can combine OpenSEO's keyword/rank/audit data with this first-party data. Use an API key from OpenSEO → Settings.</p>
	{#if data.openseo}
		<div class="mb-2 flex items-center gap-2 text-sm"><span class="pii">{data.openseo.baseUrl}</span><span class="text-xs text-muted-foreground">{data.openseo.linked} site(s) linked</span>
			<form method="POST" action="?/openseoRemove" use:enhance class="ml-auto"><button class="btn btn-danger">Disconnect</button></form></div>
	{/if}
	<form method="POST" action="?/openseo" use:enhance={submit('openseo')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1" name="baseUrl" placeholder="https://your-openseo.example.com" value={data.openseo?.baseUrl ?? ''} required />
		<input class="input w-56" name="apiKey" type="password" autocomplete="off" placeholder="oseo_… API key" required />
		<button class="btn btn-primary" disabled={busy === 'openseo'}>{busy === 'openseo' ? 'Checking…' : data.openseo ? 'Reconnect' : 'Connect'}</button>
	</form>
	{#if msgFor('openseo')?.ok}<p class="mt-2 text-sm text-good">{msgFor('openseo')?.ok}</p>{/if}
	{#if msgFor('openseo')?.error}<p class="mt-2 text-sm text-bad">{msgFor('openseo')?.error}</p>{/if}
</details>

<!-- 6 Core Web Vitals -->
<details class="card mt-4 p-4 [&[open]>summary]:mb-2" open={!complete.crux}>
		<summary class="flex cursor-pointer list-none flex-wrap items-center gap-2 select-none [&::-webkit-details-marker]:hidden"><h2 class="font-medium">7 · Core Web Vitals <span class="chip ml-1">optional</span></h2><span class="ml-auto text-xs {complete.crux ? 'text-good' : 'text-muted-foreground'}">{statusOf.crux}</span></summary>
	<Explainer lead="Real-user page speed from Google's Chrome UX Report.">
	<p>Real-user speed data (LCP, INP, CLS and more) from Google's Chrome UX Report, saved once a day per site. It needs a free API key: in Google Cloud Console enable the <b>Chrome UX Report API</b>, then create an API key under Credentials. Sites with too little Chrome traffic have no data, which is normal.</p>
</Explainer>
	{#if data.crux}
		<div class="mb-2 flex items-center gap-2 text-sm"><span>Connected</span><span class="text-xs text-muted-foreground">data for {data.crux.sites} site(s) so far</span>
			<form method="POST" action="?/cruxRemove" use:enhance class="ml-auto"><button class="btn btn-danger">Disconnect</button></form></div>
	{/if}
	<form method="POST" action="?/crux" use:enhance={submit('crux')} class="flex flex-wrap gap-2">
		<input class="input min-w-0 flex-1" name="apiKey" type="password" autocomplete="off" placeholder="Google API key" required />
		<button class="btn btn-primary" disabled={busy === 'crux'}>{busy === 'crux' ? 'Checking…' : data.crux ? 'Replace key' : 'Connect'}</button>
	</form>
	{#if msgFor('crux')?.ok}<p class="mt-2 text-sm text-good">{msgFor('crux')?.ok}</p>{/if}
	{#if msgFor('crux')?.error}<p class="mt-2 text-sm text-bad">{msgFor('crux')?.error}</p>{/if}
</details>

