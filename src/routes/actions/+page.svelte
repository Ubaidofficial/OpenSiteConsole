<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { TYPE_LABEL } from '$lib/explain';
	let { data } = $props();
	let site = $state('all');
	let type = $state('all');
	let only = $state<'all' | 'blocking' | 'quick'>('all');
	let showAll = $state(false);
	const sites = $derived([...new Map(data.items.map((a) => [a.siteId, a.site])).entries()]);
	const types = $derived([...new Set(data.items.map((a) => a.type))]);
	const count = (f: (a: (typeof data.items)[number]) => boolean) => data.items.filter(f).length;
	const rows = $derived(
		data.items.filter((a) => (site === 'all' || String(a.siteId) === site) && (type === 'all' || a.type === type) && (only === 'all' || (only === 'blocking' ? a.blocking : a.effort === 'low' && !a.blocking)))
	);
	const shown = $derived(showAll ? rows : rows.slice(0, 10));
	const blocking = $derived(count((a) => a.blocking));
	const quick = $derived(count((a) => a.effort === 'low' && !a.blocking));
</script>

<div class="mb-1 flex items-center gap-3"><h1 class="text-lg font-semibold">What to do first</h1><a class="btn ml-auto" href="/updates">Google updates</a></div>
<Explainer lead="What to fix first across all your sites: blocking problems, then the biggest estimated gains.">
	<p>Open a site's <b>Actions</b> tab for its full list and to mark things done. Estimates are model figures from each site's own data, not promises, and larger sites naturally outrank smaller ones.</p>
</Explainer>
{#if data.items.length === 0}
	<div class="card p-6 text-center text-sm text-muted-foreground">Nothing to do across your sites right now, or no data has synced yet.</div>
{:else}
	<div class="card mb-4 space-y-2 p-3">
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="mr-1 w-14 text-xs text-muted-foreground">Show</span>
			<button class="chip {only === 'all' ? 'chip-on' : ''}" onclick={() => (only = 'all')}>All ({data.items.length})</button>
			<button class="chip {only === 'blocking' ? 'chip-on' : ''}" onclick={() => (only = 'blocking')} disabled={!blocking} title="Things that stop a site earning or stop you measuring it">Blocking ({blocking})</button>
			<button class="chip {only === 'quick' ? 'chip-on' : ''}" onclick={() => (only = 'quick')} disabled={!quick} title="Low-effort items that are not blocking">Quick wins ({quick})</button>
		</div>
		{#if sites.length > 1}
			<div class="flex flex-wrap items-center gap-1.5">
				<span class="mr-1 w-14 text-xs text-muted-foreground">Site</span>
				<button class="chip {site === 'all' ? 'chip-on' : ''}" onclick={() => (site = 'all')}>All sites</button>
				{#each sites as [id, name]}<button class="chip pii {site === String(id) ? 'chip-on' : ''}" onclick={() => (site = String(id))}>{name} ({count((a) => a.siteId === id)})</button>{/each}
			</div>
		{/if}
		<div class="flex flex-wrap items-center gap-1.5">
			<span class="mr-1 w-14 text-xs text-muted-foreground">Kind</span>
			<button class="chip {type === 'all' ? 'chip-on' : ''}" onclick={() => (type = 'all')}>All kinds</button>
			{#each types as t}<button class="chip {type === t ? 'chip-on' : ''}" onclick={() => (type = t)}>{TYPE_LABEL[t]} ({count((a) => a.type === t)})</button>{/each}
		</div>
	</div>
	<p class="mb-3 text-sm"><b>{shown.length}</b> of <b>{rows.length}</b> shown{#if blocking && only !== 'blocking'} · <b class="text-bad">{blocking} blocking</b>{/if}</p>
	{#if rows.length === 0}
		<div class="card p-6 text-center text-sm text-muted-foreground">Nothing matches these filters. <button class="underline" onclick={() => ((site = 'all'), (type = 'all'), (only = 'all'))}>Clear them</button></div>
	{:else}
		<div class="stagger space-y-3">
			{#each shown as a, i (a.siteId + ':' + a.key)}<ActionCard {a} rank={i + 1} site={a.site} siteHref="/sites/{a.siteId}/actions" />{/each}
		</div>
		{#if rows.length > 10}<button class="btn mt-3" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>{/if}
	{/if}
{/if}
