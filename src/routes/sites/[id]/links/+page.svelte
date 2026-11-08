<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { toast } from 'svelte-sonner';
	import { Copy } from '@lucide/svelte';
	import { ago, fmtInt, shortUrl } from '$lib/format';
	let { data, form } = $props();

	const running = $derived(data.crawl?.status === 'running');
	$effect(() => {
		if (!running) return;
		const t = setInterval(() => invalidateAll(), 2500);
		return () => clearInterval(t);
	});
	const path = (u: string) => {
		try {
			const x = new URL(u);
			return (x.pathname || '/') + x.search;
		} catch {
			return u;
		}
	};
	const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast.success(`${what} copied`), () => toast.error('Could not copy'));
	/** The sentence split around the anchor, so the words to link stand out. */
	const parts = (snippet: string, anchor: string) => {
		const i = snippet.indexOf(anchor);
		return i < 0 ? [snippet, '', ''] : [snippet.slice(0, i), anchor, snippet.slice(i + anchor.length)];
	};
	const tiles = $derived([
		{ l: 'Pages crawled', v: data.summary.pagesCrawled, n: data.summary.pagesFailed ? `${fmtInt(data.summary.pagesFailed)} could not be read` : '' },
		{ l: 'Internal links found', v: data.summary.linksFound, n: 'same-site links on the crawled pages' },
		{ l: 'Suggestions', v: data.summary.suggestions, n: `for ${fmtInt(data.groups.length)} of ${fmtInt(data.summary.targets)} pages close to ranking better` },
		{ l: 'Pages nothing links to', v: data.summary.orphans, n: 'pages with impressions, no link in' }
	]);
</script>

<Explainer lead="Which of your pages should link to a page that is close to ranking better, and with which words.">
	<p>The crawl fetches up to {data.maxPages} pages that Search Console showed in the last 90 days (most impressions first), four at a time, from this site only, and reads the main text and the links of each. It runs weekly, or when you press Crawl now. Free, with no credits.</p>
	<p>Targets are pages with searches at positions 4 to 20, ordered by the extra clicks reaching position 3 would bring on this site's own click curve (the same estimate as Opportunities). For each, the crawled pages that mention one of its searches (whole words, any case; the exact phrase first, or all its main words close together) and do not link to it yet are listed, best first: the prize, how exact the mention is, and the linking page's own clicks and impressions.</p>
	<p>The anchor is the words exactly as the page writes them. A link helps Google find a page and understand it; it does not guarantee the prize. JavaScript is not run, so a page that builds its text in the browser reads as empty.</p>
</Explainer>

