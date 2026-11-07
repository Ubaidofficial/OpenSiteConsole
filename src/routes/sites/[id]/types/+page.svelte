<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import AreaSpark from '$lib/components/AreaSpark.svelte';
	import Delta from '$lib/components/Delta.svelte';
	import { trendOf } from '$lib/trend';
	import { fmtInt, fmtPct, fmtPos } from '$lib/format';
	import { TYPE_HINT, TYPE_LABEL, appearanceLabel } from '$lib/searchTypes';

	let { data } = $props();
	const active = $derived(data.types.filter((t) => t.has));
	const empty = $derived(data.types.filter((t) => !t.has));
</script>

<Explainer lead="Google reports each kind of search separately; the numbers are not added up.">
	<p>Google reports each kind of search separately. The Clicks, Impressions, CTR and Position cards on Overview are <b>Web</b> only, which is also what Search Console shows by default; the other types add to your reach but are not in those totals.</p>
</Explainer>

{#if !data.typesPulled}
	<div class="card p-6 text-sm text-muted-foreground">Search types are fetched on the next sync of this site. Press <b>Sync</b> (top right).</div>
{:else}
	<div class="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
		{#each active as t (t.type)}
			<div class="rounded-2xl border bg-card p-5 shadow-xs">
				<div class="flex items-start justify-between gap-3">
					<div>
						<div class="text-lg font-semibold tracking-tight">{TYPE_LABEL[t.type]}</div>
						<div class="text-xs text-muted-foreground">{TYPE_HINT[t.type]}</div>
					</div>
					<div class="flex flex-col items-end gap-1">
						<span class="tnum rounded-full bg-muted px-3 py-1 text-sm font-medium">{fmtInt(t.clicks)} clicks</span>
						<Delta value={t.clicksDelta} why="Needs 10+ clicks in the previous period" />
					</div>
				</div>
				<AreaSpark values={t.spark} trend={trendOf(t.clicksDelta, t.spark)} class="mt-4" />
				<div class="tnum mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
					<span>Impr. <b class="font-medium text-foreground">{fmtInt(t.impressions)}</b></span>
					<span>CTR <b class="font-medium text-foreground">{fmtPct(t.ctr)}</b></span>
					<span>Pos. <b class="font-medium text-foreground">{fmtPos(t.position)}</b></span>
				</div>
				<div class="mt-3">
					<div class="h-1.5 overflow-hidden rounded-full bg-muted"><div class="h-full rounded-full bg-foreground/70" style="width:{Math.max(1, t.share * 100)}%"></div></div>
					<div class="mt-1 text-[11px] text-muted-foreground">{fmtPct(t.share, 0)} of all clicks across search types</div>
				</div>
			</div>
		{/each}
	</div>
	{#if empty.length}
		<p class="mt-4 text-sm text-muted-foreground">
			No traffic in this period from: {empty.map((t) => TYPE_LABEL[t.type]).join(', ')}.
			If you expect Discover, News or Image traffic and it is missing here, check that this property receives it in Search Console itself.
		</p>
	{/if}

	<h2 class="mt-8 mb-1 text-base font-semibold">Search appearance</h2>
	<p class="mb-3 text-sm text-muted-foreground">
		How results were shown (rich results, snippets and similar), for the {data.appearance.pulledOn ? `${data.days} days ending ${data.appearance.pulledOn}` : 'selected period'}. Google reports this on its own: it cannot be split by query, page or country.
	</p>
	{#if data.appearance.rows.length}
		<div class="card overflow-x-auto">
			<table class="w-full text-sm">
				<thead><tr><th class="th">Appearance</th><th class="th text-right">Clicks</th><th class="th text-right">Impressions</th><th class="th text-right">CTR</th><th class="th text-right">Position</th></tr></thead>
				<tbody>
					{#each data.appearance.rows as r (r.appearance)}
						<tr>
							<td class="td" title={r.appearance}>{appearanceLabel(r.appearance)}</td>
							<td class="td tnum text-right">{fmtInt(r.clicks)}</td>
							<td class="td tnum text-right">{fmtInt(r.impressions)}</td>
							<td class="td tnum text-right">{fmtPct(r.impressions ? r.clicks / r.impressions : 0)}</td>
							<td class="td tnum text-right">{fmtPos(r.position)}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="card p-5 text-sm text-muted-foreground">No search-appearance data for this window. Google only lists appearances where your pages were shown with a special treatment.</div>
	{/if}
{/if}
