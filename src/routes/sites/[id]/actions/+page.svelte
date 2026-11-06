<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	let { data } = $props();
	let type = $state('all');
	let showAll = $state(false);
	const types = $derived([...new Set(data.open.map((a) => a.type))]);
	const rows = $derived(data.open.filter((a) => type === 'all' || a.type === type));
	const shown = $derived(showAll ? rows : rows.slice(0, 15));
	const blocking = $derived(data.open.filter((a) => a.blocking).length);
</script>

<p class="mb-3 max-w-3xl text-sm text-muted-foreground">
	Everything the app found for this site, in the order to do it. <b>Blocking</b> items come first (they stop the site earning or stop you measuring it), then the rest by estimated clicks per 28 days weighted by confidence.
	The estimates come from this site's own click-through curve and history; they are model figures, not promises, and they are <b>not added up</b> because findings overlap (one page can be a CTR gap and a decay at once).
</p>

{#if data.open.length === 0}
	<div class="card p-6 text-center text-sm"><p class="mb-1 font-medium text-good">Nothing to do right now.</p><p class="text-muted-foreground">Either the site is healthy, or there is not enough data yet. Connect GA4 and Tag Manager, read the sitemaps and run the on-page check to widen what is looked at.</p></div>
{:else}
	<div class="mb-3 flex flex-wrap items-center gap-1.5">
		<span class="mr-1 text-sm"><b>{data.open.length}</b> open{#if blocking} · <b class="text-bad">{blocking} blocking</b>{/if}</span>
		<button class="chip {type === 'all' ? 'chip-on' : ''}" onclick={() => (type = 'all')}>All</button>
		{#each types as t}<button class="chip {type === t ? 'chip-on' : ''}" onclick={() => (type = t)}>{t}</button>{/each}
	</div>
	<div class="stagger space-y-3">
		{#each shown as a, i (a.key)}<ActionCard {a} rank={i + 1} />{/each}
	</div>
	{#if rows.length > 15}<button class="btn mt-3" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>{/if}
{/if}

{#if data.hidden.length}
	<details class="mt-6">
		<summary class="cursor-pointer text-sm font-medium">Done or snoozed ({data.hidden.length})</summary>
		<div class="mt-3 space-y-3">
			{#each data.hidden as a (a.key)}
				<div class="opacity-70"><p class="mb-1 text-xs text-muted-foreground">{a.status === 'done' ? 'Done' : 'Snoozed'}; returns {new Date(a.until).toLocaleDateString()} if still detected</p><ActionCard {a} rank={0} restore /></div>
			{/each}
		</div>
	</details>
{/if}
