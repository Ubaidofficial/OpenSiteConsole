<script lang="ts">
	import Chart from '$lib/components/Chart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import { fmtInt, fmtPct, ago } from '$lib/format';
	let { data } = $props();
	const cols = (l: string, link = false) => [
		{ key: 'term', label: l, type: (link ? 'link' : 'text') as 'link' | 'text', pii: link ? undefined : (r: { branded?: boolean }) => !!r.branded },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'clickPos', label: 'Avg click pos.', type: 'pos' as const }
	];
</script>

{#if !data.linked}
	<div class="card p-6 text-center"><p class="mb-3">Bing Webmaster isn't linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect Bing</a></div>
{:else}
	<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing clicks</div><div class="tnum text-xl font-semibold">{fmtInt(data.kpi.clicks)}</div><Delta value={data.kpi.clicksDelta} /></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing impressions</div><div class="tnum text-xl font-semibold">{fmtInt(data.kpi.impressions)}</div><Delta value={data.kpi.impressionsDelta} /></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Bing clicks vs Google</div><div class="tnum text-xl font-semibold">{fmtPct(data.kpi.shareOfGoogle)}</div><div class="text-xs text-muted-foreground">of Google's {fmtInt(data.kpi.googleClicks)}</div></div>
		<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Site</div><div class="pii truncate text-sm font-medium">{data.bingUrl}</div><div class="text-xs text-muted-foreground">{data.status.state === 'error' ? data.status.message : 'synced ' + ago(data.status.lastSync)}</div></div>
	</div>
	<div class="card mb-4 p-4"><Chart data={data.series} hide={['position']} labels={{ clicks: 'Bing clicks', impressions: 'Bing impressions' }} /></div>
	<p class="mb-3 text-xs text-muted-foreground">Daily totals come from Bing's traffic endpoint (updated daily; includes web, chat, news, images, videos from 24 Mar 2023). Query and page tables use Bing's detail endpoints, which Microsoft documents as <b>updated weekly</b>, so they lag the totals and are aggregated from weekly rows.</p>
	<div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
		<section><h2 class="mb-2 font-medium">Top queries</h2><DataTable rows={data.queries} cols={cols('Query')} sortKey="clicks" pageSize={15} /></section>
		<section><h2 class="mb-2 font-medium">Top pages</h2><DataTable rows={data.pages} cols={cols('Page', true)} sortKey="clicks" pageSize={15} /></section>
	</div>
{/if}
