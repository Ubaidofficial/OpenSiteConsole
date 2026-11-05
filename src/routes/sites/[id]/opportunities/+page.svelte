<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import { fmtInt, fmtPct } from '$lib/format';
	let { data } = $props();
	const gain = $derived(data.striking.reduce((a, r) => a + r.expectedGain, 0));
	const sCols = [
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'expectedGain', label: 'Est. +clicks', type: 'int' as const, title: 'Extra clicks per period if this query reached position 3, using your own CTR curve' },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
	const gCols = [
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'missedClicks', label: 'Missed clicks', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'expectedCtr', label: 'Expected', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const }
	];
</script>

<div class="card mb-4 p-4">
	<div class="mb-1 font-medium">Your CTR by position <span class="chip ml-1">{data.curve.source === 'fitted' ? 'fitted to your data' : data.curve.source === 'mixed' ? 'partly fitted' : 'industry default'}</span></div>
	<div class="tnum flex gap-4 overflow-x-auto text-xs">
		{#each data.curve.values as v, i}
			<div><div class="text-muted">#{i + 1}</div><div class={data.curve.fitted[i] ? 'font-semibold' : 'text-muted'}>{fmtPct(v)}</div></div>
		{/each}
	</div>
	<p class="mt-2 text-xs text-muted">Non-branded rows only. Bold = measured on this site (500+ impressions at that position); grey = fallback benchmark.</p>
</div>

<h2 class="mb-1 font-medium">Striking distance <span class="font-normal text-muted">· positions 4–20, ranked by estimated gain</span></h2>
<p class="mb-2 text-xs text-muted">Moving all of these to position 3 is worth roughly <b class="text-[color:var(--ink)]">{fmtInt(gain)}</b> extra clicks per period (an estimate, not a forecast).</p>
<DataTable rows={data.striking} cols={sCols} sortKey="expectedGain" />

<h2 class="mb-1 mt-8 font-medium">Title/snippet candidates <span class="font-normal text-muted">· CTR well below your curve for the position</span></h2>
<DataTable rows={data.ctrGaps} cols={gCols} sortKey="missedClicks" empty="No pages are significantly under-performing their position." />
