<script lang="ts">
	/**
	 * "Set up GA4 & Tag Manager" for one site: what was found, what will be created, the choices that are the person's to make,
	 * one confirming click, and afterwards the code that has to go on the site (SEOConsole cannot put it there).
	 */
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	import { gtmSnippet } from '$lib/gtminstall';
	import type { SetupChoices, SetupPlan, SetupResult } from '$lib/server/setup';
	import { untrack } from 'svelte';
	import { Check, X, Minus, LoaderCircle } from '@lucide/svelte';

	type OnSite = { checkedAt: number; seen: boolean; pagesRead: number } | null;
	let {
		site,
		plan,
		choices,
		onSite,
		readOnly,
		form
	}: {
		site: { id: number; name: string };
		plan: SetupPlan | { ok: false; error: string; blockers: string[]; ready: false } | null;
		choices: SetupChoices;
		onSite: OnSite;
		readOnly: boolean;
		form: { setupResult?: SetupResult; tosUrl?: string; setupError?: string; checked?: boolean } | null;
	} = $props();

	const p = $derived(plan && plan.ok ? (plan as SetupPlan) : null);
	const result = $derived(form?.setupResult);
	let busy = $state<string | null>(null);
	let timeZone = $state(untrack(() => (p?.ga4?.state === 'create' ? p.ga4.timeZone : 'UTC')));
	let currency = $state(untrack(() => (p?.ga4?.state === 'create' ? p.ga4.currencyCode : 'USD')));
	let copied = $state<string | null>(null);
	// Google needs a country (two-letter code) to create an account; the browser's language is a good first guess
	let region = $state('US');
	$effect(() => {
		try {
			region = new Intl.Locale(navigator.language).maximize().region || 'US';
		} catch {
			/* keep the default */
		}
	});
	// the browser knows the visitor's time zone better than the server does
	$effect(() => {
		try {
			if (p?.ga4?.state === 'create' && !choices.timeZone) timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || timeZone;
		} catch {
			/* keep the default */
		}
	});

	const back = $derived(`/connect?setup=${site.id}`);
	const grantHref = $derived(`/auth/connect?grant=setup&back=${encodeURIComponent(back)}`);
	const containerId = $derived(p?.gtm && (p.gtm.state === 'linked' || p.gtm.state === 'match') ? p.gtm.publicId : (result?.container?.publicId ?? null));
	const snippet = $derived(containerId ? gtmSnippet(containerId) : null);
	const tone = (ok: boolean | null) => (ok === true ? 'var(--good)' : ok === false ? 'var(--bad)' : 'var(--muted-foreground)');
	const done = (name: string) => () => {
		busy = name;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			await update({ reset: false });
			busy = null;
		};
	};
	async function copy(key: string, text: string) {
		try {
			await navigator.clipboard.writeText(text);
			copied = key;
			setTimeout(() => (copied = null), 1500);
		} catch {
			/* the code stays on screen */
		}
	}
	const canRun = $derived(!!p?.ready);
	const adding = $derived(p?.tag?.state === 'add');
</script>


