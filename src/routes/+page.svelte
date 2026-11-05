<script lang="ts">
	import { enhance } from '$app/forms';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import Sparkline from '$lib/components/Sparkline.svelte';
	import Delta from '$lib/components/Delta.svelte';
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
</script>

<div class="mb-4 flex flex-wrap items-center gap-3">
	<h1 class="text-lg font-semibold">All sites <span class="font-normal text-muted-foreground">· {data.totals.sites}{#if data.totals.duplicates} ({data.totals.duplicates} overlapping){/if}</span></h1>
	<PeriodPicker days={data.days} />
	<div class="ml-auto flex flex-wrap items-center gap-2">
		<input class="input w-48" placeholder="Search sites or tags" bind:value={q} />
		<select class="input" bind:value={account}>
			<option value="all">All accounts</option>
			{#each data.accounts as a}<option value={String(a.id)}>{a.label}</option>{/each}
		</select>
		<select class="input" bind:value={sort}>
			<option value="clicks">Sort: clicks</option>
			<option value="impressions">Sort: impressions</option>
			<option value="clicksDelta">Sort: Δ clicks</option>
			<option value="name">Sort: name</option>
		</select>
		<form method="POST" action="?/syncAll" use:enhance><button class="btn">⟳ Sync all</button></form>
	</div>
</div>

{#if data.cards.length === 0}
	<div class="card p-8 text-center">
		<p class="mb-3 text-base font-medium">No sites yet</p>
		<p class="mb-4 text-muted-foreground">Connect a Google account to import every Search Console property it can see.</p>
		<a class="btn btn-primary" href="/accounts">Connect an account</a>
	</div>
{:else}
	<div class="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
		{#each kpis as k}
			<div class="card p-3">
				<div class="text-xs text-muted-foreground">{k.label} · all visible sites</div>
				<div class="tnum mt-1 text-2xl font-semibold">{k.v}</div>
				{#if k.d == null}
					<span class="text-xs text-muted-foreground" title={why}>{data.totals.comparable ? 'no reliable comparison' : 'comparison pending'}</span>
				{:else}
					<Delta value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} {why} /> <span class="text-xs text-muted-foreground">{k.pos ? 'places ' : ''}vs previous {data.days}d</span>
				{/if}
			</div>
		{/each}
	</div>
	{#if data.duplicates.length}
		<div class="card mb-4 flex flex-wrap items-center gap-3 p-3 text-sm">
			<span><b>{data.duplicates.length}</b> URL-prefix {data.duplicates.length === 1 ? 'property is' : 'properties are'} already covered by a Domain property ({data.duplicates.map((d) => d.name.replace(' (URL prefix)', '')).join(', ')}). Totals count each site once, but both are still syncing.</span>
			<form method="POST" action="?/hideDuplicates" use:enhance class="ml-auto"><button class="btn">Hide duplicates</button></form>
		</div>
	{/if}
	{#if form?.hidden !== undefined}<p class="mb-3 text-xs text-muted-foreground">Hid {form.hidden} duplicate propert{form.hidden === 1 ? 'y' : 'ies'}. Use “Show hidden sites” below to bring them back.</p>{/if}
	{#if !data.totals.comparable}
		<p class="mb-3 text-xs text-muted-foreground">Comparisons with the previous period appear once each site has finished downloading its history ({data.totals.loading} still loading). Totals for the selected period are already correct for the days downloaded so far.</p>
	{/if}
	{#if form?.queued !== undefined}<p class="mb-3 text-xs text-muted-foreground">Queued {form.queued} site(s) for sync.</p>{/if}

	<div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
		{#each cards as c (c.id)}
			<a href="/sites/{c.id}?days={data.days}" class="card block p-3 transition-colors hover:border-[color:var(--muted-foreground)] {c.hidden ? 'opacity-50' : ''}">
				<div class="flex items-start justify-between gap-2">
					<div class="min-w-0">
						<div class="flex items-center gap-1.5 font-medium"><span class="truncate">{(c.label || c.name).replace(' (URL prefix)', '')}</span>{#if (c.label || c.name).endsWith('(URL prefix)')}<span class="chip shrink-0 !px-1.5 !py-0 text-[10px]">URL prefix</span>{/if}</div>
						<div class="truncate text-xs text-muted-foreground">{c.label ? c.name + ' · ' : ''}{c.account}</div>
						{#if c.coveredBy}<div class="truncate text-[11px] text-warn" title="This property's data is already included in {c.coveredBy}">↳ included in {c.coveredBy.replace('sc-domain:', '')}</div>{/if}
					</div>
					<Sparkline values={c.spark} />
				</div>
				{#if !c.hasData}
					<div class="mt-3 text-xs text-muted-foreground">
						{#if c.permission === 'siteUnverifiedUser'}Unverified property — no data available
						{:else if c.syncStatus === 'error'}<span class="text-bad">Sync failed: {c.syncMessage}</span>
						{:else}Waiting for first sync…{/if}
					</div>
				{:else}
					<div class="tnum mt-3 grid grid-cols-4 gap-2 text-sm">
						<div><div class="text-[11px] text-muted-foreground">Clicks</div><div class="font-medium">{fmtInt(c.clicks)}</div><Delta value={c.clicksDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} /></div>
						<div><div class="text-[11px] text-muted-foreground">Impr.</div><div class="font-medium">{fmtInt(c.impressions)}</div><Delta value={c.impressionsDelta} why={c.comparable ? 'Too little data in the previous period' : 'Previous period still loading'} /></div>
						<div><div class="text-[11px] text-muted-foreground">CTR</div><div class="font-medium">{fmtPct(c.ctr)}</div><Delta value={c.ctrDelta} why="Needs 100+ impressions in both periods" /></div>
						<div><div class="text-[11px] text-muted-foreground">Pos.</div><div class="font-medium">{fmtPos(c.position)}</div><Delta value={c.positionDelta} mode="pos" why="Needs 20+ impressions in both periods" /></div>
					</div>
				{/if}
				<div class="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
					{#each [['bing', 'B'], ['ga4', 'GA'], ['clarity', 'C'], ['openseo', 'O']] as [k, l]}
						<span class="rounded border px-1 text-[10px] {c.connected[k as 'bing'] ? 'border-[color:var(--good)] text-good' : 'border-transparent text-muted-foreground opacity-40'}" title="{k} {c.connected[k as 'bing'] ? 'connected' : 'not connected'}">{l}</span>
					{/each}
					{#each c.tags as t}<span class="chip">{t}</span>{/each}
					<span class="ml-auto">
						{#if c.syncStatus === 'running' || c.syncStatus === 'queued'}⟳ {c.syncStatus}{:else if c.syncStatus === 'error'}<span class="text-bad">⚠ sync error</span>{:else}synced {ago(c.lastSync)}{/if}{#if !c.backfillDone && c.hasData} · backfilling history{/if}
					</span>
				</div>
			</a>
		{/each}
	</div>
	<p class="mt-4 text-xs text-muted-foreground">
		Periods end at each site's newest synced day (Search Console data lags ~2 days; days are Pacific time).
		<a class="underline" href="?days={data.days}&hidden={data.showHidden ? 0 : 1}">{data.showHidden ? 'Hide' : 'Show'} hidden sites</a>
	</p>
{/if}
