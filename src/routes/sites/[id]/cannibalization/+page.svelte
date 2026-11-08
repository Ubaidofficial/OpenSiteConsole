<script lang="ts">
	import { fmtInt, fmtPct, fmtPos, shortUrl } from '$lib/format';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import PositionLines from '$lib/components/viz/PositionLines.svelte';
	import { page as pg } from '$app/state';
	/** weekly positions per competing page, fetched the first time a query's history is opened */
	let hist = $state<Record<string, { weeks: string[]; pages: { page: string; positions: (number | null)[] }[] } | 'loading'>>({});
	async function loadHist(q: string, pages: string[]) {
		if (hist[q]) return;
		hist[q] = 'loading';
		const u = new URLSearchParams({ kind: 'split', value: q });
		for (const p of pages.slice(0, 4)) u.append('page', p);
		hist[q] = await fetch(`/sites/${pg.params.id}/history?${u}`).then((r) => r.json());
	}
	/** each competing page keeps one colour within its query: the first three slots, then grey for any others */
	const swatch = (i: number) => (i < 3 ? `var(--chart-${i + 1})` : 'var(--muted-foreground)');
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
			<div class="mb-2"><SegBar tall={false} legend={false} title="Share of impressions for “{g.query}”" format={(v) => `${fmtInt(v)} impressions`} parts={g.pages.map((p, i) => ({ label: shortUrl(p.page), value: p.impressions, color: swatch(i) }))} /></div>
			<div class="overflow-x-auto">
			<table class="w-full min-w-[36rem] table-fixed text-[13px]">
				<colgroup><col class="w-20" /><col /><col class="w-20" /><col class="w-24" /><col class="w-24" /><col class="w-20" /></colgroup>
				<tbody>
					{#each g.pages as p, i}
						<tr>
							<td class="py-1 pr-3">{#if i === 0}<span class="chip text-good">winner</span>{/if}</td>
							<td class="truncate py-1 pr-3"><span class="mr-1.5 inline-block size-2 rounded-full align-middle" style="background:{swatch(i)}" aria-hidden="true"></span><a class="pii hover:underline" href={p.page} target="_blank" rel="noreferrer noopener">{shortUrl(p.page)}</a></td>
							<td class="tnum py-1 pr-3 text-right">{fmtInt(p.clicks)} clk</td>
							<td class="tnum py-1 pr-3 text-right">{fmtInt(p.impressions)} impr</td>
							<td class="tnum py-1 pr-3 text-right">{fmtPct(p.share, 0)} share</td>
							<td class="tnum py-1 text-right">pos {fmtPos(p.position)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
			</div>
			<details class="mt-2 text-xs" ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && loadHist(g.query, g.pages.map((p) => p.page))}>
				<summary class="cursor-pointer text-muted-foreground select-none">Position over time, last 16 weeks</summary>
				<div class="mt-2">
					{#if hist[g.query] === 'loading' || !hist[g.query]}<p class="text-muted-foreground">Loading…</p>
					{:else}{@const h = hist[g.query] as { weeks: string[]; pages: { page: string; positions: (number | null)[] }[] }}
						<PositionLines weeks={h.weeks} pages={h.pages} colors={h.pages.map((_, i) => swatch(i))} />
						<p class="mt-1 text-muted-foreground">Lines that keep swapping places mean Google cannot decide which page answers this search; one steady line on top means it has.</p>
					{/if}
				</div>
			</details>
		</div>
	{:else}
		<div class="card p-6 text-center text-muted-foreground">No cannibalization at this severity. Try “include lower-severity” or a longer period.</div>
	{/each}
</div>
