<script lang="ts">
	import { page } from '$app/state';
	import DataTable from '$lib/components/DataTable.svelte';
	import Chart from '$lib/components/Chart.svelte';
	let { data } = $props();
	let open = $state<string | null>(null);
	let history = $state<any[]>([]);
	async function toggle(row: { page: string }) {
		if (open === row.page) return (open = null);
		open = row.page;
		history = await fetch(`/sites/${page.params.id}/history?kind=page&value=${encodeURIComponent(row.page)}&days=480`).then((r) => r.json());
	}
	const cols = [
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'clicksDelta', label: 'Δ clicks', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
</script>

<div class="mb-3 flex"><a class="btn ml-auto" href="/sites/{page.params.id}/export?dim=page&days={page.url.searchParams.get('days') ?? 28}">Export CSV</a></div>
<DataTable rows={data.rows} {cols} sortKey="clicks" onRowClick={toggle} />
{#if open}
	<div class="card mt-3 p-4">
		<div class="mb-2 truncate font-medium">{open}</div>
		<Chart data={history} defaultMetrics={['clicks', 'position']} height={220} />
	</div>
{/if}
