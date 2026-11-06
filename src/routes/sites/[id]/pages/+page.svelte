<script lang="ts">
	import { page } from '$app/state';
	import DataTable from '$lib/components/DataTable.svelte';
	import Chart from '$lib/components/Chart.svelte';
	let { data } = $props();
	let open = $state<string | null>(null);
	let history = $state<any[]>([]);
	async function toggle(row: { url: string; gClicks: number | null }) {
		if (row.gClicks == null) return; // the full-history chart is Search Console's
		if (open === row.url) return (open = null);
		open = row.url;
		history = await fetch(`/sites/${page.params.id}/history?kind=page&value=${encodeURIComponent(row.url)}&days=480`).then((r) => r.json());
	}
	// One header band and tint per source.
	const G = { group: 'Google', groupColor: '#d97706' };
	const B = { group: 'Bing', groupColor: '#0284c7' };
	const A = { group: 'GA4 · Google organic', groupColor: '#ea580c' };
	const C = { group: 'Clarity · last 24 h', groupColor: '#7c3aed' };
	const cols = $derived([
		{ key: 'path', label: 'Page', type: 'link' as const, href: (r: { url: string }) => r.url, display: (r: { path: string }) => r.path },
		{ key: 'gClicks', label: 'Clicks', type: 'int' as const, bar: true, deltaKey: 'gClicksD', title: 'Google clicks, with the change against the previous period of the same length', ...G },
		{ key: 'gImpr', label: 'Impr.', type: 'int' as const, deltaKey: 'gImprD', title: 'Google impressions and their change', ...G },
		{ key: 'gCtr', label: 'CTR', type: 'pct' as const, ...G },
		{ key: 'gPos', label: 'Pos', type: 'pos' as const, title: 'Average Google position, weighted by impressions', ...G },
		...(data.sources.bing.hasData
			? [
					{ key: 'bClicks', label: 'Clicks', type: 'int' as const, deltaKey: 'bClicksD', title: 'Bing clicks, with the change against the previous period', ...B },
					{ key: 'bImpr', label: 'Impr.', type: 'int' as const, deltaKey: 'bImprD', ...B },
					{ key: 'bPos', label: 'Pos', type: 'pos' as const, title: 'Average Bing impression position', ...B }
				]
			: []),
		...(data.sources.ga4.hasData
			? [
					{ key: 'aSessions', label: 'Sessions', type: 'int' as const, deltaKey: 'aSessionsD', title: 'GA4 sessions that landed on this page from Google organic search', ...A },
					{ key: 'aEngaged', label: 'Engaged', type: 'pct' as const, title: 'Share of those sessions that were engaged', ...A },
					{ key: 'aKeyEvents', label: 'Key events', type: 'int' as const, deltaKey: 'aKeyEventsD', title: 'GA4 key events (conversions) from those sessions', ...A }
				]
			: []),
		...(data.sources.clarity.hasData
			? [
					{ key: 'cSessions', label: 'Sessions', type: 'int' as const, title: 'Clarity sessions on this page in its latest 24-hour snapshot', ...C },
					{ key: 'cRage', label: 'Rage clicks', type: 'int' as const, title: 'Sessions with rage clicks (rapid repeated clicking) on this page', ...C },
					{ key: 'cDead', label: 'Dead clicks', type: 'int' as const, title: 'Sessions with dead clicks (clicks that did nothing) on this page', ...C }
				]
			: [])
	]);
	const notes = $derived(
		[
			!data.sources.google.comparable ? 'Google: the previous period is still downloading, so no changes are shown.' : '',
			data.sources.bing.linked && !data.sources.bing.hasData ? 'Bing is linked: its pages appear after the next Bing sync.' : data.sources.bing.hasData && !data.sources.bing.comparable ? 'Bing: stored history does not reach the previous period, so no Bing changes are shown.' : '',
			data.sources.ga4.linked && !data.sources.ga4.hasData ? 'GA4 is linked: sessions per page appear after the next GA4 sync.' : data.sources.ga4.hasData && !data.sources.ga4.comparable ? 'GA4: the previous period is pulled with the next daily sync, so changes appear then.' : '',
			data.sources.clarity.hasData ? `Clarity covers only the last 24 hours (snapshot of ${data.sources.clarity.day}), not the selected period.` : ''
		].filter(Boolean)
	);
</script>

<div class="mb-3 flex"><a class="btn ml-auto" href="/sites/{page.params.id}/export?dim=page&days={page.url.searchParams.get('days') ?? 28}">Export CSV</a></div>
<p class="mb-2 text-xs text-muted-foreground">Every source side by side, joined on the page's path (so www, http and https variants count as one page). Arrows show the change against the previous period; a dash means that source has nothing for the page. GA4 counts Google-organic sessions only: sessions and clicks are different measurements, so expect them close, not equal.</p>
{#each notes as n}<p class="mb-1 text-xs text-muted-foreground">{n}</p>{/each}
<div class="mt-2"></div>
<DataTable rows={data.rows} {cols} sortKey="gClicks" onRowClick={toggle} empty="No page data yet." />
{#if open}
	<div class="card mt-3 p-4">
		<div class="pii mb-2 truncate font-medium">{open}</div>
		<Chart data={history} defaultMetrics={['clicks', 'position']} height={220} />
	</div>
{/if}
