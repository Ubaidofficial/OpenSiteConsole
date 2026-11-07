<script lang="ts">
	import VerdictCell from '$lib/components/VerdictCell.svelte';
	import { groupsOf } from '$lib/compare';
	let { data } = $props();
	const c = $derived(data.c);
	const groups = $derived(groupsOf(c.rows));
</script>

<article class="mx-auto max-w-5xl">
	<p class="mb-1 text-xs text-muted-foreground"><a class="hover:underline" href="/compare">← All comparisons</a></p>
	<h1 class="mb-1 text-xl font-semibold">SEOConsole vs {c.name}</h1>
	<p class="mb-4 max-w-3xl text-sm text-muted-foreground">{c.blurb}</p>

	<div class="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
		<section class="card p-4"><h2 class="mb-1 text-sm font-medium">SEOConsole</h2>
			<p class="text-sm"><b class="text-good">Free to self-host</b>: run it on your own computer or server and keep your data. <a class="underline" href={data.repo}>Source and install guide</a></p>
			<p class="mt-1 text-sm text-muted-foreground">{data.hosted}</p></section>
		<section class="card p-4"><h2 class="mb-1 text-sm font-medium"><a class="hover:underline" href={c.url} rel="noreferrer noopener">{c.name}</a></h2>
			<p class="text-sm text-muted-foreground">{c.price}</p></section>
	</div>

	<div class="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2">
		<section class="card p-4"><h2 class="mb-1 text-sm font-medium text-good">Where SEOConsole is ahead</h2><ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{#each c.weWin as w}<li>{w}</li>{/each}</ul></section>
		<section class="card p-4"><h2 class="mb-1 text-sm font-medium text-warn">Where {c.name} is ahead</h2><ul class="list-disc space-y-1 pl-5 text-sm text-muted-foreground">{#each c.theyWin as w}<li>{w}</li>{/each}</ul></section>
	</div>

	<h2 class="mb-2 font-medium">Feature by feature</h2>
	<div class="card overflow-x-auto p-0">
		<table class="w-full text-left text-sm">
			<thead><tr><th class="th w-1/3">Feature</th><th class="th">SEOConsole</th><th class="th">{c.name}</th></tr></thead>
			{#each groups as g}
				<tbody>
					<tr><th colspan="3" class="bg-muted/50 px-3 py-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{g}</th></tr>
					{#each c.rows.filter((r) => r.group === g) as r}
						<tr class="border-t" style="border-color:var(--border)"><th scope="row" class="td align-top font-medium">{r.feature}</th><td class="td align-top"><VerdictCell cell={r.ours} /></td><td class="td align-top"><VerdictCell cell={r.theirs} /></td></tr>
					{/each}
				</tbody>
			{/each}
		</table>
	</div>
	<p class="mt-2 text-xs text-muted-foreground">“Not stated” means the competitor's public pages do not say, which is not the same as “no”. What SEOConsole does comes from the app as it is today; “Partly” and “No” are kept in on purpose.</p>

	{#if c.shots.length}
		<h2 class="mt-6 mb-2 font-medium">What SEOConsole looks like</h2>
		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each c.shots as s}
				<figure><img class="w-full rounded border" src={s.src} alt={s.alt} loading="lazy" /><figcaption class="mt-1 text-xs text-muted-foreground">{s.caption} (Screenshots use demo data.)</figcaption></figure>
			{/each}
		</div>
	{/if}

	<section class="mt-6 text-xs text-muted-foreground">
		<h2 class="mb-1 text-sm font-medium text-foreground">Sources</h2>
		<p>What {c.name} offers and charges was read from its own pages on {c.checkedOn}. Prices and features change: check its site before you decide.</p>
		<ul class="mt-1 list-disc pl-5">{#each c.sources as s}<li><a class="underline" href={s.url} rel="noreferrer noopener">{s.label}</a></li>{/each}</ul>
	</section>
</article>
