<script lang="ts">
	import Chart from '$lib/components/Chart.svelte';
	import DataTable from '$lib/components/DataTable.svelte';
	import { ago } from '$lib/format';
	let { data } = $props();
	const cols = [
		{ key: 'channel', label: 'Channel group', type: 'text' as const },
		{ key: 'sessions', label: 'Sessions', type: 'int' as const },
		{ key: 'sessionsDelta', label: 'Δ sessions', type: 'delta' as const },
		{ key: 'engagementRate', label: 'Engaged', type: 'pct' as const },
		{ key: 'users', label: 'Users', title: 'Unique users over the whole period, as GA4 reports Total users. Appears after the next GA4 sync.', type: 'int' as const },
		{ key: 'keyEvents', label: 'Key events', type: 'int' as const },
		{ key: 'pageviews', label: 'Views', type: 'int' as const }
	];
</script>

{#if !data.linked}
	<div class="card p-6 text-center"><p class="mb-3">No GA4 property is linked to this site yet.</p><a class="btn btn-primary" href="/connect">Connect GA4</a></div>
{:else}
	<p class="mb-2 text-xs text-muted-foreground">Property: <b class="pii">{data.property}</b> · {data.status.state === 'error' ? data.status.message : 'synced ' + ago(data.status.lastSync)}</p>
	<div class="card mb-4 p-4"><Chart data={data.series} hide={['position']} labels={{ clicks: 'GA4 organic sessions', impressions: 'Google Search clicks' }} /></div>
	<p class="mb-3 text-xs text-muted-foreground">GA4 organic sessions and Search Console clicks are different measurements (sessions vs. clicks, consent-mode gaps, other search engines count as organic in GA4), so expect them to move together but not match. A divergence is a prompt to look, not proof of a problem.</p>
	<DataTable rows={data.channels} {cols} sortKey="sessions" filterable={false} />
{/if}
