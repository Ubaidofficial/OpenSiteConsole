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
	{#if data.ai.linked}
		<section class="mt-6">
			<h2 class="mb-1 font-medium">AI assistants</h2>
			{#if data.ai.status === 'pending'}
				<p class="text-xs text-muted-foreground">Appears after the next GA4 sync.</p>
			{:else if data.ai.status === 'failed'}
				<p class="text-xs text-warn">The AI-assistant report could not be fetched from GA4 on the last sync and will be retried. Nothing is shown rather than a misleading zero.</p>
			{:else if !data.ai.sessions}
				<p class="text-xs text-muted-foreground">No sessions from ChatGPT, Perplexity, Gemini, Claude or Copilot in this period. Assistants that send no referrer show up as Direct and cannot be counted.</p>
			{:else}
				<p class="mb-2 text-xs text-muted-foreground">
					<b>{data.ai.sessions.toLocaleString('en-US')}</b> sessions arrived from AI assistants in the {data.days} days to {data.ai.window.end}{data.ai.shareOfAllSessions != null ? ` (${(data.ai.shareOfAllSessions * 100).toFixed(1)}% of all sessions)` : ''}, found by the referrer GA4 recorded. A floor, not a total: assistants that strip the referrer land in Direct.
				</p>
				<div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
					<DataTable rows={data.ai.assistants} cols={[{ key: 'assistant', label: 'Assistant', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int', bar: true }, { key: 'engaged', label: 'Engaged', type: 'int' }, { key: 'keyEvents', label: 'Key events', type: 'int' }, { key: 'pages', label: 'Pages', type: 'int' }]} sortKey="sessions" filterable={false} />
					<DataTable rows={data.ai.pages} cols={[{ key: 'page', label: 'Landing page', type: 'text', pii: true }, { key: 'assistant', label: 'From', type: 'text' }, { key: 'sessions', label: 'Sessions', type: 'int' }, { key: 'keyEvents', label: 'Key events', type: 'int' }]} sortKey="sessions" pageSize={10} filterable={false} />
				</div>
			{/if}
		</section>
	{/if}
{/if}
