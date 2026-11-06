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
	const ga4Cols = [
		{ key: 'ga4Sessions', label: 'GA4 sessions', title: 'Sessions that landed on this page from Google organic search, from GA4', type: 'int' as const },
		{ key: 'ga4Engaged', label: 'Engaged', title: 'Share of those GA4 sessions that were engaged', type: 'pct' as const },
		{ key: 'ga4KeyEvents', label: 'Key events', title: 'GA4 key events (conversions) from those sessions', type: 'int' as const }
	];
	const baseCols = [
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const, bar: true },
		{ key: 'clicksDelta', label: 'Δ %', title: 'Change in clicks compared with the previous period of the same length (for example +9.5% = 9.5% more clicks than before). A dash means there were no clicks before, so there is no percentage.', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
	const cols = $derived(data.ga4.hasData ? [...baseCols, ...ga4Cols] : baseCols);
</script>

<div class="mb-3 flex"><a class="btn ml-auto" href="/sites/{page.params.id}/export?dim=page&days={page.url.searchParams.get('days') ?? 28}">Export CSV</a></div>
{#if data.ga4.linked && !data.ga4.hasData}
	<p class="mb-2 text-xs text-muted-foreground">GA4 is linked: sessions, engagement and key events per page appear here after the next GA4 sync.</p>
{:else if data.ga4.hasData}
	<p class="mb-2 text-xs text-muted-foreground">GA4 columns count sessions from Google organic search only, matched to pages by URL path. Sessions and clicks are different measurements, so expect them close but not equal.</p>
{/if}
<DataTable rows={data.rows} {cols} sortKey="clicks" onRowClick={toggle} />
{#if open}
	<div class="card mt-3 p-4">
		<div class="pii mb-2 truncate font-medium">{open}</div>
		<Chart data={history} defaultMetrics={['clicks', 'position']} height={220} />
	</div>
{/if}
