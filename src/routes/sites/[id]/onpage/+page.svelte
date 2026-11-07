<script lang="ts">
	import Explainer from '$lib/components/Explainer.svelte';
	import { enhance } from '$app/forms';
	import { ago } from '$lib/format';
	import { isBranded } from '$lib/analytics';
	let { data, form } = $props();
	let busy = $state<string | null>(null);
	const submit = (n: string) => () => {
		busy = n;
		return async ({ update }: { update: () => Promise<void> }) => {
			await update();
			busy = null;
		};
	};
	const sevTone = { bad: 'text-bad', warn: 'text-warn', info: 'text-muted-foreground' } as const;
	const m: Record<string, [string, string]> = { exact: ['exact', 'text-good'], 'all-words': ['all words', 'text-good'], 'some-words': ['some words', 'text-warn'], none: ['missing', 'text-bad'] };
</script>

<section class="card mb-4 p-4">
	<h2 class="mb-1 font-medium">On-page check</h2>
	<Explainer lead="Checks a page's title, description and H1 against the queries it earns clicks for.">
	<p>Fetches a page from this site and checks its title, meta description and H1 against the queries it already earns clicks for: does the page say what people search for? Also flags a missing or very long title, no description, no or several H1s, noindex and a canonical pointing elsewhere.
		Only this site's own pages are fetched, JavaScript is not run (a title or H1 added by script reads as missing), and the 60 / 155-character lengths are folk rules, since Google truncates by pixel width.</p>
</Explainer>
	<div class="flex flex-wrap items-start gap-3">
		<form method="POST" action="?/top" use:enhance={submit('top')}><button class="btn btn-primary" disabled={busy !== null}>{busy === 'top' ? 'Checking…' : 'Check top 15 pages'}</button></form>
		<form method="POST" action="?/urls" use:enhance={submit('urls')} class="flex min-w-64 flex-1 gap-2"><textarea class="input h-9 min-w-0 flex-1 !py-1.5" name="urls" placeholder="…or paste full URLs, one per line (up to 25)"></textarea><button class="btn" disabled={busy !== null}>{busy === 'urls' ? 'Checking…' : 'Check'}</button></form>
	</div>
	{#if form?.ok}<p class="mt-2 text-sm text-good">{form.ok}</p>{/if}{#if form?.error}<p class="mt-2 text-sm text-bad">{form.error}</p>{/if}
	{#if data.rows.length}<p class="mt-2 text-xs text-muted-foreground">{data.rows.length} page(s) checked{data.avgScore != null ? ` · average score ${data.avgScore}/100 (a relative aid, not a Google measure)` : ''}{data.failed ? ` · ${data.failed} could not be fetched` : ''}</p>{/if}
</section>

{#each [...data.rows].sort((a, b) => (a.score ?? 101) - (b.score ?? 101)) as r (r.url)}
	<details class="card mb-2">
		<summary class="flex cursor-pointer flex-wrap items-center gap-3 p-3">
			<span class="tnum w-12 text-right text-lg font-semibold {r.score == null ? 'text-muted-foreground' : r.score >= 85 ? 'text-good' : r.score >= 60 ? 'text-warn' : 'text-bad'}">{r.score ?? '–'}</span>
			<span class="pii min-w-0 flex-1 truncate text-sm" title={r.url}>{r.url.replace(/^https?:\/\/(www\.)?/, '')}</span>
			{#if r.error}<span class="text-xs text-bad">{r.error}</span>{:else}<span class="text-xs text-muted-foreground">{(r.issues ?? []).length ? (r.issues ?? []).length + ' issue(s)' : 'no issues'}</span>{/if}
			<span class="text-[11px] text-muted-foreground">{ago(r.checkedAt)}</span>
		</summary>
		{#if r.parsed}
			<div class="border-t p-3 text-sm" style="border-color:var(--border)">
				<dl class="mb-3 grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs">
					<dt class="text-muted-foreground">Title</dt><dd class="pii">{r.parsed.title ?? '—'} <span class="text-muted-foreground">({r.parsed.title?.length ?? 0})</span></dd>
					<dt class="text-muted-foreground">Description</dt><dd class="pii">{r.parsed.description ?? '—'} <span class="text-muted-foreground">({r.parsed.description?.length ?? 0})</span></dd>
					<dt class="text-muted-foreground">H1</dt><dd class="pii">{r.parsed.h1.length ? r.parsed.h1.join(' | ') : '—'}</dd>
					{#if r.finalUrl !== r.url}<dt class="text-muted-foreground">Redirected to</dt><dd class="pii">{r.finalUrl}</dd>{/if}
				</dl>
				{#if (r.issues ?? []).length}<ul class="mb-3 space-y-1 text-xs">{#each r.issues ?? [] as i}<li class={sevTone[i.severity]}>{i.severity === 'bad' ? '✕' : i.severity === 'warn' ? '⚠' : 'ℹ'} {i.message}</li>{/each}</ul>{/if}
				{#if (r.queries ?? []).length}
					<table class="w-full text-xs"><thead><tr><th class="th">Query this page earns clicks for</th><th class="th text-right">Clicks</th><th class="th">In title</th><th class="th">In description</th><th class="th">In H1</th></tr></thead><tbody>
						{#each r.queries ?? [] as q}<tr><td class="td" class:pii={isBranded(q.query, data.brandTerms)}>{q.query}</td><td class="td tnum text-right">{q.clicks}</td>{#each [q.title, q.description, q.h1] as x}<td class="td {m[x][1]}">{m[x][0]}</td>{/each}</tr>{/each}
					</tbody></table>
				{:else}<p class="text-xs text-muted-foreground">No stored queries for this exact URL yet.</p>{/if}
			</div>
		{/if}
	</details>
{:else}
	<div class="card p-6 text-center text-sm text-muted-foreground">Nothing checked yet. Start with “Check top 15 pages”.</div>
{/each}
