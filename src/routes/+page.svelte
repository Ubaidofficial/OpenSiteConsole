<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Eye, EyeOff, ExternalLink, RefreshCw, Search } from '@lucide/svelte';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import AreaSpark from '$lib/components/AreaSpark.svelte';
	import { trendOf } from '$lib/trend';
	import SiteAvatar from '$lib/components/SiteAvatar.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import { privacy } from '$lib/privacy.svelte';
	import { fmtInt, fmtPct, fmtPos, ago } from '$lib/format';

	let { data, form } = $props();
	let q = $state('');
	let account = $state('all');
	let sort = $state<'clicks' | 'impressions' | 'clicksDelta' | 'name'>('clicks');

	const cards = $derived(
		data.cards
			.filter((c) => (account === 'all' || String(c.accountId) === account) && (!q || `${c.name} ${c.label ?? ''} ${c.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase())))
			.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : (b[sort] ?? -Infinity) - (a[sort] ?? -Infinity)))
	);
	const kpis = $derived([
		{ label: 'Clicks', v: fmtInt(data.totals.clicks), d: data.totals.clicksDelta, inv: false },
		{ label: 'Impressions', v: fmtInt(data.totals.impressions), d: data.totals.impressionsDelta, inv: false },
		{ label: 'CTR', v: fmtPct(data.totals.ctr), d: data.totals.ctrDelta, inv: false },
		{ label: 'Avg position', v: fmtPos(data.totals.position), d: data.totals.positionDelta, inv: true, pos: true }
	]);
	const why = $derived(data.totals.comparable ? 'Previous period had too little data for a reliable comparison' : `Comparison shown once the history finishes loading (${data.totals.loading} site${data.totals.loading === 1 ? '' : 's'} still downloading)`);

	// A real sync takes minutes (one Google request per day of history), so follow it live instead of
	// showing a stale "synced 3 h ago" until the page is reloaded.
	const syncing = $derived(data.cards.filter((c) => !c.hidden && (c.syncStatus === 'running' || c.syncStatus === 'queued')).length);
	let wasSyncing = false;
	$effect(() => {
		if (syncing > 0) {
			wasSyncing = true;
			const t = setInterval(() => invalidateAll(), 2500);
			return () => clearInterval(t);
		}
		if (wasSyncing) {
			wasSyncing = false;
			const failed = data.cards.filter((c) => !c.hidden && c.syncStatus === 'error');
			if (failed.length) toast.error(`Sync finished: ${failed.length} site${failed.length === 1 ? '' : 's'} failed`, { description: privacy.on ? undefined : `${failed[0].syncMessage ?? 'Unknown error'}. Hover “⚠ sync error” on a card for details.` });
			else toast.success('Sync finished');
		}
	});

	const title = (c: (typeof data.cards)[number]) => (c.label || c.name).replace(' (URL prefix)', '');
	const isPrefix = (c: (typeof data.cards)[number]) => (c.label || c.name).endsWith('(URL prefix)');

	/** Reverse a hide/show without a page-level form: post the same action again, then refresh. */
	async function toggleAgain(id: number) {
		const fd = new FormData();
		fd.set('id', String(id));
		await fetch('?/toggleHidden', { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		await invalidateAll();
	}

	const hideEnhance = (c: (typeof data.cards)[number]) => () => async ({ update }: { update: () => Promise<void> }) => {
		const wasHidden = c.hidden;
		const label = privacy.on ? 'Site' : title(c);
		await update();
		toast(wasHidden ? `${label} is back on the dashboard` : `${label} hidden`, {
			description: wasHidden ? 'It will sync again.' : 'It leaves the totals and stops syncing. “Show hidden sites” at the bottom brings it back.',
			action: { label: 'Undo', onClick: () => toggleAgain(c.id) }
		});
	};
</script>

<div class="mb-6 flex flex-wrap items-end gap-x-4 gap-y-3">
	<div class="flex items-center gap-3">
		<h1 class="text-2xl font-semibold tracking-tight">All sites</h1>
		<span class="rounded-full bg-muted px-2.5 py-0.5 text-sm font-medium text-muted-foreground tnum">{data.totals.sites}</span>
		{#if data.totals.duplicates}<span class="text-xs text-muted-foreground">{data.totals.duplicates} overlapping</span>{/if}
	</div>
	<PeriodPicker days={data.days} />
	<div class="ml-auto flex flex-wrap items-center gap-2">
		<div class="relative">
			<Search class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
			<input class="input w-52 pl-8" placeholder="Search sites or tags" bind:value={q} />
		</div>
		<select class="input" bind:value={account} aria-label="Account">
			<option value="all">All accounts</option>
			{#each data.accounts as a}<option value={String(a.id)}>{a.label}</option>{/each}
		</select>
		<select class="input" bind:value={sort} aria-label="Sort">
			<option value="clicks">Sort: clicks</option>
			<option value="impressions">Sort: impressions</option>
			<option value="clicksDelta">Sort: Δ clicks</option>
			<option value="name">Sort: name</option>
		</select>
		<form method="POST" action="?/syncAll" use:enhance><button class="btn" disabled={syncing > 0}><RefreshCw class="size-3.5 {syncing > 0 ? 'animate-spin' : ''}" />{syncing > 0 ? `Syncing ${syncing}…` : 'Sync all'}</button></form>
	</div>
</div>

{#if data.cards.length === 0}
	<div class="card p-10 text-center">
		<p class="mb-2 text-lg font-semibold">No sites yet</p>
		<p class="mb-5 text-muted-foreground">Connect a Google account to import every Search Console property it can see.</p>
		<a class="btn btn-primary" href="/accounts">Connect an account</a>
	</div>
{:else}
	<div class="mb-5 grid grid-cols-2 gap-4 md:grid-cols-4">
		{#each kpis as k}
			<div class="rounded-2xl border bg-card p-4 shadow-xs">
				<div class="text-xs font-medium text-muted-foreground">{k.label}</div>
				<div class="tnum mt-1.5 text-3xl font-semibold tracking-tight">{k.v}</div>
				<div class="mt-1 h-4">
					{#if k.d == null}
						<span class="text-xs text-muted-foreground" title={why}>{data.totals.comparable ? 'no reliable comparison' : 'comparison pending'}</span>
					{:else}
						<Delta value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} {why} /> <span class="text-xs text-muted-foreground">{k.pos ? 'places ' : ''}vs previous {data.days}d</span>
					{/if}
				</div>
			</div>
		{/each}
	</div>

	{#if data.duplicates.length}
		<div class="mb-4 flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-4 text-sm shadow-xs">
			<span><b>{data.duplicates.length}</b> URL-prefix {data.duplicates.length === 1 ? 'property is' : 'properties are'} already covered by a Domain property (<span class="pii">{data.duplicates.map((d) => d.name.replace(' (URL prefix)', '')).join(', ')}</span>). Totals count each site once, but both are still syncing.</span>
			<form method="POST" action="?/hideDuplicates" use:enhance class="ml-auto"><button class="btn">Hide duplicates</button></form>
		</div>
	{/if}
	{#if !data.totals.comparable}
		<p class="mb-4 text-xs text-muted-foreground">Comparisons with the previous period appear once each site has finished downloading its history ({data.totals.loading} still loading). Totals for the selected period are already correct for the days downloaded so far.</p>
	{/if}

	<div class="grid grid-cols-1 gap-5 lg:grid-cols-2 2xl:grid-cols-3">
		{#each cards as c (c.id)}
			<article class="group relative rounded-2xl border bg-card p-5 shadow-xs transition-all hover:-translate-y-px hover:shadow-md {c.hidden ? 'opacity-55' : ''}">
				<div class="flex items-start gap-3">
					<SiteAvatar name={title(c)} class="pii" />
					<div class="min-w-0 flex-1">
						<div class="flex items-center gap-2">
							<a href="/sites/{c.id}?days={data.days}" class="pii truncate text-lg leading-tight font-semibold tracking-tight after:absolute after:inset-0 after:rounded-2xl">{title(c)}</a>
							{#if isPrefix(c)}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px]">URL prefix</span>{/if}
							<a href={c.href} target="_blank" rel="noreferrer noopener" class="relative z-10 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100" aria-label="Open the site in a new tab" title="Open site"><ExternalLink class="size-3.5" /></a>
						</div>
						<div class="pii truncate text-sm text-muted-foreground">{c.label ? c.name + ' · ' : ''}{c.account}</div>
						{#if c.coveredBy}<div class="pii truncate text-xs text-warn" title={privacy.on ? undefined : `This property's data is already included in ${c.coveredBy}`}>↳ included in {c.coveredBy.replace('sc-domain:', '')}</div>{/if}
					</div>
					{#if c.hasData}
						<div class="flex shrink-0 flex-col items-end gap-1">
							<span class="tnum rounded-full bg-muted px-3 py-1 text-sm font-medium">{fmtInt(c.clicks)} clicks</span>
							<Delta value={c.clicksDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} />
						</div>
					{/if}
				</div>

				{#if !c.hasData}
					<div class="mt-6 mb-2 text-sm text-muted-foreground">
						{#if c.permission === 'siteUnverifiedUser'}Unverified property — no data available
						{:else if c.syncStatus === 'error'}<span class="text-bad">Sync failed: {c.syncMessage}</span>
						{:else}Waiting for first sync…{/if}
					</div>
				{:else}
					<AreaSpark values={c.spark} trend={trendOf(c.clicksDelta, c.spark)} class="mt-5" />
					<div class="tnum mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-muted-foreground">
						<span class="inline-flex items-center gap-1.5">Impr. <b class="font-medium text-foreground">{fmtInt(c.impressions)}</b><Delta value={c.impressionsDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} /></span>
						<span class="inline-flex items-center gap-1.5">CTR <b class="font-medium text-foreground">{fmtPct(c.ctr)}</b><Delta value={c.ctrDelta} why="Needs 100+ impressions in both periods" /></span>
						<span class="inline-flex items-center gap-1.5">Pos. <b class="font-medium text-foreground">{fmtPos(c.position)}</b><Delta value={c.positionDelta} mode="pos" why="Needs 20+ impressions in both periods" /></span>
					</div>
				{/if}

				<div class="mt-4 flex items-center gap-1.5 border-t pt-3 text-xs text-muted-foreground">
					{#each [['bing', 'Bing'], ['ga4', 'GA4'], ['clarity', 'Clarity'], ['openseo', 'OpenSEO']] as [k, l]}
						{#if c.connected[k as 'bing']}<span class="chip !py-0 text-[10px]" title="{l} connected">{l}</span>{/if}
					{/each}
					{#each c.tags as t}<span class="chip !py-0 text-[10px]">{t}</span>{/each}
					<span class="ml-auto truncate">
						{#if c.syncStatus === 'running' || c.syncStatus === 'queued'}<RefreshCw class="mr-1 inline size-3 animate-spin" />{c.syncStatus}{:else if c.syncStatus === 'error'}<span class="text-bad" title={privacy.on ? undefined : (c.syncMessage ?? 'Sync failed')}>⚠ sync error</span>{:else}synced {ago(c.lastSync)}{/if}{#if !c.backfillDone && c.hasData} · loading history{/if}
					</span>
					<form method="POST" action="?/toggleHidden" use:enhance={hideEnhance(c)} class="relative z-10">
						<input type="hidden" name="id" value={c.id} />
						<button class="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground" aria-label={c.hidden ? 'Show on dashboard' : 'Hide from dashboard'} title={c.hidden ? 'Show on dashboard again' : 'Hide from dashboard (leaves the totals and stops syncing)'}>
							{#if c.hidden}<Eye class="size-4" />{:else}<EyeOff class="size-4" />{/if}
						</button>
					</form>
				</div>
			</article>
		{/each}
	</div>
	<p class="mt-6 text-xs text-muted-foreground">
		Periods end at each site's newest synced day (Search Console data lags ~2 days; days are Pacific time). Green line = clicks growing, red = falling (vs the previous period); dashed end = the last 2 days, which Google may still revise.
		<a class="underline underline-offset-2" href="?days={data.days}&hidden={data.showHidden ? 0 : 1}">{data.showHidden ? 'Hide' : 'Show'} hidden sites</a>
	</p>
{/if}
