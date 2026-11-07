<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { page } from '$app/state';
	import { fmtInt } from '$lib/format';
	let { data } = $props();
	const base = $derived(`/sites/${page.params.id}`);
	const tabLabel: Record<string, string> = { opportunities: 'Opportunities', queries: 'Queries', sitemaps: 'Sitemaps', onpage: 'On-page', request: 'Request' };
</script>

<Explainer lead="The easiest improvements first, with an estimate of the extra clicks.">
	<p>The easiest improvements first: the cheapest part of each finding, grouped by what you would actually do. Gains are estimated extra clicks per {data.days} days from this site's own click-through curve. They are model figures, not promises, and they are <b>not added up</b>, because one query can sit in two groups.</p>
</Explainer>

{#if data.groups.length === 0}
	<div class="card p-6 text-center text-sm"><p class="mb-1 font-medium text-good">No easy wins found right now.</p><p class="text-muted-foreground">Either the site is already in good shape, or there is not enough data yet. Let the first sync finish, read the sitemaps (Indexing tab) and run the on-page check.</p></div>
{:else}
	<div class="stagger space-y-4">
		{#each data.groups as g (g.key)}
			<section class="card p-4">
				<div class="flex flex-wrap items-center gap-2"><h2 class="font-medium">{g.title}</h2><span class="chip">{fmtInt(g.total)} found</span><span class="chip">low effort</span>
					<a class="btn !h-7 ml-auto text-xs" href="{base}/{g.tab}?days={data.days}">All of them in {tabLabel[g.tab] ?? g.tab} →</a></div>
				<p class="mt-1 text-sm"><b>What to do:</b> {g.how}</p>
				<details class="mt-1 text-xs text-muted-foreground"><summary class="cursor-pointer select-none">Why this works</summary><p class="mt-1 leading-relaxed">{g.why}</p></details>
				<div class="mt-3 overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="th">What</th><th class="th">Details</th><th class="th text-right">≈ extra clicks</th></tr></thead><tbody>
					{#each g.rows as r}
						<tr><td class="td pii max-w-72 truncate" title={r.label}>{r.label}</td><td class="td pii text-xs text-muted-foreground">{r.detail}</td><td class="td tnum text-right">{r.gain == null ? '–' : fmtInt(r.gain)}</td></tr>
					{/each}
				</tbody></table></div>
			</section>
		{/each}
	</div>
{/if}
