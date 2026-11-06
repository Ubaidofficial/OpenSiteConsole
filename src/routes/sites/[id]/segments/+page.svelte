<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	let { data } = $props();
	const mk = (label: string) => [
		{ key: 'key', label, type: 'text' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'clicksDelta', label: 'Change vs previous', title: 'Change in clicks compared with the previous period of the same length (for example +9.5% = 9.5% more clicks than before). Blank = there were no clicks before, so no percentage.', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
</script>

<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
	<section><h2 class="mb-2 font-medium">Devices</h2><DataTable rows={data.devices} cols={mk('Device')} sortKey="clicks" filterable={false} /></section>
	<section><h2 class="mb-2 font-medium">Countries</h2><DataTable rows={data.countries} cols={mk('Country')} sortKey="clicks" pageSize={25} /></section>
</div>
