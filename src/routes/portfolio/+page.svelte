<script lang="ts">
	import PeriodPicker from '$lib/components/PeriodPicker.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	let { data } = $props();

	const tabs = [
		['striking', 'Striking distance'],
		['cannibalization', 'Cannibalization'],
		['decay', 'Content decay'],
		['anomalies', 'Anomalies']
	];
	const siteCol = { key: 'site', label: 'Site', type: 'text' as const };
	const colsByTab: Record<string, any[]> = {
		striking: [siteCol, { key: 'query', label: 'Query', type: 'text' }, { key: 'expectedGain', label: 'Est. +clicks', type: 'int' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'ctr', label: 'CTR', type: 'pct' }, { key: 'position', label: 'Position', type: 'pos' }],
		cannibalization: [siteCol, { key: 'query', label: 'Query', type: 'text' }, { key: 'potentialClicks', label: 'Clicks at stake', type: 'int' }, { key: 'pageCount', label: 'Pages', type: 'int' }, { key: 'totalClicks', label: 'Clicks', type: 'int' }, { key: 'totalImpressions', label: 'Impressions', type: 'int' }, { key: 'positionGap', label: 'Pos gap', type: 'pos' }],
		decay: [siteCol, { key: 'page', label: 'Page', type: 'link' }, { key: 'lostClicks', label: 'Lost clicks', type: 'int' }, { key: 'deltaPct', label: 'Δ', type: 'delta' }, { key: 'relativeDeltaPct', label: 'vs site', type: 'delta' }, { key: 'scope', label: 'Scope', type: 'text' }],
		anomalies: [siteCol, { key: 'date', label: 'Date', type: 'text' }, { key: 'direction', label: 'Type', type: 'text' }, { key: 'deltaPct', label: 'Δ', type: 'delta' }, { key: 'value', label: 'Clicks', type: 'int' }, { key: 'expected', label: 'Expected', type: 'int' }]
	};
	const sortKeyByTab: Record<string, string> = { striking: 'expectedGain', cannibalization: 'potentialClicks', decay: 'lostClicks', anomalies: 'date' };
</script>

<div class="mb-3 flex flex-wrap items-center gap-3">
	<h1 class="text-lg font-semibold">Portfolio</h1>
	<PeriodPicker days={data.days} />
</div>
<nav class="mb-4 flex flex-wrap gap-1 border-b" style="border-color:var(--border)">
	{#each tabs as [t, label]}
		<a href="?tab={t}&days={data.days}" class="-mb-px border-b-2 px-3 py-2 text-[13px] {data.tab === t ? 'border-[color:var(--link)] font-medium' : 'border-transparent text-muted-foreground hover:text-foreground'}">{label}</a>
	{/each}
</nav>
{#key data.tab}
	<DataTable rows={data.rows as Record<string, any>[]} cols={colsByTab[data.tab]} sortKey={sortKeyByTab[data.tab]} empty="Nothing found across your sites for this period." />
{/key}
<p class="mt-3 text-xs text-muted-foreground">Each site is analysed on its own CTR curve and brand terms, then results are merged. Cannibalization shows only high-severity cases here; open a site for the full list.</p>
