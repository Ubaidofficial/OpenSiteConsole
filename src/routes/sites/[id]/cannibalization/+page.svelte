<script lang="ts">
	import { fmtInt, fmtPct, fmtPos, shortUrl } from '$lib/format';
	let { data } = $props();
	let showAll = $state(false);
	const groups = $derived(showAll ? data.groups : data.groups.filter((g) => g.severity === 'high'));
</script>

<div class="mb-3 flex items-center gap-3">
	<p class="text-xs text-muted-foreground">Queries where two or more of your pages each hold a real share of impressions. URL variants (www, trailing slash, tracking params) are merged first, so they are not reported as conflicts.</p>
	<label class="ml-auto flex items-center gap-2 text-xs whitespace-nowrap"><input type="checkbox" bind:checked={showAll} /> include lower-severity ({data.groups.length} total)</label>
</div>
<div class="space-y-3">
	{#each groups as g (g.query)}
		<div class="card p-3">
			<div class="mb-2 flex flex-wrap items-center gap-3">
				<span class="font-medium" class:pii={g.branded}>{g.query}</span>
				<span class="chip {g.severity === 'high' ? 'text-bad' : 'text-warn'}">{g.severity === 'high' ? 'pages close in position' : 'one page dominates'}</span>
				<span class="tnum ml-auto text-xs text-muted-foreground">{fmtInt(g.totalClicks)} clicks · {fmtInt(g.totalImpressions)} impr. · up to ~{fmtInt(g.potentialClicks)} clicks at stake</span>
			</div>
			<table class="w-full table-fixed text-[13px]">
				<colgroup><col class="w-20" /><col /><col class="w-20" /><col class="w-24" /><col class="w-24" /><col class="w-20" /></colgroup>
				<tbody>
					{#each g.pages as p, i}
						<tr>
							<td class="py-1 pr-3">{#if i === 0}<span class="chip text-good">winner</span>{/if}</td>
							<td class="truncate py-1 pr-3"><a class="pii hover:underline" href={p.page} target="_blank" rel="noreferrer noopener">{shortUrl(p.page)}</a></td>
							<td class="tnum py-1 pr-3 text-right">{fmtInt(p.clicks)} clk</td>
							<td class="tnum py-1 pr-3 text-right">{fmtInt(p.impressions)} impr</td>
							<td class="tnum py-1 pr-3 text-right">{fmtPct(p.share, 0)} share</td>
							<td class="tnum py-1 text-right">pos {fmtPos(p.position)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="card p-6 text-center text-muted-foreground">No cannibalization at this severity. Try “include lower-severity” or a longer period.</div>
	{/each}
</div>
