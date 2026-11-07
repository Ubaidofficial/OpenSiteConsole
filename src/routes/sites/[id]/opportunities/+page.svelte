<script lang="ts">
	import DataTable from '$lib/components/DataTable.svelte';
	import { fmtInt, fmtPct } from '$lib/format';
	import { HIDDEN_GROUPS, HIDDEN_INTRO, HIDDEN_SOURCE_HINT } from '$lib/explain';
	let { data } = $props();
	const gain = $derived(data.striking.reduce((a, r) => a + r.expectedGain, 0));
	const sCols = [
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'expectedGain', label: 'Est. +clicks', type: 'int' as const, bar: true, title: 'Extra clicks per period if this query reached position 3, using your own CTR curve' },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const },
		{ key: 'clicks', label: 'Clicks', type: 'int' as const },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'position', label: 'Position', type: 'pos' as const }
	];
	const gCols = [
		{ key: 'query', label: 'Query', type: 'text' as const },
		{ key: 'page', label: 'Page', type: 'link' as const },
		{ key: 'missedClicks', label: 'Missed clicks', type: 'int' as const, bar: true },
		{ key: 'ctr', label: 'CTR', type: 'pct' as const },
		{ key: 'expectedCtr', label: 'Expected', type: 'pct' as const, title: 'The click-through rate this site normally earns at that position, from its own data.' },
		{ key: 'position', label: 'Position', type: 'pos' as const },
		{ key: 'impressions', label: 'Impressions', type: 'int' as const }
	];
	const num = (k: string, label: string, type: 'int' | 'pct' | 'pos', title?: string, bar = false) => ({ key: k, label, type, title, bar });
	const qcol = { key: 'query', label: 'Search', type: 'text' as const };
	const pcol = { key: 'page', label: 'Page', type: 'text' as const, pii: true };
	const h = $derived(data.hidden);
	const tables = $derived([
		{ id: 'lost', rows: h.lost, sort: 'lostClicks', cols: [qcol, num('lostClicks', 'Clicks lost', 'int', undefined, true), num('prevClicks', 'Before', 'int'), num('clicks', 'Now', 'int'), num('positionPrev', 'Position before', 'pos'), num('positionNow', 'Position now', 'pos')], src: 'previousPeriod' as const },
		{ id: 'rising', rows: h.rising, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks at #5', 'int', 'Extra clicks per period if this search reached position 5, on your own click curve', true), num('impressions', 'Impressions', 'int'), num('prevImpressions', 'Before', 'int'), num('position', 'Position', 'pos')], src: 'previousPeriod' as const },
		{ id: 'edge', rows: h.pageEdge, sort: 'gain', cols: [pcol, num('gain', 'Est. +clicks at #5', 'int', 'Ceiling: every search listed for this page reaching position 5 at once', true), num('queries', 'Searches', 'int'), num('impressions', 'Impressions', 'int')], src: null },
		{ id: 'questions', rows: h.questions, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks at #5', 'int', undefined, true), num('impressions', 'Impressions', 'int'), num('position', 'Position', 'pos')], src: null },
		{ id: 'bing', rows: h.bingGaps, sort: 'bingImpressions', cols: [qcol, num('bingImpressions', 'Bing impressions', 'int', undefined, true), num('bingPosition', 'Bing position', 'pos'), num('googlePosition', 'Google position', 'pos', 'Blank means Google shows you nowhere for it'), num('googleImpressions', 'Google impressions', 'int')], src: 'bing' as const },
		{ id: 'notbing', rows: h.notInBing, sort: 'clicks', cols: [pcol, num('clicks', 'Google clicks', 'int', undefined, true)], src: 'bing' as const },
		{ id: 'gems', rows: h.gems, sort: 'gain', cols: [pcol, num('gain', 'Est. +clicks at #3', 'int', undefined, true), num('sessions', 'Organic sessions', 'int'), num('engagementRate', 'Engaged', 'pct'), num('keyEventRate', 'Key events / session', 'pct'), num('position', 'Position', 'pos')], src: 'ga4' as const },
		{ id: 'leaks', rows: h.engagement, sort: 'lostEngagedSessions', cols: [pcol, num('lostEngagedSessions', 'Visits that would have engaged', 'int', 'If this page engaged visitors at your site-wide rate', true), num('sessions', 'Organic sessions', 'int'), num('engagementRate', 'Engaged', 'pct'), num('siteRate', 'Site average', 'pct')], src: 'ga4' as const },
		{ id: 'noconv', rows: h.conversions, sort: 'expectedKeyEvents', cols: [pcol, num('expectedKeyEvents', 'Expected key events', 'int', 'What this page would have produced at your site-wide rate', true), num('sessions', 'Organic sessions', 'int')], src: 'ga4' as const },
		{ id: 'friction', rows: h.friction, sort: 'rate', cols: [pcol, num('rate', 'Sessions with friction', 'pct', undefined, true), num('sessions', 'Sessions', 'int'), num('googleClicks', 'Google clicks', 'int')], src: 'clarity' as const },
		{ id: 'device', rows: h.device, sort: 'gain', cols: [qcol, num('gain', 'Est. +clicks', 'int', undefined, true), num('mobilePosition', 'Phone position', 'pos'), num('desktopPosition', 'Desktop position', 'pos'), num('mobileImpressions', 'Phone impressions', 'int')], src: null }
	].map((t) => ({ ...t, rows: t.rows as unknown as Record<string, unknown>[], ...HIDDEN_GROUPS.find((g) => g.id === t.id)! })));
</script>

<div class="card mb-4 p-4">
	<div class="mb-1 font-medium">Your CTR by position <span class="chip ml-1">{data.curve.source === 'fitted' ? 'fitted to your data' : data.curve.source === 'mixed' ? 'partly fitted' : 'industry default'}</span></div>
	<div class="tnum flex gap-4 overflow-x-auto text-xs">
		{#each data.curve.values as v, i}
			<div><div class="text-muted-foreground">#{i + 1}</div><div class={data.curve.fitted[i] ? 'font-semibold' : 'text-muted-foreground'}>{fmtPct(v)}</div></div>
		{/each}
	</div>
	<p class="mt-2 text-xs text-muted-foreground">Non-branded rows only. Bold = measured on this site (500+ impressions at that position); grey = fallback benchmark.</p>
</div>

<h2 class="mb-1 font-medium">Striking distance <span class="font-normal text-muted-foreground">· positions 4–20, ranked by estimated gain</span></h2>
<p class="mb-2 text-xs text-muted-foreground">Moving all of these to position 3 is worth roughly <b class="text-[color:var(--foreground)]">{fmtInt(gain)}</b> extra clicks per period (an estimate, not a forecast).</p>
<DataTable rows={data.striking} cols={sCols} sortKey="expectedGain" />

<h2 class="mb-1 mt-8 font-medium">Title/snippet candidates <span class="font-normal text-muted-foreground">· CTR well below your curve for the position</span></h2>
<DataTable rows={data.ctrGaps} cols={gCols} sortKey="missedClicks" empty="No pages are significantly under-performing their position." />

<h2 class="mb-1 mt-10 text-lg font-semibold">Hidden opportunities</h2>
<p class="mb-3 max-w-3xl text-xs text-muted-foreground">{HIDDEN_INTRO}</p>
<div class="mb-4 flex flex-wrap gap-2 text-xs">
	{#each [['previousPeriod', 'Previous period'], ['bing', 'Bing'], ['ga4', 'GA4'], ['clarity', 'Clarity']] as const as [k, label]}
		<span class="chip" title={h.sources[k] === 'ok' ? `${label}: in use` : HIDDEN_SOURCE_HINT[k]}>{label}: {h.sources[k] === 'ok' ? 'in use' : h.sources[k] === 'not-connected' ? 'not connected' : h.sources[k] === 'no-previous-period' ? 'history not downloaded' : 'no data'}</span>
	{/each}
</div>
{#each tables as t (t.id)}
	{@const missing = t.src && h.sources[t.src] !== 'ok'}
	<section class="mb-6">
		<h3 class="mb-0.5 font-medium">{t.title} <span class="chip ml-1">{t.rows.length}</span></h3>
		<p class="mb-2 max-w-3xl text-xs text-muted-foreground">{t.blurb}</p>
		{#if missing}
			<p class="rounded-md border border-dashed p-3 text-xs text-muted-foreground">{HIDDEN_SOURCE_HINT[t.src!]}</p>
		{:else}
			<DataTable rows={t.rows} cols={t.cols} sortKey={t.sort} empty="Nothing found for this period." />
		{/if}
	</section>
{/each}