{#snippet tosBlock(tosUrl: string | undefined)}
	{#if tosUrl}
		<a class="btn btn-primary mt-2 text-xs" href={tosUrl} target="_blank" rel="noreferrer noopener">Accept Google’s terms</a>
		<p class="mt-2 text-muted-foreground">Accept them in the new tab, then come back and press Continue. The new account appears in the list.</p>
		<a class="btn mt-1 text-xs" href={back}>Continue</a>
	{/if}
{/snippet}

<section id="setup" class="card mb-6 p-4" aria-labelledby="setup-h">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 id="setup-h" class="font-medium">Set up GA4 &amp; Tag Manager for <span class="pii">{site.name}</span></h2>
			<p class="mt-1 text-xs text-muted-foreground">SEOConsole looks for this site's GA4 property and Tag Manager container first, and creates one only if there is none. Nothing changes until you confirm.</p>
		</div>
		<a class="btn text-xs" href="/connect">Close</a>
	</div>

	{#if readOnly}
		<p class="mt-3 text-sm text-warn">This server runs with READ_ONLY=1, so it never changes Google Analytics or Tag Manager.</p>
	{:else if plan && !plan.ok}
		<p class="mt-3 text-sm text-bad">{plan.error}</p>
	{:else if p}
		{#if result}
			<div class="mt-3 rounded-lg border px-3 py-2" role="status">
				<ul class="space-y-1 text-sm">
					{#each result.steps as s}
						<li class="flex items-start gap-2">
							<span class="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-white" style="background:{tone(s.status === 'done' ? true : s.status === 'failed' ? false : null)}">
								{#if s.status === 'done'}<Check class="size-3.5" />{:else if s.status === 'failed'}<X class="size-3.5" />{:else}<Minus class="size-3.5" />{/if}
							</span>
							<span>{s.text}</span>
						</li>
					{/each}
				</ul>
				{#if !result.ok}<p class="mt-2 text-sm text-bad">{result.error}</p>{/if}
				{#if result.ok}<p class="mt-2 text-xs text-muted-foreground">Both are linked and syncing in the background. Data appears in GA4 once the container is on your site and visitors arrive.</p>{/if}
				{#if result.reviewUrl}<a class="mt-1 inline-block text-xs underline" href={result.reviewUrl} target="_blank" rel="noreferrer noopener">Open in Tag Manager</a>{/if}
			</div>
		{/if}
		{#if form?.setupError}<p class="mt-3 text-sm text-bad">{form.setupError}</p>{/if}

		<!-- what was found / what will be done -->
		<dl class="mt-4 grid gap-3 sm:grid-cols-3">
			<div class="rounded-lg border p-3">
				<dt class="text-sm font-medium">1 · Google Analytics 4</dt>
				<dd class="mt-1 text-xs">
					{#if p.ga4?.state === 'linked'}
						<span style="color:var(--good)">Already linked:</span> <span class="pii">{p.ga4.label}</span> ({p.ga4.measurementId})
					{:else if p.ga4?.state === 'match'}
						<span style="color:var(--good)">Found your property</span> <b class="pii">{p.ga4.label}</b> ({p.ga4.measurementId ?? 'no measurement ID'}). It will be linked to this site.
					{:else if p.ga4?.state === 'stream'}
						<b class="pii">{p.ga4.label}</b> is linked but has no web data stream. One will be added for <span class="font-mono">{p.ga4.uri}</span>.
					{:else if p.ga4?.state === 'choose'}
						<p class="mb-1 text-warn">Several properties match this site. Which one?</p>
						<form method="GET" action="/connect" class="space-y-1">
							<input type="hidden" name="setup" value={site.id} />
							{#if choices.gtmContainer}<input type="hidden" name="gtmContainer" value={choices.gtmContainer} />{/if}
							{#if choices.gtmAccount}<input type="hidden" name="gtmAccount" value={choices.gtmAccount} />{/if}
							{#each p.ga4.candidates as c}<label class="flex items-center gap-2"><input type="radio" name="ga4Property" value={c.property} required /> <span class="pii">{c.label}</span> <span class="text-muted-foreground">{c.property}</span></label>{/each}
							<button class="btn mt-1 text-xs">Use this one</button>
						</form>
					{:else if p.ga4?.state === 'create'}
						No property has a web stream for this site, so <b>one will be created</b>: “<span class="pii">{p.ga4.displayName}</span>” with a web data stream for <span class="font-mono">{p.ga4.uri}</span>.
						{#if p.ga4.accounts.length > 1}
							<form method="GET" action="/connect" class="mt-2 space-y-1">
								<input type="hidden" name="setup" value={site.id} />
								{#if choices.ga4Property}<input type="hidden" name="ga4Property" value={choices.ga4Property} />{/if}
								{#if choices.gtmContainer}<input type="hidden" name="gtmContainer" value={choices.gtmContainer} />{/if}
								{#if choices.gtmAccount}<input type="hidden" name="gtmAccount" value={choices.gtmAccount} />{/if}
								<label class="block text-muted-foreground" for="ga4acc">You have several Google Analytics accounts. Create it in:</label>
								<select id="ga4acc" class="input w-full text-xs" name="ga4Account" aria-label="Google Analytics account" required>
									<option value="" disabled selected={!p.ga4.account}>Choose an account…</option>
									{#each p.ga4.accounts as a}<option value={a.account} selected={a.account === p.ga4.account}>{a.displayName} ({a.account})</option>{/each}
								</select>
								<button class="btn text-xs">Use this account</button>
							</form>
						{:else}
							<p class="mt-1 text-muted-foreground">In the account “<span class="pii">{p.ga4.accounts[0].displayName}</span>”.</p>
						{/if}
						<div class="mt-3 border-t pt-2">
							{#if form?.tosUrl}
								{@render tosBlock(form.tosUrl)}
							{:else if !p.needsGrant}
								<p class="text-muted-foreground">Want it in its own, brand-new Analytics account called “{p.ga4.displayName}”?</p>
								<form method="POST" action="?/setupTos&setup={site.id}" use:enhance={done('tos')}>
									<input type="hidden" name="siteId" value={site.id} />
									<label class="mt-1 block text-muted-foreground" for="region-{site.id}">Your country (2 letters, Google needs it for a new account)</label>
									<input id="region-{site.id}" class="input mb-1 w-24 text-xs uppercase" name="regionCode" bind:value={region} maxlength="2" minlength="2" pattern="[A-Za-z]{2}" placeholder="US" required />
									<button class="btn mt-1 text-xs" disabled={busy === 'tos'}>{busy === 'tos' ? 'Asking Google…' : 'Create a new Analytics account'}</button>
								</form>
							{/if}
						</div>
					{:else if p.ga4?.state === 'tos'}
						<p>You have no Google Analytics account yet. Google needs you to accept its Terms of Service to create one.</p>
						{#if form?.tosUrl}
							{@render tosBlock(form.tosUrl)}
						{:else if !p.needsGrant}
							<form method="POST" action="?/setupTos&setup={site.id}" use:enhance={done('tos')}>
								<input type="hidden" name="siteId" value={site.id} />
								<label class="mt-1 block text-muted-foreground" for="region-{site.id}">Your country (2 letters, Google needs it for a new account)</label>
								<input id="region-{site.id}" class="input mb-1 w-24 text-xs uppercase" name="regionCode" bind:value={region} maxlength="2" minlength="2" pattern="[A-Za-z]{2}" placeholder="US" required />
								<button class="btn btn-primary mt-2 text-xs" disabled={busy === 'tos'}>{busy === 'tos' ? 'Asking Google…' : 'Get Google’s terms link'}</button>
							</form>
						{/if}
					{:else if p.ga4?.state === 'blocked'}
						<span class="text-warn">{p.ga4.reason}</span>
					{/if}
				</dd>
			</div>

			<div class="rounded-lg border p-3">
				<dt class="text-sm font-medium">2 · Tag Manager container</dt>
				<dd class="mt-1 text-xs">
					{#if p.gtm?.state === 'linked'}
						<span style="color:var(--good)">Already linked:</span> <span class="pii">{p.gtm.label}</span>
					{:else if p.gtm?.state === 'match'}
						<span style="color:var(--good)">Found your container</span> <b class="pii">{p.gtm.label}</b>. It will be linked to this site.
					{:else if p.gtm?.state === 'choose'}
						<p class="mb-1 text-warn">Several containers match this site. Which one?</p>
						<form method="GET" action="/connect" class="space-y-1">
							<input type="hidden" name="setup" value={site.id} />
							{#if choices.ga4Property}<input type="hidden" name="ga4Property" value={choices.ga4Property} />{/if}
							{#if choices.ga4Account}<input type="hidden" name="ga4Account" value={choices.ga4Account} />{/if}
							{#each p.gtm.candidates as c}<label class="flex items-center gap-2"><input type="radio" name="gtmContainer" value={c.key} required /> <span class="pii">{c.publicId} · {c.name}</span> <span class="text-muted-foreground">{c.account}</span></label>{/each}
							<button class="btn mt-1 text-xs">Use this one</button>
						</form>
					{:else if p.gtm?.state === 'create'}
						No web container matches this site, so <b>one will be created</b>: “<span class="pii">{p.gtm.name}</span>” for <span class="font-mono">{p.gtm.domain}</span>.
						{#if p.gtm.accounts.length > 1}
							<form method="GET" action="/connect" class="mt-2 space-y-1">
								<input type="hidden" name="setup" value={site.id} />
								{#if choices.ga4Property}<input type="hidden" name="ga4Property" value={choices.ga4Property} />{/if}
								{#if choices.ga4Account}<input type="hidden" name="ga4Account" value={choices.ga4Account} />{/if}
								<label class="block text-muted-foreground" for="gtmacc">You have several Tag Manager accounts. Create it in:</label>
								<select id="gtmacc" class="input w-full text-xs" name="gtmAccount" aria-label="Tag Manager account" required>
									<option value="" disabled selected={!p.gtm.account}>Choose an account…</option>
									{#each p.gtm.accounts as a}<option value={a.path} selected={a.path === p.gtm.account}>{a.name} ({a.path})</option>{/each}
								</select>
								<button class="btn text-xs">Use this account</button>
							</form>
						{:else}
							<p class="mt-1 text-muted-foreground">In the account “<span class="pii">{p.gtm.accounts[0].name}</span>”.</p>
						{/if}
						<details class="mt-3 border-t pt-2">
							<summary class="cursor-pointer text-muted-foreground">Want a brand-new Tag Manager account instead?</summary>
							<p class="mt-1 text-muted-foreground">Google’s API cannot create a Tag Manager account, so make it there: <b>Create account</b>, account name <b>{p.gtm.name}</b>, container name <b>{p.gtm.name}</b>, target platform <b>Web</b>. Then press Try again: SEOConsole finds that container, links it and adds the Google tag.</p>
							<a class="btn btn-primary mt-2 text-xs" href="https://tagmanager.google.com/" target="_blank" rel="noreferrer noopener">Open Tag Manager</a>
							<a class="btn mt-2 text-xs" href={back}>Try again</a>
						</details>
					{:else if p.gtm?.state === 'no-account'}
						<p>You have no Tag Manager account yet. Google’s API cannot create one, so make it yourself (it takes a minute): <b>Create account</b>, container name <b>{site.name}</b>, target platform <b>Web</b>. Then come back: SEOConsole finds the container and links it.</p>
						<a class="btn btn-primary mt-2 text-xs" href="https://tagmanager.google.com/" target="_blank" rel="noreferrer noopener">Open Tag Manager</a>
						<a class="btn mt-2 text-xs" href={back}>Try again</a>
					{:else if p.gtm?.state === 'blocked'}
						<span class="text-warn">{p.gtm.reason}</span>
					{/if}
				</dd>
			</div>

			<div class="rounded-lg border p-3">
				<dt class="text-sm font-medium">3 · Google tag</dt>
				<dd class="mt-1 text-xs">
					{#if p.tag?.state === 'present'}
						<span style="color:var(--good)">Already in the live container:</span> {p.tag.existing.map((t) => `“${t.name}”${t.measurementId ? ` (${t.measurementId})` : ''}`).join(', ')}. Nothing will be added.
						{#if p.tag.mismatch}<p class="mt-1 text-warn">{p.tag.mismatch}</p>{/if}
					{:else if p.tag?.state === 'add'}
						A <b>Google tag</b> for <span class="font-mono">{p.tag.measurementId ?? 'the new property’s measurement ID'}</span> will be added on <b>All Pages</b>, in a new workspace{p.tag.newContainer ? ' of the new container' : ''}.
						{#if !p.tag.canPublish && p.tag.publishBlocked}<p class="mt-1 text-muted-foreground">{p.tag.publishBlocked}</p>{/if}
					{:else}
						<span class="text-muted-foreground">Decided once the container is chosen.</span>
					{/if}
				</dd>
			</div>
		</dl>

		{#if p.needsGrant}
			<div class="mt-4 rounded-lg border-l-4 bg-muted/40 px-3 py-2 text-sm" style="border-color:var(--warn)">
				<p><b>One permission is needed first.</b> <span class="text-muted-foreground">SEOConsole can read {p.needsGrant.join(', ')} but not change it. Google will ask to let SEOConsole edit Google Analytics and edit, version and publish Tag Manager containers. It uses that only for this button, after showing you the plan.</span></p>
				<a class="btn btn-primary mt-2 text-xs" href={grantHref}>Allow SEOConsole to set up GA4 &amp; Tag Manager</a>
			</div>
		{/if}

		{#each p.blockers.filter((b) => !p.needsGrant && !/choose|Several|Terms of Service|no Tag Manager account/.test(b)) as b}<p class="mt-3 text-xs text-warn">{b}</p>{/each}

		<!-- the confirming click -->
		{#if !result?.ok}
			<form method="POST" action="?/setupRun&setup={site.id}" use:enhance={done('run')} class="mt-4 space-y-3">
				<input type="hidden" name="siteId" value={site.id} />
				{#each ['ga4Property', 'ga4Account', 'gtmContainer', 'gtmAccount'] as k}{#if choices[k as keyof SetupChoices]}<input type="hidden" name={k} value={choices[k as keyof SetupChoices]} />{/if}{/each}
				{#if p.ga4?.state === 'create'}
					<div class="grid gap-2 sm:grid-cols-2">
						<label class="block text-xs"><span class="text-muted-foreground">Time zone for the property (reports use it from now on)</span>
							<input class="input mt-1 w-full" name="timeZone" bind:value={timeZone} placeholder="Europe/Berlin" required /></label>
						<label class="block text-xs"><span class="text-muted-foreground">Currency (3 letters)</span>
							<input class="input mt-1 w-full" name="currencyCode" bind:value={currency} maxlength="3" placeholder="USD" required /></label>
					</div>
				{/if}
				<div class="flex flex-wrap gap-2">
					{#if adding}
						<button class="btn btn-primary text-xs" name="mode" value="publish" disabled={!canRun || !p.tag?.canPublish || !!busy}>{busy === 'run' ? 'Working…' : 'Set up and publish'}</button>
						<button class="btn text-xs" name="mode" value="workspace" disabled={!canRun || !!busy}>Set up, I’ll review the tag first</button>
					{:else}
						<button class="btn btn-primary text-xs" name="mode" value="workspace" disabled={!canRun || !!busy}>{busy === 'run' ? 'Working…' : 'Link them'}</button>
					{/if}
					{#if busy === 'run'}<LoaderCircle class="size-4 animate-spin self-center" />{/if}
				</div>
				{#if adding && !p.tag?.canPublish && p.tag?.publishBlocked && canRun}<p class="text-xs text-muted-foreground">Publishing is off for this container (see step 3), so only “review first” is available.</p>{/if}
			</form>
		{/if}

		<!-- the code for the site -->
		{#if snippet && containerId}
			<div class="mt-5 border-t pt-4">
				<h3 class="text-sm font-medium">Put the container on your site</h3>
				<p class="mt-1 text-xs text-muted-foreground">SEOConsole cannot edit your website. Until these two pieces are on every page (your theme, layout file or a Tag Manager plugin), the container <span class="font-mono">{containerId}</span> never loads and GA4 sees nothing.</p>
				<div class="mt-2 grid gap-3 lg:grid-cols-2">
					<div>
						<p class="text-xs font-medium">1. As high as possible in <code>&lt;head&gt;</code></p>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable code block must be reachable by keyboard -->
						<pre tabindex="0" class="mt-1 max-h-44 overflow-auto rounded-md border bg-muted p-2 text-[11px]">{snippet.head}</pre>
						<button type="button" class="btn mt-1 text-xs" onclick={() => copy('head', snippet.head)}>{copied === 'head' ? 'Copied' : 'Copy'}</button>
					</div>
					<div>
						<p class="text-xs font-medium">2. Right after the opening <code>&lt;body&gt;</code> tag</p>
						<!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable code block must be reachable by keyboard -->
						<pre tabindex="0" class="mt-1 max-h-44 overflow-auto rounded-md border bg-muted p-2 text-[11px]">{snippet.body}</pre>
						<button type="button" class="btn mt-1 text-xs" onclick={() => copy('body', snippet.body)}>{copied === 'body' ? 'Copied' : 'Copy'}</button>
					</div>
				</div>
				<div class="mt-3 flex flex-wrap items-center gap-3 text-xs">
					<span class="inline-flex items-center gap-2 font-medium" style="color:{onSite ? (onSite.seen ? 'var(--good)' : 'var(--warn)') : 'var(--muted-foreground)'}">
						<span class="size-2 rounded-full" style="background:{onSite ? (onSite.seen ? 'var(--good)' : 'var(--warn)') : 'var(--muted-foreground)'}"></span>
						{#if !onSite}Not checked yet{:else if onSite.seen}The pages load this container{:else if onSite.pagesRead === 0}Could not read the pages{:else}Not found on the pages yet{/if}
					</span>
					{#if onSite}<span class="text-muted-foreground">checked {ago(onSite.checkedAt)}</span>{/if}
					<form method="POST" action="?/setupCheck&setup={site.id}" use:enhance={done('check')}>
						<input type="hidden" name="siteId" value={site.id} />
						<button class="btn text-xs" disabled={busy === 'check'}>{busy === 'check' ? 'Checking…' : 'Check my site'}</button>
					</form>
				</div>
				<p class="mt-1 text-[11px] text-muted-foreground">The check reads the home page and the two biggest pages. A container that JavaScript adds later is invisible to it.</p>
			</div>
		{/if}
	{/if}
</section>