<section class="card mb-4 p-4">
	<div class="flex flex-wrap items-center gap-3">
		<h2 class="font-medium">Internal links</h2>
		<span class="text-xs text-muted-foreground">
			{#if running}Crawling up to {data.maxPages} pages…{:else if data.crawl?.finishedAt}Crawled {ago(data.crawl.finishedAt)}{:else}Not crawled yet{/if}
			{#if data.crawl?.error && !running} · {data.crawl.error}{/if}
		</span>
		<form method="POST" action="?/crawl" use:enhance class="ml-auto"><button class="btn btn-primary" disabled={running}>{running ? 'Crawling…' : 'Crawl now'}</button></form>
	</div>
	{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	{#if data.crawl?.finishedAt || data.summary.pagesCrawled}
		<div class="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
			{#each tiles as t}
				<div class="rounded-lg border px-3 py-2" style="border-color:var(--border)">
					<div class="text-xs text-muted-foreground">{t.l}</div>
					<div class="tnum text-xl font-semibold">{fmtInt(t.v)}</div>
					{#if t.n}<div class="text-[11px] text-muted-foreground">{t.n}</div>{/if}
				</div>
			{/each}
		</div>
	{/if}
</section>

{#if data.groups.length}
	<div class="stagger space-y-4">
		{#each data.groups as g (g.target)}
			<section class="card p-4">
				<div class="flex flex-wrap items-center gap-2">
					<h3 class="pii min-w-0 truncate text-sm font-medium" title={g.target}>Link to <a class="hover:underline" href={g.target} target="_blank" rel="noreferrer noopener">{path(g.target)}</a></h3>
					<span class="chip" title="Estimated extra clicks per {data.days} days if this page reached position 3 for its best search. A link alone will not do that.">≈ {fmtInt(Math.round(g.prize))} clicks at stake</span>
					<span class="chip">{g.rows.length} page{g.rows.length === 1 ? '' : 's'} to link from</span>
				</div>
				<div class="mt-3 overflow-x-auto">
					<table class="w-full text-sm">
						<thead><tr><th class="th">From page</th><th class="th">Anchor text, in its sentence</th><th class="th">Search</th><th class="th relative"><span class="sr-only">Actions</span></th></tr></thead>
						<tbody>
							{#each g.rows as s (s.key)}
								{@const [before, hit, after] = parts(s.snippet, s.anchor)}
								<tr>
									<td class="td pii max-w-56 align-top">
										<div class="flex items-center gap-1"><a class="truncate hover:underline" href={s.source} target="_blank" rel="noreferrer noopener" title={s.source}>{path(s.source)}</a><button class="shrink-0 text-muted-foreground hover:text-foreground" title="Copy the page URL" aria-label="Copy the page URL" onclick={() => copy(s.source, 'URL')}><Copy class="size-3.5" /></button></div>
										<div class="text-[11px] text-muted-foreground">{fmtInt(s.sourceClicks)} clicks · {fmtInt(s.sourceImpressions)} impr.</div>
									</td>
									<td class="td pii align-top text-xs leading-relaxed">
										<div class="mb-1 flex flex-wrap items-center gap-1.5"><span class="rounded bg-muted px-1.5 py-0.5 font-medium text-foreground">{s.anchor}</span><button class="btn !h-6 !px-2 text-[11px]" onclick={() => copy(s.anchor, 'Anchor text')}><Copy class="size-3" />Copy</button>{#if s.match === 'words'}<span class="text-muted-foreground" title="All the main words of the search, close together but not as one phrase">words, not the exact phrase</span>{/if}</div>
										<span class="text-muted-foreground">{before}<b class="text-foreground underline decoration-[color:var(--link)] decoration-2 underline-offset-2">{hit}</b>{after}</span>
									</td>
									<td class="td pii align-top text-xs">{s.query}<div class="text-[11px] text-muted-foreground">position {s.position.toFixed(1)} · ≈ {fmtInt(Math.round(s.prize))} clicks</div></td>
									<td class="td align-top text-right">
										<form method="POST" action="?/done" use:enhance><input type="hidden" name="key" value={s.key} /><button class="btn !h-7 !px-2.5 text-xs" title="Hide it: the link is in place (the next crawl will see it too)">Done</button></form>
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/each}
	</div>
{:else if data.summary.pagesCrawled}
	<div class="card p-6 text-center text-sm text-muted-foreground">No suggestions: none of the crawled pages mentions the searches of pages at positions 4 to 20 without already linking to them.</div>
{:else if !running}
	<div class="card p-6 text-center text-sm text-muted-foreground">Nothing crawled yet. Press “Crawl now” to read up to {data.maxPages} of your pages.</div>
{/if}

{#if data.done.length}
	<details class="card mt-4 p-4 text-sm">
		<summary class="cursor-pointer select-none font-medium">Marked done ({data.done.length})</summary>
		<p class="mt-1 text-xs text-muted-foreground">The next crawl drops a suggestion for good once it sees the link.</p>
		<ul class="mt-2 space-y-1">
			{#each data.done as s (s.key)}
				<li class="flex flex-wrap items-center gap-2 text-xs"><span class="pii min-w-0 flex-1 truncate">{path(s.source)} → {path(s.target)}: “{s.anchor}”</span><form method="POST" action="?/done" use:enhance><input type="hidden" name="key" value={s.key} /><input type="hidden" name="undo" value="1" /><button class="btn !h-6 !px-2 text-[11px]">Undo</button></form></li>
			{/each}
		</ul>
	</details>
{/if}

{#if data.orphans.length}
	<section class="card mt-4 p-4">
		<h2 class="font-medium">Pages nothing links to</h2>
		<p class="mt-1 text-xs text-muted-foreground">They earn impressions, but none of the {fmtInt(data.summary.pagesCrawled)} crawled pages links to them. Link to them from a related page, or check they are meant to exist.</p>
		<div class="mt-3 overflow-x-auto">
			<table class="w-full text-sm">
				<thead><tr><th class="th">Page</th><th class="th text-right">Impressions</th><th class="th text-right">Clicks</th><th class="th">Crawled</th></tr></thead>
				<tbody>
					{#each data.orphans as o (o.page)}
						<tr><td class="td pii max-w-96 truncate" title={o.page}>{shortUrl(o.page)}</td><td class="td tnum text-right">{fmtInt(o.impressions)}</td><td class="td tnum text-right">{fmtInt(o.clicks)}</td><td class="td text-xs text-muted-foreground">{o.crawled ? 'yes' : 'no'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
		{#if data.summary.orphans > data.orphans.length}<p class="mt-2 text-xs text-muted-foreground">The {data.orphans.length} with the most impressions of {fmtInt(data.summary.orphans)}.</p>{/if}
	</section>
{/if}

{#if form?.ok && !form?.error}<span class="sr-only" role="status">{form.ok}</span>{/if}
