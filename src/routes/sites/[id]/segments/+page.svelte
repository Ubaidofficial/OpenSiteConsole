<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import BarList from '$lib/components/viz/BarList.svelte';
	const DEVICE_NAME: Record<string, string> = { MOBILE: 'Phone', DESKTOP: 'Desktop', TABLET: 'Tablet' };
	// devices keep a fixed colour each (identity, not rank), so the bar reads the same on every site
	const DEVICE_COLOR: Record<string, string> = { MOBILE: 'var(--chart-1)', DESKTOP: 'var(--chart-2)', TABLET: 'var(--chart-3)' };
	let { data } = $props();
	const mk = (label: string) => [
		{ key: 'key', label, type: 'text' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'clicksDelta', label: 'Δ %', title: 'Change in clicks compared with the previous period of the same length (for example +9.5% = 9.5% more clicks than before). A dash means there were no clicks before, so there is no percentage.', type: 'delta' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
</script>

<div class="mb-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4"><h2 class="mb-3 text-sm font-medium">Clicks by device</h2>
		<SegBar title="Clicks by device" format={(v) => `${v.toLocaleString('en-US')} clicks`} parts={[...data.devices].sort((a, b) => ['MOBILE', 'DESKTOP', 'TABLET'].indexOf(String(a.key)) - ['MOBILE', 'DESKTOP', 'TABLET'].indexOf(String(b.key))).map((d) => ({ label: DEVICE_NAME[String(d.key)] ?? String(d.key), value: Number(d.clicks), color: DEVICE_COLOR[String(d.key)] ?? 'var(--muted-foreground)' }))} /></section>
	<section class="card p-4"><h2 class="mb-3 text-sm font-medium">Clicks by country, top 6</h2>
		<BarList limit={6} items={data.countries.map((c) => ({ label: String(c.key).toUpperCase(), value: Number(c.clicks) }))} /></section>
</div>
<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
	<section><h2 class="mb-2 font-medium">Devices</h2><DataTable rows={data.devices} cols={mk('Device')} sortKey="clicks" filterable={false} /></section>
	<section><h2 class="mb-2 font-medium">Countries</h2><DataTable rows={data.countries} cols={mk('Country')} sortKey="clicks" pageSize={25} /></section>
</div>
