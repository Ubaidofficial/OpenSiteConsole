<script lang="ts">
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import { fmtInt, fmtPct, fmtPos, ago } from '$lib/format';

	let { data, children } = $props();
	const base = $derived(`/sites/${data.site.id}`);
	const tabs = [
		['', 'Overview'],
		['/queries', 'Queries'],
		['/pages', 'Pages'],
		['/opportunities', 'Opportunities'],
		['/cannibalization', 'Cannibalization'],
		['/decay', 'Decay'],
		['/segments', 'Segments'],
		['/sitemaps', 'Sitemaps'],
		['/inspect', 'Inspect'],
		['/bing', 'Bing'],
		['/analytics', 'GA4'],
		['/clarity', 'Clarity'],
		['/settings', 'Settings']
	];
	const isActive = (t: string) => (t === '' ? page.url.pathname === base : page.url.pathname.startsWith(base + t));
	const kpis = $derived([
		{ l: 'Clicks', v: fmtInt(data.kpis.clicks), d: data.kpis.clicksDelta, inv: false },
		{ l: 'Impressions', v: fmtInt(data.kpis.impressions), d: data.kpis.impressionsDelta, inv: false },
		{ l: 'CTR', v: fmtPct(data.kpis.ctr), d: data.kpis.ctrDelta, inv: false },
		{ l: 'Avg position', v: fmtPos(data.kpis.position), d: data.kpis.positionDelta, inv: true }
	]);
</script>

<div class="mb-3 flex flex-wrap items-start gap-3">
	<div class="min-w-0">
		<div class="text-xs text-muted"><a href="/" class="hover:underline">All sites</a> / {data.account.label ?? data.account.email}</div>
		<h1 class="truncate text-lg font-semibold">{data.site.label || data.site.name}</h1>
		<div class="text-xs text-muted">
			{data.site.url} · {data.period.start} → {data.period.end}
			· {#if data.site.syncStatus === 'running' || data.site.syncStatus === 'queued'}⟳ {data.site.syncStatus}{:else if data.site.syncStatus === 'error'}<span class="text-bad">sync error: {data.site.syncMessage}</span>{:else}synced {ago(data.site.lastSync)}{/if}
			{#if !data.site.backfillDone && data.site.syncedThrough} · backfilling history (back to {data.site.backfilledTo}){/if}
		</div>
	</div>
	<div class="ml-auto flex flex-wrap items-center gap-3">
		<PeriodPicker days={data.days} />
		{#if data.openseo?.url}<a class="btn" href={data.openseo.url} target="_blank" rel="noreferrer noopener" title="OpenSEO project: {data.openseo.name}">OpenSEO ↗</a>{/if}
		<form method="POST" action="{base}/sync" use:enhance><button class="btn">⟳ Sync</button></form>
	</div>
</div>

<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
	{#each kpis as k}
		<div class="card px-3 py-2">
			<div class="text-xs text-muted">{k.l}</div>
			<div class="tnum text-xl font-semibold">{k.v}</div>
			<Delta value={k.d} invert={k.inv} />
		</div>
	{/each}
</div>

<nav class="mb-4 flex flex-wrap gap-1 border-b" style="border-color:var(--line)">
	{#each tabs as [t, label]}
		<a href="{base}{t}?days={data.days}" class="-mb-px border-b-2 px-3 py-2 text-[13px] {isActive(t) ? 'border-[color:var(--accent)] font-medium' : 'border-transparent text-muted hover:text-[color:var(--ink)]'}">{label}{#if (t === '/bing' && data.linked.bing) || (t === '/analytics' && data.linked.ga4) || (t === '/clarity' && data.linked.clarity)}<span class="ml-1 text-good" title="connected">●</span>{/if}</a>
	{/each}
</nav>

{@render children()}
