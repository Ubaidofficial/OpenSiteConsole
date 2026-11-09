<script lang="ts">
	import ActionCard from '$lib/components/ActionCard.svelte';
	import Explainer from '$lib/components/Explainer.svelte';
	import { TYPE_LABEL } from '$lib/explain';
	let { data } = $props();
	let type = $state('all');
	let only = $state<'all' | 'blocking' | 'quick'>('all');
	let showAll = $state(false);
	const types = $derived([...new Set(data.open.map((a) => a.type))]);
	const count = (f: (a: (typeof data.open)[number]) => boolean) => data.open.filter(f).length;
	const rows = $derived(data.open.filter((a) => (type === 'all' || a.type === type) && (only === 'all' || (only === 'blocking' ? a.blocking : a.effort === 'low' && !a.blocking))));
	const shown = $derived(showAll ? rows : rows.slice(0, 10));
	/** Rank of the first card in this list with the same instructions: later ones point to it instead of repeating it. */
	const sameAs = $derived.by(() => {
		const first = new Map<string, number>();
		return shown.map((a, i) => {
			const at = first.get(a.how);
			if (at == null) first.set(a.how, i + 1);
			return at ?? null;
		});
	});
	const blocking = $derived(count((a) => a.blocking));
	const quick = $derived(count((a) => a.effort === 'low' && !a.blocking));
</script>

<Explainer lead="Everything found for this site, in the order to do it: blocking items first, then by estimated gain.">
	<p><b>Blocking</b> items stop the site earning or stop you measuring it. The rest are ranked by estimated clicks per 28 days weighted by confidence. The estimates come from this site's own click-through curve and history; they are model figures, not promises, and are <b>not added up</b> because findings overlap (one page can be a CTR gap and a decay at once).</p>
</Explainer>

{#if data.fixFirst.rows.length}
	<section class="card mb-4 p-4" aria-labelledby="ff-h">
		<h2 id="ff-h" class="font-medium">Pages with several problems at once</h2>
		<p class="mt-1 max-w-3xl text-xs text-muted-foreground">One page in several findings is the best place to start: the traffic is there and something about it is wrong.</p>
		<details class="mt-1 max-w-3xl text-xs text-muted-foreground"><summary class="cursor-pointer select-none">How this is ordered</summary><p class="mt-1 leading-relaxed">By each page's single biggest estimate times its confidence. Estimates overlap, so they are never added; pages with no estimate follow, most sources first. A page is listed only when findings from at least two different sources count (Search Console, GA4, Clarity, Bing); findings of a page where Clarity saw many bots are shown but not counted. Model figures for the last 28 days, not promises.</p></details>
		<ol class="mt-3 space-y-3">
			{#each data.fixFirst.rows.slice(0, 8) as r, i (r.page)}
				<li class="rounded-lg border p-3">
					<div class="flex flex-wrap items-center gap-2 text-sm">
						<span class="tnum grid size-6 place-items-center rounded-full bg-muted text-xs font-semibold">{i + 1}</span>
						<span class="pii font-medium break-all">{r.page}</span>
						{#if r.score != null}<span class="chip font-medium" title="The page's largest single estimate times its confidence">≈ {Math.round(r.score).toLocaleString('en-US')} clicks / 28d</span>{:else}<span class="chip" title="None of its findings has a click estimate">no click estimate</span>{/if}
						<span class="chip" title="Sources behind the findings that count">{r.sources.length} {r.sources.length === 1 ? 'source' : 'sources'}: {r.sources.join(', ')}</span>
						{#if r.botHeavy}<span class="chip text-warn" title="A quarter or more of Clarity's sessions on this page were bots">bot-heavy</span>{/if}
						<span class="ml-auto text-xs text-muted-foreground tnum">{r.googleClicks.toLocaleString('en-US')} Google clicks</span>
					</div>
					<ul class="mt-2 space-y-1 text-sm">
						{#each r.signals as s}<li class={s.suspect ? 'opacity-60' : ''}>· {s.label}{#if s.suspect} <span class="chip">not counted: bot-heavy page</span>{/if}</li>{/each}
					</ul>
				</li>
			{/each}
		</ol>
	</section>
{/if}

{#if data.open.length === 0}
	<div class="card p-6 text-center text-sm"><p class="mb-1 font-medium text-good">Nothing to do right now.</p><p class="text-muted-foreground">Either the site is healthy, or there is not enough data yet. Connect GA4 and Tag Manager, read the sitemaps and run the on-page check to widen what is looked at.</p></div>
{:else}
	<div class="mb-3 flex flex-wrap items-center gap-1.5">
		<span class="mr-1 text-sm"><b>{data.open.length}</b> open{#if blocking} · <b class="text-bad">{blocking} blocking</b>{/if}</span>
		<button class="chip {only === 'blocking' ? 'chip-on' : ''}" onclick={() => (only = only === 'blocking' ? 'all' : 'blocking')} disabled={!blocking}>Blocking ({blocking})</button>
		<button class="chip {only === 'quick' ? 'chip-on' : ''}" onclick={() => (only = only === 'quick' ? 'all' : 'quick')} disabled={!quick} title="Low-effort items that are not blocking">Quick wins ({quick})</button>
		<span class="mx-1 text-muted-foreground">|</span>
		<button class="chip {type === 'all' ? 'chip-on' : ''}" onclick={() => (type = 'all')}>All kinds</button>
		{#each types as t}<button class="chip {type === t ? 'chip-on' : ''}" onclick={() => (type = t)}>{TYPE_LABEL[t]} ({count((a) => a.type === t)})</button>{/each}
	</div>
	{#if rows.length === 0}<div class="card p-6 text-center text-sm text-muted-foreground">Nothing matches these filters. <button class="underline" onclick={() => ((type = 'all'), (only = 'all'))}>Clear them</button></div>{/if}
	<div class="stagger space-y-3">
		{#each shown as a, i (a.key)}<ActionCard {a} rank={i + 1} sameAs={sameAs[i]} />{/each}
	</div>
	{#if rows.length > 10}<button class="btn mt-3" onclick={() => (showAll = !showAll)}>{showAll ? 'Show fewer' : `Show all ${rows.length}`}</button>{/if}
{/if}

{#if data.hidden.length}
	<details class="mt-6">
		<summary class="cursor-pointer text-sm font-medium">Done or snoozed ({data.hidden.length})</summary>
		<div class="mt-3 space-y-3">
			{#each data.hidden as a (a.key)}
				<div class="opacity-70"><p class="mb-1 text-xs text-muted-foreground">{a.status === 'done' ? 'Done' : 'Snoozed'}; returns {new Date(a.until).toLocaleDateString()} if still detected</p><ActionCard {a} rank={0} restore /></div>
			{/each}
		</div>
	</details>
{/if}
