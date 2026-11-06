<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	let { data } = $props();
	const blocking = $derived(data.items.filter((a) => a.blocking).length);
</script>

<div class="mb-1 flex items-center gap-3"><h1 class="text-lg font-semibold">What to do first</h1><a class="btn ml-auto" href="/digest">Weekly digest</a><a class="btn" href="/updates">Google updates</a></div>
<p class="mb-4 max-w-3xl text-sm text-muted-foreground">
	The most important open items across all your sites. Blocking problems first, then the biggest estimated gains weighted by confidence. Open a site's <b>Actions</b> tab for its full list and to mark things done.
	Estimates are model figures from each site's own data, not promises, and larger sites naturally outrank smaller ones.
</p>
{#if data.items.length === 0}
	<div class="card p-6 text-center text-sm text-muted-foreground">Nothing to do across your sites right now, or no data has synced yet.</div>
{:else}
	<p class="mb-3 text-sm"><b>{data.items.length}</b> shown{#if blocking} · <b class="text-bad">{blocking} blocking</b>{/if}</p>
	<div class="stagger space-y-3">
		{#each data.items as a, i (a.siteId + ':' + a.key)}<ActionCard {a} rank={i + 1} site={a.site} siteHref="/sites/{a.siteId}/actions" />{/each}
	</div>
{/if}
