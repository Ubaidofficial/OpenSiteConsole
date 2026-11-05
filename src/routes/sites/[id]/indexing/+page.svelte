<script lang="ts">
	import { enhance } from '$app/forms';
	import DataTable from '$lib/components/DataTable.svelte';
	import { ago } from '$lib/format';
	let { data, form } = $props();
	let cls = $state('all');
	const labels: Record<string, string> = { dead: 'Dead', 'not-indexed': 'Not indexed', fading: 'Fading', underperforming: 'Underperforming', weak: 'Weak' };
	const help: Record<string, string> = {
		dead: 'Had 50+ impressions before and none now, or Google got a 404 fetching it. A dead page that is also not indexed is counted here only',
		'not-indexed': 'Inspected and not on Google',
		fading: 'Lost at least half its clicks (from 20+)',
		underperforming: 'In the top 20 with 200+ impressions but CTR under half of what that position normally earns here',
		weak: '100+ impressions, no clicks, average position beyond 20'
	};
	const tone = { bad: 'text-bad', warn: 'text-warn', good: 'text-good' } as const;
	const eventText: Record<string, string> = { deindexed: 'No longer indexed', indexed: 'Now indexed', canonical_changed: 'Canonical changed', blocked: 'Blocked by robots.txt', unblocked: 'Unblocked', fetch_error: 'Page fetch problem' };
	const idx: Record<string, string> = { indexed: 'yes', not_indexed: 'no', unknown: 'unknown', 'not checked': 'not checked' };
	const rows = $derived(data.classes.rows.filter((r) => cls === 'all' || r.cls === cls).map((r) => ({ ...r, label: labels[r.cls], index: idx[r.index] ?? r.index })));
</script>

<section class="card mb-4 p-4">
	<div class="flex flex-wrap items-center gap-3">
		<h2 class="font-medium">Indexing monitor</h2>
		<span class="chip {data.monitoring ? 'chip-on' : ''}">{data.monitoring ? 'on' : 'off'}</span>
		<span class="text-xs text-muted-foreground">{data.summary.lastCheck ? 'last check ' + ago(data.summary.lastCheck) : 'never run'}</span>
		<div class="ml-auto flex gap-2">
			<form method="POST" action="?/check" use:enhance><button class="btn">Check now</button></form>
			<form method="POST" action="?/toggle" use:enhance><input type="hidden" name="on" value={data.monitoring ? '0' : '1'} /><button class="btn {data.monitoring ? '' : 'btn-primary'}">{data.monitoring ? 'Switch off' : 'Monitor daily'}</button></form>
		</div>
	</div>
	<p class="mt-2 max-w-3xl text-xs text-muted-foreground">
		Re-inspects this site's biggest pages (plus pages that lost their visibility) with Google's URL Inspection and records what changed: de-indexed, newly indexed, canonical swapped, blocked by robots.txt, page fetch errors.
		Each run checks up to {data.perRun} URLs, the least recently checked first, so coverage rotates through the site. URL Inspection has a daily quota (set <code>INDEX_MONITOR_URLS</code> to change the number; I am not certain of Google's current limit), which is why daily monitoring is opt-in per site.
	</p>
	{#if form?.ok}<p class="mt-2 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	<div class="mt-3 flex flex-wrap gap-3 text-sm">
		<span><b>{data.summary.counts.indexed}</b> indexed</span><span class={data.summary.counts.not_indexed ? 'text-bad' : ''}><b>{data.summary.counts.not_indexed}</b> not indexed</span><span class="text-muted-foreground"><b>{data.summary.counts.unknown}</b> unknown</span><span class="text-muted-foreground">of {data.summary.checked} inspected</span>
	</div>
</section>

<section class="mb-5">
	<h2 class="mb-1 font-medium">What changed</h2>
	{#if data.events.length}
		<div class="card overflow-x-auto"><table class="w-full"><thead><tr><th class="th">When</th><th class="th">Change</th><th class="th">URL</th><th class="th">Detail</th></tr></thead><tbody>
			{#each data.events as e}
				<tr><td class="td whitespace-nowrap text-xs text-muted-foreground">{ago(e.at)}</td><td class="td whitespace-nowrap text-xs font-medium {tone[e.severity]}">{eventText[e.kind] ?? e.kind}</td>
					<td class="td pii max-w-[26rem] truncate text-xs"><a class="text-link hover:underline" href={e.url} target="_blank" rel="noreferrer noopener">{e.url.replace(/^https?:\/\/(www\.)?/, '')}</a></td><td class="td pii max-w-[22rem] truncate text-xs text-muted-foreground">{e.detail ?? ''}</td></tr>
			{/each}
		</tbody></table></div>
	{:else}
		<div class="card p-4 text-sm text-muted-foreground">No changes recorded yet. The first check only records a starting point; changes show up from the second check on.</div>
	{/if}
</section>

<section>
	<h2 class="mb-1 font-medium">Weak and dead URLs</h2>
	<p class="mb-2 max-w-3xl text-xs text-muted-foreground">Every page Search Console has shown, classed by how it is doing against the previous {data.days} days (cut-offs are my own, chosen to be conservative). A page that never got an impression is invisible to Search Console; compare with your sitemap to find those.</p>
	<div class="mb-3 flex flex-wrap gap-1.5">
		<button class="chip {cls === 'all' ? 'chip-on' : ''}" onclick={() => (cls = 'all')}>All problems {Object.entries(data.classes.counts).filter(([k]) => k !== 'healthy').reduce((a, [, n]) => a + n, 0)}</button>
		{#each Object.keys(labels) as k}
			{@const n = data.classes.counts[k as keyof typeof data.classes.counts]}
			<button class="chip {cls === k ? 'chip-on' : ''}" onclick={() => (cls = k)} title={help[k]}>{labels[k]} {n}{#if data.classes.lost[k]} <span class="text-bad">(−{data.classes.lost[k].toLocaleString('en-US')} clicks)</span>{/if}</button>
		{/each}
		<span class="chip text-muted-foreground">Healthy {data.classes.counts.healthy}</span>
	</div>
	{#if cls !== 'all'}<p class="mb-2 text-xs text-muted-foreground">{help[cls]}.</p>{/if}
	<DataTable {rows} cols={[{ key: 'page', label: 'Page', type: 'link' }, { key: 'label', label: 'Class', type: 'text' }, { key: 'clicks', label: 'Clicks', type: 'int' }, { key: 'prevClicks', label: 'Before', type: 'int' }, { key: 'impressions', label: 'Impressions', type: 'int' }, { key: 'position', label: 'Position', type: 'pos' }, { key: 'index', label: 'Indexed?', type: 'text' }]} sortKey="prevClicks" empty="No problem pages in this period." />
</section>
