<script lang="ts">
	import SegBar from '$lib/components/viz/SegBar.svelte';
	import BarList from '$lib/components/viz/BarList.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import DataTable from '$lib/components/DataTable.svelte';
	import { ago } from '$lib/format';
	import LineChart from '$lib/components/LineChart.svelte';
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
	<Explainer lead="Re-checks your biggest pages with Google and records what changed: de-indexed, newly indexed, blocked.">
	<p>Re-inspects this site's biggest pages (plus pages that lost their visibility) with Google's URL Inspection and records what changed: de-indexed, newly indexed, canonical swapped, blocked by robots.txt, page fetch errors.
		Each run checks up to {data.perRun} URLs, the least recently checked first, so coverage rotates through the site. URL Inspection has a daily quota (set <code>INDEX_MONITOR_URLS</code> to change the number; I am not certain of Google's current limit), which is why daily monitoring is opt-in per site.</p>
</Explainer>
	{#if data.message}<p class="mt-2 rounded-md border border-[color:var(--warn)] p-2 text-xs text-warn">{data.message}{#if data.nextAt && data.nextAt > Date.now()} Next attempt {new Date(data.nextAt).toLocaleTimeString()}.{/if}</p>{/if}
	{#if form?.ok}<p class="mt-2 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	{#if data.summary.checked}
	<!-- not indexed is grey, not red, as in Search Console: some exclusions are deliberate (noindex, a chosen canonical) -->
	<div class="mt-3 max-w-2xl"><SegBar title="Inspected pages by index status" format={(v) => `${v} pages`} parts={[
		{ label: 'Indexed', value: data.summary.counts.indexed, color: 'var(--st-good)' },
		{ label: 'Not indexed', value: data.summary.counts.not_indexed, color: 'var(--muted-foreground)' },
		{ label: 'Unknown', value: data.summary.counts.unknown, color: 'var(--border)', ink: 'var(--foreground)' }
	]} /></div>
	{/if}
	<div class="mt-3 flex flex-wrap gap-3 text-sm">
			<span><b>{data.summary.counts.indexed}</b> indexed</span><span class={data.summary.counts.not_indexed ? 'text-bad' : ''}><b>{data.summary.counts.not_indexed}</b> not indexed</span><span class="text-muted-foreground"><b>{data.summary.counts.unknown}</b> unknown</span><span class="text-muted-foreground">of {data.summary.checked} inspected</span>{#if data.summary.indexedShare != null}<span class="ml-auto"><b>{(data.summary.indexedShare * 100).toFixed(0)}%</b> of inspected URLs are indexed</span>{/if}
	</div>
	<p class="mt-2 text-[11px] text-muted-foreground">Order of checking: your watch list, then pages that appeared for the first time this period (indexing still open), then pages that lost visibility, then the biggest pages. The inspected set is a rotating sample, not the whole site.</p>
</section>

<div class="mb-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
	<section class="card p-4">
		<h2 class="mb-1 font-medium">Why pages are not indexed</h2>
		{#if data.summary.reasons.length}
			<div class="mt-2"><BarList items={data.summary.reasons.map((r) => ({ label: r.reason, value: r.count }))} color="var(--muted-foreground)" unit="pages" /></div>
			<p class="mt-2 text-[11px] text-muted-foreground">Google's own wording. “Crawled, currently not indexed” usually means quality or duplication; “Discovered, currently not indexed” usually means crawl budget or weak internal links; a “duplicate / canonical” reason means another URL was chosen instead.</p>
		{:else}<p class="text-sm text-muted-foreground">No non-indexed URLs among those inspected.</p>{/if}
		{#if data.history.length > 1}
			<div class="mt-3"><LineChart xs={data.history.map((h) => h.day)} height={110} zero={false} format={(v) => v.toFixed(0) + '%'} series={[{ label: 'Indexed share of inspected URLs', color: 'var(--c-clicks)', values: data.history.map((h) => (h.indexed + h.notIndexed ? (h.indexed / (h.indexed + h.notIndexed)) * 100 : null)) }]} /></div>
		{/if}
	</section>
	<section class="card p-4">
		<h2 class="mb-1 font-medium">Watch list</h2>
		<p class="mb-2 text-xs text-muted-foreground">Money pages, key templates, a page you just changed: they are always checked first, even if they get few clicks.</p>
		<form method="POST" action="?/watchAdd" use:enhance class="mb-2 flex gap-2"><textarea class="input h-9 min-w-0 flex-1 !py-1.5" name="urls" aria-label="Full URLs" placeholder="Full URLs, one per line"></textarea><button class="btn">Add</button></form>
		<ul class="space-y-1 text-xs">{#each data.watch as u}<li class="flex items-center gap-2"><span class="pii min-w-0 flex-1 truncate">{u.replace(/^https?:\/\/(www\.)?/, '')}</span><form method="POST" action="?/watchRemove" use:enhance><input type="hidden" name="url" value={u} /><button class="text-muted-foreground hover:text-[color:var(--bad)]" aria-label="Remove">✕</button></form></li>{:else}<li class="text-muted-foreground">Nothing pinned yet.</li>{/each}</ul>
	</section>
</div>

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

<section class="mb-5">
	<div class="mb-1 flex flex-wrap items-center gap-3">
		<h2 class="font-medium">Sitemap coverage</h2>
		<span class="text-xs text-muted-foreground">{data.coverage.fetchedAt ? 'sitemaps read ' + ago(data.coverage.fetchedAt) : 'not read yet'}</span>
		<form method="POST" action="?/sitemapRefresh" use:enhance class="ml-auto"><button class="btn">Read sitemaps now</button></form>
	</div>
	<Explainer lead="Sitemap URLs that never got an impression are where indexing problems hide.">
	<p>Compares the URLs in your submitted sitemaps with the pages Search Console has shown in the last {data.coverage.window.days} days. A sitemap URL that never got a single impression is where indexing problems hide: Google may not have indexed it, or indexed it and found it useless. The first group is checked first by the indexing monitor.</p>
</Explainer>
	{#if data.coverage.error}<p class="mb-2 text-xs text-warn">{data.coverage.error}</p>{/if}
	{#if !data.coverage.synced}
		<div class="card p-4 text-sm text-muted-foreground">No sitemap has been read yet. Submit one in Search Console (see the Sitemaps tab) and click “Read sitemaps now”.</div>
	{:else}
		{#if !data.coverage.window.complete}<p class="mb-2 text-xs text-warn">Search Console history for this window is still downloading, so “never shown” may overstate.</p>{/if}
		<div class="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">URLs in sitemaps</div><div class="tnum text-xl font-semibold">{data.coverage.totalUrls.toLocaleString('en-US')}</div>{#if data.coverage.truncated}<div class="text-[11px] text-warn">cut off at the limit</div>{/if}</div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Shown in Search</div><div class="tnum text-xl font-semibold text-good">{data.coverage.shown.toLocaleString('en-US')}</div><div class="text-[11px] text-muted-foreground">{data.coverage.totalUrls ? Math.round((data.coverage.shown / data.coverage.totalUrls) * 100) : 0}% of the sitemap</div></div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Never shown</div><div class="tnum text-xl font-semibold {data.coverage.neverShown.count ? 'text-bad' : ''}">{data.coverage.neverShown.count.toLocaleString('en-US')}</div>{#if data.coverage.neverShown.tooNew}<div class="text-[11px] text-muted-foreground">+{data.coverage.neverShown.tooNew} too new to judge</div>{/if}</div>
			<div class="card px-3 py-2"><div class="text-xs text-muted-foreground">Earn clicks, not in sitemap</div><div class="tnum text-xl font-semibold {data.coverage.notInSitemap.count ? 'text-warn' : ''}">{data.coverage.notInSitemap.count.toLocaleString('en-US')}</div><div class="text-[11px] text-muted-foreground">{data.coverage.notInSitemap.clicks.toLocaleString('en-US')} clicks</div></div>
		</div>
		<div class="grid grid-cols-1 gap-4 2xl:grid-cols-2">
			<div><h3 class="mb-1 text-sm font-medium">Never shown (newest first)</h3><DataTable rows={data.coverage.neverShown.sample} cols={[{ key: 'url', label: 'URL', type: 'link' }, { key: 'lastmod', label: 'Sitemap date', type: 'text' }, { key: 'index', label: 'Indexed?', type: 'text' }]} sortKey="lastmod" filterable={false} pageSize={10} empty="Every sitemap URL has been shown at least once." /></div>
			<div><h3 class="mb-1 text-sm font-medium">Earning clicks but missing from every sitemap</h3><DataTable rows={data.coverage.notInSitemap.sample} cols={[{ key: 'url', label: 'URL', type: 'link' }, { key: 'clicks', label: 'Clicks', type: 'int' }, { key: 'impressions', label: 'Impressions', type: 'int' }]} sortKey="clicks" filterable={false} pageSize={10} empty="Every page that earns clicks is in a sitemap." /></div>
		</div>
		<p class="mt-2 text-[11px] text-muted-foreground">URLs are compared without scheme, www, query string or trailing slash. A page missing from the sitemap may be a parameter or canonical variant rather than a real omission.</p>
	{/if}
</section>

<section>
	<h2 class="mb-1 font-medium">Weak and dead URLs</h2>
	<p class="mb-2 max-w-3xl text-xs text-muted-foreground">Every page Search Console has shown, classed by how it is doing against the previous {data.days} days (cut-offs are my own, chosen to be conservative). A page that never got an impression is invisible to Search Console; compare with your sitemap to find those.</p>
	{#if !data.classes.comparable}<p class="mb-2 text-xs text-warn">“Dead” and “fading” are not judged yet: {data.classes.reason}</p>{/if}
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
