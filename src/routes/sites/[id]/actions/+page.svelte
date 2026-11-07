<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { TYPE_LABEL } from '$lib/explain';
	let { data } = $props();
	let type = $state('all');
	let only = $state<'all' | 'blocking' | 'quick'>('all');
	let showAll = $state(false);
	const types = $derived([...new Set(data.open.map((a) => a.type))]);
	const count = (f: (a: (typeof data.open)[number]) => boolean) => data.open.filter(f).length;
	const rows = $derived(data.open.filter((a) => (type === 'all' || a.type === type) && (only === 'all' || (only === 'blocking' ? a.blocking : a.effort === 'low' && !a.blocking))));
	const shown = $derived(showAll ? rows : rows.slice(0, 10));
	const blocking = $derived(count((a) => a.blocking));
	const quick = $derived(count((a) => a.effort === 'low' && !a.blocking));
</script>

<Explainer lead="Everything found for this site, in the order to do it: blocking items first, then by estimated gain.">
	<p><b>Blocking</b> items stop the site earning or stop you measuring it. The rest are ranked by estimated clicks per 28 days weighted by confidence. The estimates come from this site's own click-through curve and history; they are model figures, not promises, and are <b>not added up</b> because findings overlap (one page can be a CTR gap and a decay at once).</p>
</Explainer>

{#if data.open.length === 0}
	<div class="card p-6 text-center text-sm"><p class="mb-1 font-medium text-good">Nothing to do right now.</p><p class="text-muted-foreground">Either the site is healthy, or there is not enough data yet. Connect GA4 and Tag Manager, read the sitemaps and run the on-page check to widen what is looked at.</p></div>
{:else}
	<div class="mb-3 flex flex-wrap items-center gap-1.5">
		<span class="mr-1 text-sm"><b>{data.open.length}</b> open{#if blocking} · <b class="text-bad">{blocking} blocking</b>{/if}</span>
		<button class="chip {only === 'blocking' ? 'chip-on' : ''}" onclick={() => (only = only === 'blocking' ? 'all' : 'blocking')} disabled={!blocking}>Blocking ({blocking})</button>
		<button class="chip {only === 'quick' ? 'chip-on' : ''}" onclick={() => (only = only === 'quick' ? 'all' : 'quick')} disabled={!quick} title="Low-effort items that are not blocking">Quick wins ({quick})</button>
		<span class="mx-1 text-muted-foreground">|</span>
		<button class="chip {type === 'all' ? 'chip-on' : ''}" onclick={() => (type = 'all')}>All kinds</button>
		{#each types as t}<button class="chip {type === t ? 'chip-on' : ''}" onclick={() => (type = t)}>{TYPE_LABEL[t]} ({count((a) => a.type === t)})</button>{/each}
	</div>
	{#if rows.length === 0}<div class="card p-6 text-center text-sm text-muted-foreground">Nothing matches these filters. <button class="underline" onclick={() => ((type = 'all'), (only = 'all'))}>Clear them</button></div>{/if}
	<div class="stagger space-y-3">
		{#each shown as a, i (a.key)}<ActionCard {a} rank={i + 1} />{/each}
	</div>
	{#if rows.length > 10}<button class="btn mt-3" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>{/if}
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
