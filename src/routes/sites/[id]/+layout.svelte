<script lang="ts">
	import { privacy } from '$lib/privacy.svelte';
	import { page } from '$app/state';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { RefreshCw } from '@lucide/svelte';
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import { fmtInt, fmtPct, fmtPos, ago } from '$lib/format';

	let { data, children } = $props();
	const syncing = $derived(data.site.syncStatus === 'running' || data.site.syncStatus === 'queued');
	let wasSyncing = false;
	$effect(() => {
		if (syncing) {
			wasSyncing = true;
			const t = setInterval(() => invalidateAll(), 2500);
			return () => clearInterval(t);
		}
		if (wasSyncing) {
			wasSyncing = false;
			if (data.site.syncStatus === 'error') toast.error('Sync failed', { description: privacy.on ? undefined : (data.site.syncMessage ?? undefined) });
			else toast.success('Sync finished');
		}
	});
	const base = $derived(`/sites/${data.site.id}`);
	const tabs = [
		['', 'Overview'],
		['/queries', 'Queries'],
		['/pages', 'Pages'],
		['/trends', 'Trends'],
		['/groups', 'Groups'],
		['/opportunities', 'Opportunities'],
		['/cannibalization', 'Cannibalization'],
		['/decay', 'Decay'],
		['/segments', 'Segments'],
		['/types', 'Search types'],
		['/vitals', 'Web vitals'],
		['/tests', 'Tests'],
		['/indexing', 'Indexing'],
		['/onpage', 'On-page'],
		['/sitemaps', 'Sitemaps'],
		['/inspect', 'Inspect'],
		['/bing', 'Bing'],
		['/analytics', 'GA4'],
		['/tags', 'Tag Manager'],
		['/clarity', 'Clarity'],
		['/settings', 'Settings']
	];
	const isActive = (t: string) => (t === '' ? page.url.pathname === base : page.url.pathname.startsWith(base + t));
	const kpis = $derived([
		{ l: 'Clicks', v: fmtInt(data.kpis.clicks), d: data.kpis.clicksDelta, inv: false },
		{ l: 'Impressions', v: fmtInt(data.kpis.impressions), d: data.kpis.impressionsDelta, inv: false },
		{ l: 'CTR', v: fmtPct(data.kpis.ctr), d: data.kpis.ctrDelta, inv: false },
		{ l: 'Avg position', v: fmtPos(data.kpis.position), d: data.kpis.positionDelta, inv: true, pos: true }
	]);
</script>

<div class="mb-3 flex flex-wrap items-start gap-3">
	<div class="min-w-0">
		<div class="text-xs text-muted-foreground"><a href="/" class="hover:underline">All sites</a> / <span class="pii">{data.account.label ?? data.account.email}</span></div>
		<h1 class="pii truncate text-lg font-semibold">{data.site.label || data.site.name}</h1>
		<div class="text-xs text-muted-foreground">
			<span class="pii">{data.site.url}</span> · {data.period.start} → {data.period.end}
			· {#if data.site.syncStatus === 'running' || data.site.syncStatus === 'queued'}{data.site.syncStatus}…{:else if data.site.syncStatus === 'error'}<span class="text-bad">sync error: {data.site.syncMessage}</span>{:else}synced {ago(data.site.lastSync)}{/if}
			{#if !data.site.backfillDone && data.site.syncedThrough} · backfilling history (back to {data.site.backfilledTo}){/if}
		</div>
	</div>
	<div class="ml-auto flex flex-wrap items-center gap-3">
		<PeriodPicker days={data.days} />
		{#if data.openseo?.url}<a class="btn" href={data.openseo.url} target="_blank" rel="noreferrer noopener" title={privacy.on ? undefined : `OpenSEO project: ${data.openseo.name}`}>OpenSEO ↗</a>{/if}
		<form method="POST" action="{base}/sync" use:enhance><button class="btn" disabled={syncing}><RefreshCw class="size-3.5 {syncing ? 'animate-spin' : ''}" />{syncing ? 'Syncing…' : 'Sync'}</button></form>
	</div>
</div>

<!-- The totals live on Overview only: every other tab is a table that already has these columns. -->
{#if isActive('')}
<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
	{#each kpis as k}
		<div class="card px-3 py-2">
			<div class="text-xs text-muted-foreground">{k.l}</div>
			<div class="tnum text-xl font-semibold">{k.v}</div>
			<Delta value={k.d} invert={k.inv} mode={k.pos ? 'pos' : 'pct'} why={data.kpis.comparable ? 'Too little data for a reliable comparison' : 'Previous period still downloading'} />{#if k.d != null && k.pos}<span class="ml-1 text-xs text-muted-foreground">places</span>{/if}
		</div>
	{/each}
</div>
{/if}

<nav class="mb-4 flex flex-wrap gap-1 border-b" style="border-color:var(--border)">
	{#each tabs as [t, label]}
		<a href="{base}{t}?days={data.days}" class="-mb-px border-b-2 px-3 py-2 text-[13px] {isActive(t) ? 'border-[color:var(--link)] font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}">{label}{#if (t === '/bing' && data.linked.bing) || (t === '/analytics' && data.linked.ga4) || (t === '/tags' && data.linked.gtm) || (t === '/clarity' && data.linked.clarity)}<span class="ml-1 text-good" title="connected">●</span>{/if}</a>
	{/each}
</nav>

{@render children()}
